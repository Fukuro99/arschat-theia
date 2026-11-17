/** @jest-environment jsdom */
import 'reflect-metadata';
jest.mock('@theia/core/lib/browser', () => ({}));
jest.mock('@theia/workspace/lib/browser/workspace-trust-service', () => ({ WorkspaceTrustService: Symbol('WorkspaceTrustService') }));
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: Symbol('WorkspaceService') }));
import { Emitter } from '@theia/core';
import { ArschatMemoryMcpContribution } from './memory-mcp-contribution';
import { ArschatMemoryEnvironment } from './memory-environment';
import { MCP_SERVERS_PREF, MemoryServers } from './memory-preferences';

const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); } };

function fixture(variables: { name: string; value: string }[]) {
    const environment = new ArschatMemoryEnvironment();
    Object.assign(environment, { env: { getVariables: async () => variables, getConfigDirUri: async () => 'file:///isolated-config' } });
    let servers: MemoryServers = {
        'sqgraph-memory': { command: 'sqgraph-memory', autostart: true },
        'sqgraph-memory-autotest': { command: 'sqgraph-memory', env: { SQGRAPH_MEMORY_HOME: 'personal' } },
        'alias': { command: 'C:/tools/sqgraph-memory.exe' },
        'wrapped': { command: 'uv', args: ['tool', 'run', 'sqgraph-memory', 'mcp'] },
        'other': { command: 'other' }
    };
    const changes = new Emitter<{ preferenceName: string }>();
    const manager = { addOrUpdateServer: jest.fn(), removeServer: jest.fn(), setWorkspaceRoots: jest.fn() };
    const frontend = { registerToolsForAllStartedServers: jest.fn(), getStartedServers: async () => [], startServer: jest.fn(async (_name: string) => {}) };
    const contribution = new ArschatMemoryMcpContribution();
    Object.assign(contribution, { environment, manager, frontendMCPService: frontend,
        memoryServer: { preparePreferences: async () => {}, onStart: () => {}, onStop: () => {} },
        preferenceService: { ready: Promise.resolve(), get: (key: string, fallback: unknown) => key === MCP_SERVERS_PREF ? servers : fallback,
            onPreferenceChanged: changes.event },
        workspaceService: { tryGetRoots: () => [], onWorkspaceChanged: new Emitter<void>().event },
        workspaceTrustService: { getWorkspaceTrust: async () => true, refreshRestrictedModeIndicator: () => {}, onDidChangeWorkspaceTrust: new Emitter<boolean>().event }
    });
    return { contribution, manager, frontend, change: (next: MemoryServers) => { servers = next; changes.fire({ preferenceName: MCP_SERVERS_PREF }); } };
}

describe('Theia MCP startup isolation', () => {
    it.each(['ARSCHAT_M16_AUTOTEST', 'ARSCHAT_M13_AUTOTEST', 'arschat_future_autotest'])('never registers or starts configured sqgraph servers for %s', async name => {
        const f = fixture([{ name, value: '1' }]);
        f.contribution.onStart();
        await flush();
        expect(f.manager.addOrUpdateServer.mock.calls.map(call => call[0].name)).toEqual(['other']);
        expect(f.frontend.startServer.mock.calls.map(call => call[0])).toEqual(['other']);
        f.change({ 'sqgraph-memory': { command: 'personal-changed' }, other: { command: 'other' } });
        await flush();
        expect(f.manager.addOrUpdateServer.mock.calls.map(call => call[0].name)).toEqual(['other']);
        expect(f.frontend.startServer.mock.calls.every(call => call[0] === 'other')).toBe(true);
    });
    it('preserves normal startup and manual definitions outside autotests', async () => {
        const f = fixture([]);
        f.contribution.onStart();
        await flush();
        expect(f.manager.addOrUpdateServer.mock.calls.map(call => call[0].name)).toContain('sqgraph-memory');
        expect(f.frontend.startServer).toHaveBeenCalledWith('sqgraph-memory');
    });
});
