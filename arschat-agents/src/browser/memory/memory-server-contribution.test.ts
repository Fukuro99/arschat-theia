/** @jest-environment jsdom */
import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-trust-service', () => ({ WorkspaceTrustService: Symbol('WorkspaceTrustService') }));
import { MCPServerDescription, MCPServerStatus } from '@theia/ai-mcp/lib/common/mcp-server-manager';
import { ArschatMemoryServerContribution } from './memory-server-contribution';
import { MCP_SERVERS_PREF } from './memory-preferences';
import { ArschatMemoryEnvironment } from './memory-environment';
import { Emitter } from '@theia/core';

class TestServer extends ArschatMemoryServerContribution {
    configureMemory(update = false) { return this.configureServer(update); }
    status() { return this.checkStatus(); }
    fail() { this.unavailable(); }
}
function fixture() {
    const values: Record<string, any> = {};
    const order: string[] = [];
    const changes = new Emitter<{ preferenceName: string }>();
    const preferences = { ready: Promise.resolve(), get: (key: string, fallback: unknown) => values[key] ?? fallback,
        onPreferenceChanged: changes.event,
        set: jest.fn(async (key: string, value: any) => { order.push('set'); values[key] = value; }) };
    const environment = Object.assign(new ArschatMemoryEnvironment(), { ready: async () => {}, autoSaveBlocked: false });
    const mcp = { hasServer: jest.fn(async () => true), stopServer: jest.fn(async () => { order.push('stop'); }),
        startServer: jest.fn(async () => { order.push('start'); }), addOrUpdateServer: jest.fn(async (_description: MCPServerDescription) => {}),
        getServerDescription: jest.fn(async () => ({ name: environment.serverName, command: 'sqgraph-memory', autostart: true,
            ...values[MCP_SERVERS_PREF]?.['sqgraph-memory'], status: MCPServerStatus.Running })) };
    const messages = { warn: jest.fn() };
    const memory = { setUnavailable: jest.fn() };
    const trust = { getWorkspaceTrust: jest.fn(async () => true), onDidChangeWorkspaceTrust: new Emitter<boolean>().event };
    const notifications = { onDidUpdateMCPServers: new Emitter<void>().event };
    const server = new TestServer();
    Object.assign(server, { preferences, environment, mcp, messages, memory, trust, notifications, synchronizeServers: jest.fn() });
    return { server, values, preferences, environment, mcp, messages, memory, trust, order, changes };
}

describe('memory server lifecycle', () => {
    it('preserves manual definitions on startup', async () => {
        const f = fixture();
        f.values[MCP_SERVERS_PREF] = { 'sqgraph-memory': { command: 'custom' } };
        await f.server.configureMemory();
        expect(f.preferences.set).not.toHaveBeenCalled();
        expect(f.mcp.addOrUpdateServer).not.toHaveBeenCalled();
    });
    it('stops before updating preferences and restarting', async () => {
        const f = fixture();
        f.values['arschat.memory.command'] = 'new-command';
        f.values['arschat.memory.agentName'] = 'new-agent';
        f.values['arschat.memory.group'] = 'new-group';
        await f.server.configureMemory(true);
        expect(f.order).toEqual(['stop', 'set', 'start', 'start']);
        expect(f.values[MCP_SERVERS_PREF]['sqgraph-memory']).toMatchObject({ command: 'new-command', args: ['mcp', '--agent', 'new-agent'], env: { SQGRAPH_MEMORY_GROUP: 'new-group' } });
    });
    it('notifies once on Errored status and disables memory', async () => {
        const f = fixture();
        f.mcp.getServerDescription.mockResolvedValue({ name: 'sqgraph-memory', command: 'x', autostart: true, status: MCPServerStatus.Errored });
        await f.server.status();
        await f.server.status();
        f.server.fail();
        expect(f.messages.warn).toHaveBeenCalledTimes(1);
        expect(f.memory.setUnavailable).toHaveBeenCalledWith(true);
        expect(f.messages.warn.mock.calls[0][0]).toContain('uv tool install');
    });
    it('does not start when disabled or workspace trust is absent', async () => {
        const f = fixture();
        f.values['arschat.memory.enabled'] = false;
        await f.server.configureMemory();
        expect(f.preferences.set).not.toHaveBeenCalled();
        f.values['arschat.memory.enabled'] = true;
        f.trust.getWorkspaceTrust.mockResolvedValue(false);
        await f.server.configureMemory();
        expect(f.mcp.startServer).not.toHaveBeenCalled();
    });
    it('does not start personal memory for other autotests', async () => {
        const f = fixture();
        f.environment.autoSaveBlocked = true;
        await f.server.configureMemory();
        expect(f.preferences.set).not.toHaveBeenCalled();
        expect(f.mcp.startServer).not.toHaveBeenCalled();
    });
    it('registers only the isolated ephemeral server in M16, ignoring existing preferences', async () => {
        const f = fixture();
        Object.assign(f.environment, { autoSaveBlocked: true, m16: true, serverName: 'sqgraph-memory-autotest', testHome: 'C:/isolated' });
        f.values[MCP_SERVERS_PREF] = { 'sqgraph-memory': { env: { SQGRAPH_MEMORY_DB: 'personal.db' } } };
        f.mcp.getServerDescription.mockResolvedValueOnce(undefined);
        await f.server.configureMemory();
        expect(f.preferences.set).not.toHaveBeenCalled();
        expect(f.mcp.addOrUpdateServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'sqgraph-memory-autotest', env: {
            SQGRAPH_MEMORY_HOME: 'C:/isolated'
        } }));
        expect(f.mcp.startServer).toHaveBeenCalledWith('sqgraph-memory-autotest');
    });
    it('rejects an existing test server that points outside the isolated home', async () => {
        const f = fixture();
        Object.assign(f.environment, { autoSaveBlocked: true, m16: true, serverName: 'sqgraph-memory-autotest', testHome: 'C:/isolated' });
        await expect(f.server.configureMemory()).rejects.toThrow('unsafe autotest server definition');
        expect(f.mcp.startServer).not.toHaveBeenCalled();
    });
    it('consumes pending updates before awaiting so changes during registration are retained', async () => {
        const f = fixture();
        let release!: () => void;
        let entered!: () => void;
        const registering = new Promise<void>(resolve => { entered = resolve; });
        f.preferences.set.mockImplementationOnce(async (key, value) => {
            f.values[key] = value;
            entered();
            await new Promise<void>(resolve => { release = resolve; });
        });
        f.values['arschat.memory.group'] = 'first';
        f.server.onStart();
        await registering;
        f.values['arschat.memory.group'] = 'second';
        f.changes.fire({ preferenceName: 'arschat.memory.group' });
        release();
        await (f.server as any).queue;
        expect(f.values[MCP_SERVERS_PREF]['sqgraph-memory'].env).toEqual({ SQGRAPH_MEMORY_GROUP: 'second' });
        expect(f.mcp.stopServer).toHaveBeenCalledTimes(1);
        expect(f.preferences.set).toHaveBeenCalledTimes(2);
        f.server.onStop();
    });
    it('routes registration through the parent synchronizer before starting', async () => {
        const f = fixture();
        // Theia is still waiting for another server; settings writes have no listener.
        let description: any;
        f.mcp.getServerDescription.mockImplementation(async () => description);
        f.mcp.addOrUpdateServer.mockImplementation(async (...args: any[]) => {
            description = { ...args[0] };
        });
        f.mcp.startServer.mockImplementation(async () => { description.status = MCPServerStatus.Running; });
        f.server.synchronizeServers = jest.fn(() => {
            void f.mcp.addOrUpdateServer({ ...f.values[MCP_SERVERS_PREF]['sqgraph-memory'], name: 'sqgraph-memory' });
        });
        await f.server.configureMemory();
        expect(f.server.synchronizeServers).toHaveBeenCalledTimes(1);
        expect(f.mcp.addOrUpdateServer).toHaveBeenCalledTimes(1);
        expect(description).toMatchObject({ name: 'sqgraph-memory', command: 'sqgraph-memory', status: MCPServerStatus.Running });
        expect(f.memory.setUnavailable).toHaveBeenLastCalledWith(false);
    });
});
