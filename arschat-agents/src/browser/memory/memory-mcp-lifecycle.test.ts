/** @jest-environment jsdom */
import 'reflect-metadata';
jest.mock('@theia/core/lib/browser', () => ({}));
jest.mock('@theia/workspace/lib/browser/workspace-trust-service', () => ({ WorkspaceTrustService: Symbol('WorkspaceTrustService') }));
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: Symbol('WorkspaceService') }));
// Keep Theia's real registration, diff, status and start/stop logic; replace only
// SDK connections so the tests cannot spawn processes or access a personal DB.
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class { constructor(readonly options: { command: string }) {} }
}));
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class {} }));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Emitter } from '@theia/core';
import { MCPServerManagerImpl } from '@theia/ai-mcp/lib/node/mcp-server-manager-impl';
import { MCPFrontendServiceImpl } from '@theia/ai-mcp/lib/browser/mcp-frontend-service';
import { ArschatMemoryMcpContribution } from './memory-mcp-contribution';
import { ArschatMemoryServerContribution } from './memory-server-contribution';
import { ArschatMemoryEnvironment } from './memory-environment';
import { MCP_SERVERS_PREF, MEMORY_SERVER, MemoryServers } from './memory-preferences';

const flush = async () => { for (let i = 0; i < 150; i++) { await Promise.resolve(); } };
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(enabled = true) {
    const values: Record<string, unknown> = {
        'arschat.memory.enabled': enabled,
        [MCP_SERVERS_PREF]: { everything: { command: 'everything', autostart: true } }
    };
    const changes = new Emitter<{ preferenceName: string }>();
    const trustChanges = new Emitter<boolean>();
    const workspaceChanges = new Emitter<void>();
    const notifications = new Emitter<void>();
    const preferences = {
        ready: Promise.resolve(), get: (key: string, fallback: unknown) => values[key] ?? fallback,
        onPreferenceChanged: jest.fn(changes.event),
        set: jest.fn(async (key: string, value: unknown) => { values[key] = value; changes.fire({ preferenceName: key }); })
    };
    const environment = new ArschatMemoryEnvironment();
    const backend = { getVariables: jest.fn(async () => []), getConfigDirUri: async () => 'file:///isolated-config' };
    Object.assign(environment, { env: backend });
    const manager = new MCPServerManagerImpl();
    const registration = jest.spyOn(manager, 'addOrUpdateServer');
    const frontend = new MCPFrontendServiceImpl();
    Object.assign(frontend, { mcpServerManager: manager,
        toolInvocationRegistry: { registerTool: jest.fn(), unregisterAllTools: jest.fn() },
        promptService: { addBuiltInPromptFragment: jest.fn(), removePromptFragment: jest.fn() }
    });
    const trust = { getWorkspaceTrust: async () => true, refreshRestrictedModeIndicator: jest.fn(),
        onDidChangeWorkspaceTrust: jest.fn(trustChanges.event) };
    const memory = { setUnavailable: jest.fn() };
    const messages = { warn: jest.fn() };
    const memoryServer = new ArschatMemoryServerContribution();
    Object.assign(memoryServer, { preferences, environment, mcp: frontend, memory, messages, trust,
        notifications: { onDidUpdateMCPServers: notifications.event } });
    const contribution = new ArschatMemoryMcpContribution();
    Object.assign(contribution, { environment, memoryServer, manager, frontendMCPService: frontend,
        preferenceService: preferences, workspaceTrustService: trust,
        workspaceService: { tryGetRoots: () => [], onWorkspaceChanged: workspaceChanges.event }
    });
    const connections: { command: string; close: jest.Mock }[] = [];
    const everything = deferred();
    (Client as unknown as jest.Mock).mockImplementation(() => {
        const close = jest.fn(async () => {});
        return {
            connect: jest.fn(async (transport: { options: { command: string } }) => {
                connections.push({ command: transport.options.command, close });
                if (transport.options.command === 'everything') { await everything.promise; }
            }),
            close, listTools: async () => ({ tools: [] }), setRequestHandler: jest.fn(), sendRootsListChanged: jest.fn()
        };
    });
    return { contribution, memoryServer, preferences, environment, backend, manager, registration, trust, memory, messages,
        connections, everything, trustChanges, workspaceChanges,
        set: preferences.set,
        servers: () => values[MCP_SERVERS_PREF] as MemoryServers,
        stop: async () => {
            contribution.onStop();
            everything.resolve();
            await flush();
            for (const name of await manager.getServerNames()) { await manager.stopServer(name); }
            changes.dispose(); trustChanges.dispose(); workspaceChanges.dispose(); notifications.dispose();
        }
    };
}

describe('memory and Theia MCP lifecycle synchronization', () => {
    beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { jest.restoreAllMocks(); });

    it('persists sqgraph before the parent reads its initial snapshot', async () => {
        const f = fixture();
        const write = deferred();
        f.preferences.set.mockImplementationOnce(async (key, value) => {
            await write.promise;
            await f.set(key, value);
        });
        try {
            f.contribution.onStart();
            await flush();
            expect(f.registration).not.toHaveBeenCalled();
            write.resolve();
            await flush();
            expect(f.registration.mock.calls.map(([description]) => description.name)).toEqual(['everything', MEMORY_SERVER]);
            expect(f.servers()[MEMORY_SERVER]).toMatchObject({ command: 'sqgraph-memory', autostart: true });
            f.everything.resolve();
            await flush();
            expect(f.connections.filter(c => c.command === 'sqgraph-memory')).toHaveLength(1);
        } finally { write.resolve(); await f.stop(); }
    });

    it.each([
        ['empty object at startup', {}, true],
        ['null at startup', null, true],
        ['empty object while another server is starting', {}, false],
        ['null while another server is starting', null, false]
    ] as const)('ignores an invalid unrelated server: %s', async (_label, unfinished, enabled) => {
        const f = fixture(enabled);
        await f.set(MCP_SERVERS_PREF, { ...f.servers(), unfinished });
        try {
            f.contribution.onStart();
            await flush();
            // Exercise our synchronization before Theia installs its preference listener.
            expect(f.preferences.onPreferenceChanged).toHaveBeenCalledTimes(1);
            if (!enabled) {
                await f.set('arschat.memory.enabled', true);
                await flush();
            }
            expect(f.memory.setUnavailable).not.toHaveBeenCalledWith(true);
            expect(f.messages.warn).not.toHaveBeenCalled();
            expect(f.connections.map(c => c.command)).toEqual(['everything', 'sqgraph-memory']);
            expect(await f.manager.getServerNames()).toEqual(['everything', MEMORY_SERVER]);
            expect(f.registration.mock.calls.some(([description]) => description.name === 'unfinished')).toBe(false);
            f.everything.resolve();
            await flush();
            // Subsequent memory settings must also preserve validation and availability.
            await f.set('arschat.memory.command', 'sqgraph-new');
            await flush();
            expect(f.connections.map(c => c.command)).toEqual(['everything', 'sqgraph-memory', 'sqgraph-new']);
            expect(await f.manager.getServerNames()).toEqual(['everything', MEMORY_SERVER]);
            expect(f.registration.mock.calls.some(([description]) => description.name === 'unfinished')).toBe(false);
            expect(f.preferences.get('arschat.memory.enabled', false)).toBe(true);
            expect(f.memory.setUnavailable).not.toHaveBeenCalledWith(true);
            expect(f.messages.warn).not.toHaveBeenCalled();
            expect(f.servers().unfinished).toBe(unfinished);
        } finally { await f.stop(); }
    });

    it('does not restart sqgraph when added during everything startup and only everything changes later', async () => {
        const f = fixture(false);
        try {
            f.contribution.onStart();
            await flush();
            expect(f.connections.map(c => c.command)).toEqual(['everything']);
            // The parent's preference listener is not installed yet.
            expect(f.preferences.onPreferenceChanged).toHaveBeenCalledTimes(1);
            await f.set('arschat.memory.enabled', true);
            await flush();
            expect(f.connections.filter(c => c.command === 'sqgraph-memory')).toHaveLength(1);
            f.everything.resolve();
            await flush();
            expect(f.preferences.onPreferenceChanged).toHaveBeenCalledTimes(2);
            await f.set(MCP_SERVERS_PREF, { ...f.servers(), everything: { command: 'everything-changed' } });
            await flush();
            expect(f.connections.filter(c => c.command === 'sqgraph-memory')).toHaveLength(1);
            expect(f.connections.find(c => c.command === 'sqgraph-memory')!.close).not.toHaveBeenCalled();
            expect(f.registration.mock.calls.filter(([description]) => description.name === MEMORY_SERVER)).toHaveLength(1);
            expect(f.connections.some(c => c.command === 'everything-changed')).toBe(true);
        } finally { await f.stop(); }
    });

    it('closes sqgraph before changing its definition during another server startup', async () => {
        const f = fixture();
        try {
            f.contribution.onStart();
            await flush();
            const first = f.connections.find(c => c.command === 'sqgraph-memory')!;
            expect(first).toBeDefined();
            await f.set('arschat.memory.command', 'sqgraph-new');
            await flush();
            expect(first.close).toHaveBeenCalledTimes(1);
            expect(f.connections.filter(c => c.command === 'sqgraph-new')).toHaveLength(1);
            const update = f.registration.mock.calls.findIndex(([description]) => 'command' in description && description.command === 'sqgraph-new');
            expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(f.registration.mock.invocationCallOrder[update]);
            f.everything.resolve();
            await flush();
            await f.set(MCP_SERVERS_PREF, { ...f.servers(), everything: { command: 'everything-changed' } });
            await flush();
            expect(f.connections.filter(c => c.command === 'sqgraph-new')).toHaveLength(1);
        } finally { await f.stop(); }
    });

    it('keeps other MCP startup, settings, roots and trust monitoring on environment failure', async () => {
        const f = fixture();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        f.backend.getVariables.mockRejectedValue(new Error('environment RPC unavailable'));
        await f.set(MCP_SERVERS_PREF, { ...f.servers(), [MEMORY_SERVER]: { command: 'sqgraph-memory' } });
        f.everything.resolve();
        try {
            f.contribution.onStart();
            await flush();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith('[arschat-memory] MCP memory initialization unavailable');
            expect(f.environment.accessAllowed).toBe(false);
            expect(f.memory.setUnavailable).toHaveBeenCalledWith(true);
            expect(f.messages.warn).not.toHaveBeenCalled();
            expect(f.connections.map(c => c.command)).toEqual(['everything']);
            expect(f.trust.onDidChangeWorkspaceTrust).toHaveBeenCalledTimes(2);
            await f.set(MCP_SERVERS_PREF, { ...f.servers(), additional: { command: 'additional' } });
            await flush();
            expect(f.connections.map(c => c.command)).toEqual(['everything', 'additional']);
            const roots = jest.spyOn(f.manager, 'setWorkspaceRoots');
            f.workspaceChanges.fire();
            await flush();
            expect(roots).toHaveBeenCalledWith([]);
            f.trustChanges.fire(false);
            await flush();
            expect(f.connections.every(c => c.close.mock.calls.length === 1)).toBe(true);
            f.trustChanges.fire(true);
            await flush();
            expect(f.connections.map(c => c.command)).toEqual(['everything', 'additional', 'everything', 'additional']);
            expect(f.registration.mock.calls.some(([description]) => description.name === MEMORY_SERVER)).toBe(false);
            expect(f.messages.warn).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledTimes(1);
        } finally { await f.stop(); }
    });
});
