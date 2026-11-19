/** @jest-environment node */
import 'reflect-metadata';
import { Container } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common';
import { KeyStoreService, keyStoreServicePath } from '@theia/core/lib/common/key-store';
import { InMemoryCredentialsProvider, KeyStoreServiceImpl } from '@theia/core/lib/node/key-store-server';
import { backendApplicationModule } from '@theia/core/lib/node/backend-application-module';
import { ArschatKeyStoreServiceImpl } from 'arschat-providers/lib/node/arschat-key-store-service-impl';
import { ArschatKeychainStatusService, arschatKeychainStatusPath } from 'arschat-providers/lib/common/arschat-keychain-status-service';
import providersModule from 'arschat-providers/lib/node/arschat-providers-backend-module';
import { LanguageModelProvider } from '@theia/ai-core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CliAgentService, cliAgentServicePath, CLAUDE_KEY_REQUIRED } from 'arschat-providers/lib/common/cli-agents';

// Only this backend suite loads the real Theia class. Native keytar remains wholly synthetic.
jest.unmock('@theia/core/lib/node/key-store-server');
jest.mock('keytar', () => ({
    findCredentials: jest.fn(async () => []),
    findPassword: jest.fn(async () => null),
    setPassword: jest.fn(async () => undefined),
    getPassword: jest.fn(async () => null),
    deletePassword: jest.fn(async () => false)
}));
const mockKeytar = require('keytar') as jest.Mocked<typeof import('keytar')>;
const originalGetKeytar = (KeyStoreServiceImpl.prototype as any).getKeytar;
let getKeytar: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    // Default to an explicitly selected synthetic provider. No test can reach native credentials.
    getKeytar = jest.spyOn(KeyStoreServiceImpl.prototype as any, 'getKeytar').mockResolvedValue(mockKeytar);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

function backend() {
    const container = new Container();
    // Use the actual core module, in the same order as Theia's generated backend server.
    container.load(backendApplicationModule);
    expect(container.isBound(KeyStoreService)).toBe(true);
    container.load(providersModule);
    const store = container.get<ArschatKeyStoreServiceImpl>(KeyStoreService);
    const status = container.get<ArschatKeychainStatusService>(ArschatKeychainStatusService);
    return { container, store, status };
}

it('contributes both CLI LanguageModels and a shared preflight RPC service', async () => {
    const { container } = backend();
    container.rebind(EnvVariablesServer).toConstantValue({ getConfigDirUri: async () => 'file:///unused' });
    const models = (await Promise.all(container.getAll<LanguageModelProvider>(LanguageModelProvider).map(provider => provider()))).flat();
    expect(models.map(model => [model.id, model.name, model.vendor])).toEqual([
        ['codex-cli', 'Codex (CLI)', 'Codex (CLI)'], ['claude-code-cli', 'Claude Code (CLI)', 'Claude Code (CLI)']
    ]);
    const handler = container.getAll<any>(ConnectionHandler).find(h => h.path === cliAgentServicePath);
    expect(handler.targetFactory()).toBe(container.get(CliAgentService));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
        expect(await models[1].request({ messages: [], sessionId: 's', requestId: 'r' })).toEqual({ text: CLAUDE_KEY_REQUIRED });
    } finally {
        if (saved === undefined) { delete process.env.ANTHROPIC_API_KEY; } else { process.env.ANTHROPIC_API_KEY = saved; }
    }
});

it('rebinds the core singleton and both RPC handlers resolve that same credential instance', async () => {
    const { container, store, status } = backend();
    expect(store).toBeInstanceOf(ArschatKeyStoreServiceImpl);
    expect(store).toBe(container.get(KeyStoreService));
    expect(status).toBe(container.get(ArschatKeychainStatusService));
    const handlers = container.getAll<any>(ConnectionHandler);
    const credentialHandlers = handlers.filter(h => h.path === keyStoreServicePath);
    const statusHandlers = handlers.filter(h => h.path === arschatKeychainStatusPath);
    expect(credentialHandlers).toHaveLength(1);
    expect(statusHandlers).toHaveLength(1);
    expect(credentialHandlers[0].targetFactory()).toBe(store);
    expect(statusHandlers[0].targetFactory()).toBe(status);
    const selected = jest.spyOn(store, 'isPersistent');
    expect(await status.isPersistent()).toBe(true);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(getKeytar).toHaveBeenCalledTimes(1);
    // Status performs no independent probe, including credential writes/deletions.
    for (const method of Object.values(mockKeytar)) { expect(method).not.toHaveBeenCalled(); }
});

it('fails at module loading when the core binding is absent instead of silently leaving the wrong store', () => {
    const container = new Container();
    expect(container.isBound(KeyStoreService)).toBe(false);
    expect(() => container.load(providersModule)).toThrow('requires the core KeyStoreService binding');
});

it.each(['status first', 'credentials first'])('uses the selected in-memory provider for status and writes (%s)', async order => {
    const memory = new InMemoryCredentialsProvider();
    getKeytar.mockResolvedValue(memory);
    const { store, status } = backend();
    if (order === 'status first') { expect(await status.isPersistent()).toBe(false); }
    await store.setPassword('arschat-test', 'dummy', 'synthetic');
    expect(await store.getPassword('arschat-test', 'dummy')).toBe('synthetic');
    expect(await status.isPersistent()).toBe(false);
    expect(await memory.getPassword('arschat-test', 'dummy')).toBe('synthetic');
    expect(mockKeytar.setPassword).not.toHaveBeenCalled();
});

it.each(['status first', 'credentials first'])('keeps Theia fallback after a failed initial check even if keytar recovers (%s)', async order => {
    // Exercise Theia's real selection/cache logic through the spy; its import resolves only our mock.
    getKeytar.mockImplementation(function (this: KeyStoreServiceImpl) { return originalGetKeytar.call(this); });
    mockKeytar.findCredentials.mockRejectedValueOnce(new Error('synthetic access denied'));
    const { store, status } = backend();
    if (order === 'status first') { expect(await status.isPersistent()).toBe(false); }
    await store.setPassword('arschat-test', 'dummy', 'synthetic');
    expect(await status.isPersistent()).toBe(false);
    expect(await store.getPassword('arschat-test', 'dummy')).toBe('synthetic');
    expect(await Promise.all([status.isPersistent(), status.isPersistent()])).toEqual([false, false]);
    expect(mockKeytar.findCredentials).toHaveBeenCalledTimes(1);
    expect(mockKeytar.findCredentials).toHaveBeenCalledWith('test-keytar-loads');
    expect(mockKeytar.setPassword).not.toHaveBeenCalled();
    // A new backend instance can select the recovered native mock; the old one stays in memory.
    const restarted = backend();
    expect(await restarted.status.isPersistent()).toBe(true);
    expect(await restarted.store.getPassword('arschat-test', 'dummy')).toBeUndefined();
    expect(await status.isPersistent()).toBe(false);
});

it('shares Theia successful selection between status calls and credential operations without a probe', async () => {
    getKeytar.mockImplementation(function (this: KeyStoreServiceImpl) { return originalGetKeytar.call(this); });
    const { store, status } = backend();
    expect(await status.isPersistent()).toBe(true);
    expect(await status.isPersistent()).toBe(true);
    await store.setPassword('arschat-test', 'dummy', 'synthetic');
    expect(mockKeytar.findCredentials).toHaveBeenCalledTimes(1);
    expect(mockKeytar.setPassword).toHaveBeenCalledTimes(1);
    expect(mockKeytar.setPassword).toHaveBeenCalledWith('arschat-test', 'dummy', 'synthetic');
    expect(mockKeytar.getPassword).not.toHaveBeenCalled();
    expect(mockKeytar.deletePassword).not.toHaveBeenCalled();
});

it.each(['status first', 'credentials first'])('awaits the initial access check across concurrent RPCs (%s)', async order => {
    getKeytar.mockImplementation(function (this: KeyStoreServiceImpl) { return originalGetKeytar.call(this); });
    let checking!: () => void;
    const started = new Promise<void>(resolve => { checking = resolve; });
    let failCheck!: (error: Error) => void;
    mockKeytar.findCredentials.mockImplementationOnce(async () => {
        checking();
        return new Promise((_resolve, reject) => { failCheck = reject; });
    });
    const { store, status } = backend();
    const check = () => status.isPersistent();
    const save = () => store.setPassword('arschat-test', 'dummy', 'synthetic');
    const first = order === 'status first' ? check() : save();
    await started;
    const second = order === 'status first' ? save() : check();
    const concurrentStatus = check();
    failCheck(new Error('synthetic access denied'));
    const results = await Promise.all([first, second, concurrentStatus]);
    expect(results[order === 'status first' ? 0 : 1]).toBe(false);
    expect(results[2]).toBe(false);
    expect(await store.getPassword('arschat-test', 'dummy')).toBe('synthetic');
    expect(mockKeytar.findCredentials).toHaveBeenCalledTimes(1);
    expect(mockKeytar.setPassword).not.toHaveBeenCalled();
});
