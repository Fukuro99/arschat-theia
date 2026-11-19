import 'reflect-metadata';
import { CliAgentAutotestContribution } from 'arschat-providers/lib/browser/cli-agent-autotest-contribution';
import { ArschatKeychainStatusService, arschatKeychainStatusPath } from 'arschat-providers/lib/common/arschat-keychain-status-service';
import { Emitter, PreferenceScope } from '@theia/core';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import * as AP from '@theia/ai-anthropic/lib/common/anthropic-preferences';
import * as OP from '@theia/ai-openai/lib/common/openai-preferences';
import { PREFERENCE_NAME_MAX_RETRIES } from '@theia/ai-core/lib/common/ai-core-preferences';
import { ArschatSecretStore } from 'arschat-providers/lib/browser/arschat-secret-store';
import { ArschatSecretMigration } from 'arschat-providers/lib/browser/arschat-secret-migration';
import { ArschatSecretSettings } from 'arschat-providers/lib/browser/arschat-secret-settings';
import { ArschatAnthropicFrontendContribution, ArschatOpenAiFrontendContribution } from 'arschat-providers/lib/browser/arschat-secret-frontend-contributions';
import { ArschatM9AutotestContribution } from 'arschat-providers/lib/browser/arschat-m9-autotest-contribution';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { ArschatApiKeysDialog } from './arschat-api-keys-dialog';
import { fireEvent, waitFor } from '@testing-library/react';
import { Container } from '@theia/core/shared/inversify';
import { ILogger, PreferenceService } from '@theia/core';
import { FrontendApplicationContribution, RemoteConnectionProvider } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { AICorePreferences } from '@theia/ai-core/lib/common/ai-core-preferences';
import anthropicModule from '@theia/ai-anthropic/lib/browser/anthropic-frontend-module';
import openaiModule from '@theia/ai-openai/lib/browser/openai-frontend-module';
import { AnthropicFrontendApplicationContribution } from '@theia/ai-anthropic/lib/browser/anthropic-frontend-application-contribution';
import { OpenAiFrontendApplicationContribution } from '@theia/ai-openai/lib/browser/openai-frontend-application-contribution';
import { AnthropicLanguageModelsManager } from '@theia/ai-anthropic/lib/common';
import { OpenAiLanguageModelsManager } from '@theia/ai-openai/lib/common';
import providersModule from 'arschat-providers/lib/browser/arschat-providers-frontend-module';
import { ArschatM2AutotestContribution } from 'arschat-providers/lib/browser/arschat-m2-autotest-contribution';
import { ArschatLocalLlmAutotestContribution } from 'arschat-providers/lib/browser/arschat-local-llm-autotest-contribution';
import { ArschatProvidersSeedContribution } from 'arschat-providers/lib/browser/arschat-providers-seed-contribution';

function fixture(initial: Array<[string, string]> = [], persistent = true, persisted = {
    vault: new Map(initial), scoped: new Map<string, any>()
}) {
    const { vault, scoped } = persisted;
    const keychainStatus = { isPersistent: jest.fn(async () => persistent) };
    const keyStore: jest.Mocked<KeyStoreService> = {
        keys: jest.fn(async (_service: string) => [...vault.keys()]),
        getPassword: jest.fn(async (_service, account) => vault.get(account)),
        setPassword: jest.fn(async (_service, account, password) => { vault.set(account, password); }),
        deletePassword: jest.fn(async (_service, account) => vault.delete(account)),
        findCredentials: jest.fn(async (_service: string) => [...vault].map(([account, password]) => ({ account, password }))),
        findPassword: jest.fn(async (_service: string): Promise<string | undefined> => undefined)
    };
    const secrets = new ArschatSecretStore();
    Object.assign(secrets, { keyStore });
    const changes = new Emitter<{ preferenceName: string }>();
    const preferences = {
        ready: Promise.resolve(),
        onPreferenceChanged: changes.event,
        inspectInScope: (name: string, scope: PreferenceScope) => scoped.get(`${scope}:${name}`),
        get: (name: string, fallback?: unknown) => scoped.get(`${PreferenceScope.Workspace}:${name}`)
            ?? scoped.get(`${PreferenceScope.User}:${name}`) ?? fallback,
        set: jest.fn(async (name: string, value: unknown, scope: PreferenceScope) => {
            if (value === undefined) { scoped.delete(`${scope}:${name}`); }
            else { scoped.set(`${scope}:${name}`, value); }
            changes.fire({ preferenceName: name });
        })
    };
    const put = (name: string, value: unknown, scope = PreferenceScope.User): void => { scoped.set(`${scope}:${name}`, value); };
    const logger = { warn: jest.fn() };
    const migration = new ArschatSecretMigration();
    Object.assign(migration, { secrets, preferences, logger, keychainStatus });
    const settings = new ArschatSecretSettings();
    Object.assign(settings, { secrets, preferences, migration, keychainStatus });
    const restart = () => fixture([], persistent, persisted);
    return { vault, keyStore, secrets, preferences, scoped, changes, put, logger, migration, settings, keychainStatus, restart };
}

beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('secret migration startup', () => {
    it('lets later contributions start before preferences are ready, then migrates once', async () => {
        const f = fixture();
        const preferencesReady = deferred();
        f.preferences.ready = preferencesReady.promise;
        f.put(AP.API_KEY_PREF, 'legacy-global');
        await f.secrets.ready();

        expect(f.migration.onStart()).toBeUndefined();
        expect(f.migration.onStart()).toBeUndefined();
        await Promise.resolve();
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(f.preferences.set).not.toHaveBeenCalled();

        preferencesReady.resolve(); // A later frontend contribution can now resolve this.
        await f.migration.ready();
        expect(f.vault.get('anthropic')).toBe('legacy-global');
        expect(f.preferences.get(AP.API_KEY_PREF)).toBeUndefined();
        expect(f.keyStore.setPassword).toHaveBeenCalledTimes(1);
    });

    it('handles preference readiness failures without logging exception contents', async () => {
        const f = fixture();
        const preferencesReady = deferred();
        f.preferences.ready = preferencesReady.promise;
        await f.secrets.ready();
        f.migration.onStart();
        await Promise.resolve();
        preferencesReady.reject(new Error('private-key-in-error'));
        await f.migration.ready();
        expect(f.logger.warn.mock.calls).toEqual([
            ['[arschat-secrets] migration failed; plaintext preferences retained']
        ]);
        expect(f.preferences.set).not.toHaveBeenCalled();
    });
});

describe('M9 secret store (Map-backed KeyStoreService only)', () => {
    it('preloads once via keys/getPassword, then emits account-only events after verified set/delete', async () => {
        const f = fixture([['anthropic', 'saved']]);
        const events: string[] = [];
        f.secrets.onDidChange(account => events.push(account));
        await Promise.all([f.secrets.ready(), f.secrets.ready()]);
        expect(f.keyStore.keys).toHaveBeenCalledTimes(1);
        expect(f.keyStore.keys).toHaveBeenCalledWith('arschat');
        expect(f.keyStore.getPassword).toHaveBeenCalledWith('arschat', 'anthropic');
        expect(f.secrets.get('anthropic')).toBe('saved');
        await f.secrets.set('openai', 'new');
        expect(f.keyStore.setPassword).toHaveBeenCalledWith('arschat', 'openai', 'new');
        expect(f.keyStore.getPassword).toHaveBeenLastCalledWith('arschat', 'openai');
        expect(f.secrets.get('openai')).toBe('new');
        await f.secrets.delete('openai');
        expect(f.vault.has('openai')).toBe(false);
        expect(f.secrets.get('openai')).toBeUndefined();
        expect(events).toEqual(['anthropic', 'openai', 'openai']);
    });

    it('sanitizes write failures, retains old cache and permits retry', async () => {
        const f = fixture([['openai', 'old']]);
        await f.secrets.ready();
        const changed = jest.fn();
        f.secrets.onDidChange(changed);
        f.keyStore.setPassword.mockRejectedValueOnce(new Error('backend leaked secret-value'));
        await expect(f.secrets.set('openai', 'secret-value')).rejects.toThrow('API キーの保存・照合に失敗しました。');
        expect(f.secrets.get('openai')).toBe('old');
        expect(changed).not.toHaveBeenCalled();
        await f.secrets.set('openai', 'retry');
        expect(f.secrets.get('openai')).toBe('retry');
    });

    it('does not claim deletion when backend leaves the credential behind', async () => {
        const f = fixture([['openai', 'old']]);
        f.keyStore.deletePassword.mockResolvedValue(false);
        await expect(f.secrets.delete('openai')).rejects.toThrow('削除');
        expect(f.secrets.get('openai')).toBe('old');
    });

    it('serializes overlapping writes and retries a failed preload', async () => {
        const f = fixture();
        f.keyStore.keys.mockRejectedValueOnce(new Error('unavailable'));
        await expect(f.secrets.ready()).rejects.toThrow('読み込み');
        await Promise.all([f.secrets.set('openai', 'one'), f.secrets.set('openai', 'two'), f.secrets.delete('openai')]);
        expect(f.vault.size).toBe(0);
        expect(f.secrets.get('openai')).toBeUndefined();
    });
});

describe('M9 migration', () => {
    it('migrates both scopes and both providers, preserves fields/flags/public seed, and is idempotent', async () => {
        const f = fixture();
        f.put(AP.API_KEY_PREF, 'user-anthropic');
        f.put(AP.API_KEY_PREF, 'workspace-anthropic', PreferenceScope.Workspace);
        f.put(OP.API_KEY_PREF, 'user-openai');
        for (const scope of [PreferenceScope.User, PreferenceScope.Workspace]) {
            for (const name of [OP.CUSTOM_ENDPOINTS_PREF, AP.CUSTOM_ENDPOINTS_PREF]) {
                f.put(name, [
                    { id: `${scope}:${name}`, model: 'x', url: 'http://localhost/v1', apiKey: 'private', extra: 42 },
                    { id: 'unsloth', apiKey: 'sk-unsloth-local' }, { id: 'global', apiKey: true }
                ], scope);
            }
        }
        await f.migration.migrate();
        expect(f.vault.get('anthropic')).toBe('workspace-anthropic');
        expect(f.vault.get('openai')).toBe('user-openai');
        expect(f.preferences.get(AP.API_KEY_PREF)).toBeUndefined();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBeUndefined();
        for (const scope of [PreferenceScope.User, PreferenceScope.Workspace]) {
            for (const name of [OP.CUSTOM_ENDPOINTS_PREF, AP.CUSTOM_ENDPOINTS_PREF]) {
                expect(f.vault.get(`custom:${scope}:${name}`)).toBe('private');
                expect(f.preferences.inspectInScope(name, scope)).toEqual([
                    { id: `${scope}:${name}`, model: 'x', url: 'http://localhost/v1', extra: 42 },
                    { id: 'unsloth', apiKey: 'sk-unsloth-local' }, { id: 'global', apiKey: true }
                ]);
            }
        }
        expect(f.vault.has('custom:unsloth')).toBe(false);
        expect(f.vault.has('custom:global')).toBe(false);
        const writes = f.keyStore.setPassword.mock.calls.length;
        const prefWrites = f.preferences.set.mock.calls.length;
        await f.migration.migrate();
        expect(f.keyStore.setPassword).toHaveBeenCalledTimes(writes);
        expect(f.preferences.set).toHaveBeenCalledTimes(prefWrites);
    });

    it('verifies the existing account and removes obsolete plaintext immediately', async () => {
        const f = fixture([['openai', 'existing'], ['custom:x', 'existing-custom']]);
        f.put(OP.API_KEY_PREF, 'obsolete');
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ model: 'x', apiKey: 'obsolete-custom' }]);
        await f.migration.migrate();
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(f.vault.get('openai')).toBe('existing');
        expect(f.preferences.get(OP.CUSTOM_ENDPOINTS_PREF)).toEqual([{ model: 'x' }]);
        expect(f.preferences.set).toHaveBeenCalledWith(OP.API_KEY_PREF, undefined, PreferenceScope.User);
    });

    it('retains plaintext when the existing vault changes after preloading', async () => {
        const f = fixture([['openai', 'cached']]);
        f.put(OP.API_KEY_PREF, 'private');
        await f.secrets.ready();
        f.vault.set('openai', 'changed-elsewhere');
        await f.migration.migrate();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('private');
        expect(f.vault.get('openai')).toBe('changed-elsewhere');
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(f.preferences.set).not.toHaveBeenCalled();
    });

    it.each(['mismatch', 'write error', 'load error'])('retains plaintext on %s and never logs exception secrets', async failure => {
        const f = fixture();
        f.put(OP.API_KEY_PREF, 'private');
        f.put(AP.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', apiKey: 'private' }]);
        if (failure === 'mismatch') { f.keyStore.getPassword.mockResolvedValue('wrong'); }
        if (failure === 'write error') { f.keyStore.setPassword.mockRejectedValue(new Error('private')); }
        if (failure === 'load error') { f.keyStore.keys.mockRejectedValue(new Error('private')); }
        await f.migration.migrate();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('private');
        expect(f.preferences.get(AP.CUSTOM_ENDPOINTS_PREF)[0].apiKey).toBe('private');
        expect(f.preferences.set).not.toHaveBeenCalled();
        expect(f.logger.warn).toHaveBeenCalled();
        expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private');
    });

    it('preserves concurrent preference edits made while the credential RPC is pending', async () => {
        const f = fixture();
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', apiKey: 'old', url: 'old' }]);
        f.keyStore.setPassword.mockImplementation(async (_service, account, value) => {
            f.vault.set(account, value);
            f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', apiKey: 'new', url: 'new' }, { id: 'added' }]);
        });
        await f.migration.migrate();
        expect(f.preferences.get(OP.CUSTOM_ENDPOINTS_PREF)).toEqual([{ id: 'x', apiKey: 'new', url: 'new' }, { id: 'added' }]);
    });

    it('retains a verified credential if preference cleanup fails, allowing a later retry', async () => {
        const f = fixture();
        f.put(OP.API_KEY_PREF, 'private');
        f.preferences.set.mockRejectedValueOnce(new Error('private'));
        await f.migration.migrate();
        expect(f.vault.get('openai')).toBe('private');
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('private');
        await f.migration.migrate();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBeUndefined();
        expect(f.keyStore.getPassword).toHaveBeenCalledWith('arschat', 'openai');
    });

    it('never copies or deletes plaintext on frontend reloads or backend restarts when persistence is false', async () => {
        let f = fixture([['openai', 'in-memory-existing']], false);
        for (const scope of [PreferenceScope.Workspace, PreferenceScope.User]) {
            f.put(OP.API_KEY_PREF, 'private-openai', scope);
            f.put(AP.API_KEY_PREF, 'private-anthropic', scope);
            for (const name of [OP.CUSTOM_ENDPOINTS_PREF, AP.CUSTOM_ENDPOINTS_PREF]) {
                f.put(name, [{ id: 'x', apiKey: 'private-custom' }], scope);
            }
        }
        const original = [...f.scoped];
        for (let startup = 0; startup < 3; startup++) {
            await f.migration.ready();
            await f.migration.migrate();
            expect([...f.scoped]).toEqual(original);
            expect(f.keyStore.setPassword).not.toHaveBeenCalled();
            expect(f.keyStore.deletePassword).not.toHaveBeenCalled();
            expect(f.preferences.set).not.toHaveBeenCalled();
            expect(f.logger.warn).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private-');
            if (startup === 1) { f.vault.clear(); }
            f = f.restart();
        }
    });

    it('retains all plaintext and avoids writes when the status RPC fails', async () => {
        const f = fixture();
        f.put(OP.API_KEY_PREF, 'private');
        f.keychainStatus.isPersistent.mockRejectedValue(new Error('private'));
        await f.migration.ready();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('private');
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private');
    });

});

describe.each([
    ['anthropic', ArschatAnthropicFrontendContribution, AP],
    ['openai', ArschatOpenAiFrontendContribution, OP]
] as const)('M9 %s contribution', (account, Contribution, prefs) => {
    function contribution(f: ReturnType<typeof fixture>) {
        const c = new Contribution() as any;
        const aiChanges = new Emitter<{ preferenceName: string }>();
        const manager = { setApiKey: jest.fn(), setProxyUrl: jest.fn(), createOrUpdateLanguageModels: jest.fn(), removeLanguageModels: jest.fn() };
        Object.assign(c, { secrets: f.secrets, migration: f.migration, preferenceService: f.preferences,
            aiCorePreferences: { get: () => 3, onPreferenceChanged: aiChanges.event }, manager });
        return { c, manager, aiChanges };
    }

    it('returns immediately while preferences are pending, then migrates and injects once', async () => {
        const f = fixture();
        const preferencesReady = deferred();
        f.preferences.ready = preferencesReady.promise;
        f.put(prefs.API_KEY_PREF, 'legacy-global');
        f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1', apiKey: 'legacy-custom' }]);
        const { c, manager } = contribution(f);

        expect(c.onStart()).toBeUndefined();
        expect(c.onStart()).toBeUndefined();
        await Promise.resolve();
        expect(manager.setApiKey).not.toHaveBeenCalled();
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();

        preferencesReady.resolve();
        await c.ready();
        expect(f.vault.get(account)).toBe('legacy-global');
        expect(f.preferences.get(prefs.API_KEY_PREF)).toBeUndefined();
        expect(manager.setApiKey).toHaveBeenCalledTimes(1);
        expect(manager.setApiKey).toHaveBeenCalledWith('legacy-global');
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: 'legacy-custom' }));
        c.onStop();
    });

    it.each(['preferences', 'migration'])('catches %s readiness rejection without logging exception contents', async dependency => {
        const f = fixture();
        const ready = deferred();
        if (dependency === 'preferences') {
            f.preferences.ready = ready.promise;
        } else {
            jest.spyOn(f.migration, 'ready').mockReturnValue(ready.promise);
        }
        const { c, manager } = contribution(f);
        c.onStart();
        await Promise.resolve();
        ready.reject(new Error('private-key-in-error'));
        await c.ready();
        expect(console.warn).toHaveBeenCalledWith(`[arschat-secrets] ${account} key injection failed`);
        expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('private-key-in-error');
        expect(manager.setApiKey).not.toHaveBeenCalled();
        c.onStop();
    });

    it.each(['unavailable', 'status RPC failure'])('injects existing vault keys after preload when persistence is %s', async failure => {
        const f = fixture([[account, 'existing-global'], ['custom:x', 'existing-custom']], false);
        if (failure === 'status RPC failure') {
            f.keychainStatus.isPersistent.mockRejectedValue(new Error('unavailable'));
        }
        f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1' }]);
        let finishRead!: () => void;
        const read = new Promise<void>(resolve => { finishRead = resolve; });
        f.keyStore.keys.mockImplementation(async () => { await read; return [...f.vault.keys()]; });
        const { c, manager } = contribution(f);
        c.onStart();
        const started = c.ready();
        await waitFor(() => expect(f.keyStore.keys).toHaveBeenCalled());
        expect(manager.setApiKey).not.toHaveBeenCalled();
        finishRead();
        await started;
        expect(manager.setApiKey).toHaveBeenLastCalledWith('existing-global');
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: 'existing-custom' }));
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(f.preferences.set).not.toHaveBeenCalled();
        c.onStop();
    });

    it('reinjects global and custom keys when a failed preload succeeds later', async () => {
        const f = fixture([[account, 'recovered-global'], ['custom:x', 'recovered-custom']], false);
        f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1' }]);
        f.keyStore.keys.mockRejectedValue(new Error('unavailable'));
        const { c, manager } = contribution(f);
        c.onStart();
        await c.ready();
        expect(manager.setApiKey).toHaveBeenLastCalledWith(undefined);
        f.keyStore.keys.mockImplementation(async () => [...f.vault.keys()]);
        await f.secrets.ready();
        await waitFor(() => expect(manager.setApiKey).toHaveBeenLastCalledWith('recovered-global'));
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: 'recovered-custom' }));
        c.onStop();
    });

    it('waits for migration writes before injecting newly migrated keys', async () => {
        const f = fixture();
        f.put(prefs.API_KEY_PREF, 'legacy-global');
        let finishWrite!: () => void;
        const write = new Promise<void>(resolve => { finishWrite = resolve; });
        f.keyStore.setPassword.mockImplementation(async (_service, name, value) => {
            await write;
            f.vault.set(name, value);
        });
        const { c, manager } = contribution(f);
        c.onStart();
        const started = c.ready();
        await waitFor(() => expect(f.keyStore.setPassword).toHaveBeenCalled());
        expect(manager.setApiKey).not.toHaveBeenCalled();
        finishWrite();
        await started;
        expect(f.preferences.get(prefs.API_KEY_PREF)).toBeUndefined();
        expect(manager.setApiKey).toHaveBeenLastCalledWith('legacy-global');
        c.onStop();
    });

    it('injects custom cached keys but preserves literal string precedence and Theia defaults', async () => {
        const f = fixture([['custom:x', 'vault-key']]);
        await f.secrets.ready();
        const { c } = contribution(f);
        const base = { id: 'x', model: 'model', url: 'http://localhost/v1' };
        const description = c.createCustomModelDescriptionsFromPreferences([base])[0];
        expect(description.apiKey).toBe('vault-key');
        expect(description.enableStreaming).toBe(true);
        expect(c.createCustomModelDescriptionsFromPreferences([{ ...base, apiKey: 'literal' }])[0].apiKey).toBe('literal');
        expect(c.createCustomModelDescriptionsFromPreferences([{ ...base, id: 'unconfigured', apiKey: true }])[0].apiKey).toBe(true);
        expect(c.createCustomModelDescriptionsFromPreferences([{ ...base, apiKey: false }])[0].apiKey).toBeUndefined();
        expect(base).not.toHaveProperty('apiKey');
    });

    it('uses the global flag even when both global and custom vault keys exist', async () => {
        const f = fixture([[account, 'global'], ['custom:x', 'custom']]);
        f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1', apiKey: true }]);
        const { c, manager } = contribution(f);
        c.onStart();
        await c.ready();
        expect(manager.setApiKey).toHaveBeenLastCalledWith('global');
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: true }));
        c.onStop();
    });

    it('injects UI-saved keys immediately after removing old plaintext in both scopes', async () => {
        const f = fixture();
        const { c, manager } = contribution(f);
        c.onStart();
        await c.ready();
        // Add legacy values after startup so this specifically exercises UI cleanup.
        for (const scope of [PreferenceScope.User, PreferenceScope.Workspace]) {
            f.put(prefs.API_KEY_PREF, 'old-global', scope);
            f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1', apiKey: 'old-custom' }], scope);
        }
        await f.settings.save(account, 'new-global');
        await f.settings.save('custom:x', 'new-custom');
        for (const scope of [PreferenceScope.User, PreferenceScope.Workspace]) {
            expect(f.preferences.inspectInScope(prefs.API_KEY_PREF, scope)).toBeUndefined();
            expect(f.preferences.inspectInScope(prefs.CUSTOM_ENDPOINTS_PREF, scope)[0]).not.toHaveProperty('apiKey');
        }
        expect(manager.setApiKey).toHaveBeenLastCalledWith('new-global');
        const updates = manager.createOrUpdateLanguageModels.mock.calls.flat().filter(model => model.id === 'x');
        expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ id: 'x', apiKey: 'new-custom' }));
        c.onStop();
    });

    it('starts with undefined, refreshes on secret changes, preserves other preference handlers and disposes listeners', async () => {
        const f = fixture();
        f.put(prefs.MODELS_PREF, ['old']);
        f.put(prefs.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', model: 'x', url: 'http://localhost/v1' }]);
        const { c, manager, aiChanges } = contribution(f);
        c.onStart();
        c.onStart();
        await c.ready();
        expect(manager.setApiKey).toHaveBeenCalledTimes(1);
        expect(manager.setApiKey).toHaveBeenLastCalledWith(undefined);
        await f.secrets.set(account, 'global');
        expect(manager.setApiKey).toHaveBeenLastCalledWith('global');
        await f.secrets.set('custom:x', 'custom');
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: 'custom' }));
        await f.secrets.delete('custom:x');
        expect(manager.createOrUpdateLanguageModels).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'x', apiKey: undefined }));
        await f.preferences.set(prefs.API_KEY_PREF, undefined, PreferenceScope.User);
        expect(manager.setApiKey).toHaveBeenLastCalledWith('global');
        await f.preferences.set(prefs.MODELS_PREF, ['new'], PreferenceScope.User);
        expect(manager.removeLanguageModels).toHaveBeenCalledWith(`${account}/old`);
        await f.preferences.set('http.proxy', 'http://proxy', PreferenceScope.User);
        expect(manager.setProxyUrl).toHaveBeenLastCalledWith('http://proxy');
        const count = manager.createOrUpdateLanguageModels.mock.calls.length;
        aiChanges.fire({ preferenceName: PREFERENCE_NAME_MAX_RETRIES });
        expect(manager.createOrUpdateLanguageModels.mock.calls.length).toBeGreaterThan(count);
        await f.secrets.delete(account);
        expect(manager.setApiKey).toHaveBeenLastCalledWith(undefined);
        c.onStop();
        const stopped = manager.setApiKey.mock.calls.length;
        await f.secrets.set(account, 'after-stop');
        expect(manager.setApiKey).toHaveBeenCalledTimes(stopped);
    });
});

describe('M9 model discovery and explicit UI edits', () => {
    it.each([false, ''])('does not use custom vault keys for explicit apiKey=%s', async apiKey => {
        const f = fixture([['openai', 'global'], ['custom:unsloth', 'endpoint']]);
        await f.secrets.ready();
        const service = new ProviderSwitchService();
        Object.assign(service, { preferenceService: f.preferences, secretStore: f.secrets });
        expect((service as any).resolveCustomEndpointAuthHeader({ id: 'unsloth', apiKey })).toEqual({});
    });

    it('rejects UI saves without touching either store when persistence is false', async () => {
        const f = fixture([], false);
        f.put(OP.API_KEY_PREF, 'old-global');
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'x', apiKey: 'old-custom' }]);
        await expect(f.settings.save('openai', 'new-global')).rejects.toThrow('OS ');
        await expect(f.settings.save('custom:x', 'new-custom')).rejects.toThrow('OS ');
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('old-global');
        expect(f.preferences.get(OP.CUSTOM_ENDPOINTS_PREF)[0].apiKey).toBe('old-custom');
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        expect(f.preferences.set).not.toHaveBeenCalled();
    });

    it('retries UI save cleanup after a preference write failure', async () => {
        const f = fixture();
        await f.migration.ready();
        f.put(OP.API_KEY_PREF, 'old');
        f.preferences.set.mockRejectedValueOnce(new Error('private'));
        await expect(f.settings.save('openai', 'replacement')).rejects.toThrow();
        expect(f.preferences.get(OP.API_KEY_PREF)).toBe('old');
        await f.settings.save('openai', 'replacement');
        expect(f.preferences.get(OP.API_KEY_PREF)).toBeUndefined();
        expect(f.vault.get('openai')).toBe('replacement');
    });

    it.each([false, true])('uses the vault for /models (global flag: %s)', async globalKey => {
        const f = fixture([['openai', 'global'], ['custom:unsloth', 'endpoint']]);
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'unsloth', url: 'http://localhost/v1', ...(globalKey ? { apiKey: true } : {}) }]);
        const service = new ProviderSwitchService();
        Object.assign(service, { preferenceService: f.preferences, secretStore: f.secrets });
        const original = global.fetch;
        const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
        (global as any).fetch = fetchMock;
        try {
            await service.fetchCustomEndpointModels('unsloth');
            expect(fetchMock).toHaveBeenCalledWith('http://localhost/v1/models', expect.objectContaining({
                headers: { Authorization: `Bearer ${globalKey ? 'global' : 'endpoint'}` }
            }));
        } finally { global.fetch = original; }
    });

    it('explicit save replaces the Unsloth public seed/global flag while migration alone keeps them', async () => {
        const f = fixture();
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'unsloth', apiKey: 'sk-unsloth-local' }, { id: 'x', apiKey: true }]);
        await Promise.all([f.settings.save('custom:unsloth', 'new'), f.settings.save('custom:x', 'other')]);
        expect(f.preferences.get(OP.CUSTOM_ENDPOINTS_PREF)).toEqual([{ id: 'unsloth' }, { id: 'x' }]);
        expect(f.secrets.get('custom:unsloth')).toBe('new');
        await f.settings.delete('custom:unsloth');
        expect(f.vault.has('custom:unsloth')).toBe(false);
    });

    it('shows eight uncontrolled password fields, saves/clears them and reports errors without secrets', async () => {
        const f = fixture([['anthropic', 'never-display']]);
        const dialog = new ArschatApiKeysDialog(f.secrets, f.settings);
        const inputs = dialog.node.querySelectorAll('input');
        const save = dialog.node.querySelector<HTMLButtonElement>('[aria-label="Anthropic のキーを保存"]')!;
        const remove = dialog.node.querySelector<HTMLButtonElement>('[aria-label="Anthropic のキーを削除"]')!;
        try {
            await waitFor(() => expect(save.disabled).toBe(false));
            expect(inputs).toHaveLength(8);
            inputs.forEach(input => { expect(input.type).toBe('password'); expect(input.value).toBe(''); });
            expect(dialog.node.innerHTML).not.toContain('never-display');
            expect(dialog.node.textContent).toContain('保存済み');
            fireEvent.input(inputs[0], { target: { value: 'replacement' } });
            fireEvent.click(save);
            await waitFor(() => expect(inputs[0].value).toBe(''));
            expect(f.vault.get('anthropic')).toBe('replacement');
            fireEvent.click(remove);
            await waitFor(() => expect(f.vault.has('anthropic')).toBe(false));
            await waitFor(() => expect(save.disabled).toBe(false));
            f.keyStore.setPassword.mockRejectedValueOnce(new Error('never-display'));
            fireEvent.input(inputs[0], { target: { value: 'typed-secret' } });
            fireEvent.click(save);
            await waitFor(() => expect(dialog.node.querySelector('[role="alert"]')!.textContent).toContain('失敗'));
            expect(dialog.node.textContent).not.toContain('never-display');
            expect(inputs[0].value).toBe('typed-secret');
        } finally { dialog.dispose(); }
    });

    it('displays the OS credential error and refuses a dialog save without deleting plaintext', async () => {
        const f = fixture([], false);
        f.put(AP.API_KEY_PREF, 'old-private');
        const dialog = new ArschatApiKeysDialog(f.secrets, f.settings);
        const input = dialog.node.querySelector('input')!;
        const save = dialog.node.querySelector<HTMLButtonElement>('[aria-label="Anthropic のキーを保存"]')!;
        try {
            await waitFor(() => expect(save.disabled).toBe(false));
            fireEvent.input(input, { target: { value: 'new-private' } });
            fireEvent.click(save);
            await waitFor(() => expect(dialog.node.querySelector('[role="alert"]')!.textContent)
                .toBe('OS の資格情報マネージャーが使えないため保存できません'));
            expect(f.preferences.get(AP.API_KEY_PREF)).toBe('old-private');
            expect(f.keyStore.setPassword).not.toHaveBeenCalled();
            expect(f.preferences.set).not.toHaveBeenCalled();
            expect(input.value).toBe('new-private');
        } finally { dialog.dispose(); }
    });
});

describe('M9 opt-in autotest with mocked credentials', () => {
    it('returns with opt-in enabled while migration waits for preferences', async () => {
        const f = fixture([['anthropic', 'keep']]);
        const preferencesReady = deferred();
        f.preferences.ready = preferencesReady.promise;
        const c = new ArschatM9AutotestContribution();
        Object.assign(c, { env: { getValue: async () => ({ value: '1' }) }, secrets: f.secrets, preferences: f.preferences,
            migration: f.migration, keychainStatus: f.keychainStatus, anthropic: { ready: async () => undefined } });
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        await c.onStart();
        expect(f.keyStore.setPassword).not.toHaveBeenCalled();
        preferencesReady.resolve();
        await waitFor(() => expect(log).toHaveBeenLastCalledWith('[M9][autotest] SUMMARY 2 PASS / 0 FAIL / 1 SKIP'));
        expect([...f.vault]).toEqual([['anthropic', 'keep']]);
    });

    it('does nothing without backend opt-in', async () => {
        const c = new ArschatM9AutotestContribution();
        const f = fixture();
        Object.assign(c, { env: { getValue: async () => undefined }, secrets: f.secrets });
        await c.onStart();
        expect(f.keyStore.keys).not.toHaveBeenCalled();
    });

    it.each([true, false])('runs autotest and cleans up only owned data (persistent: %s)', async persistent => {
        const f = fixture([['openai', 'keep']], persistent);
        f.put(OP.CUSTOM_ENDPOINTS_PREF, [{ id: 'keep', model: 'keep' }]);
        const c = new ArschatM9AutotestContribution();
        Object.assign(c, { env: { getValue: async () => ({ value: '1' }) }, secrets: f.secrets, preferences: f.preferences,
            migration: f.migration, keychainStatus: f.keychainStatus, anthropic: { ready: async () => undefined, apiKeyInitialized: true } });
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        await c.onStart();
        expect(log).toHaveBeenCalledWith(`[M9][autotest] isPersistent: ${persistent}`);
        await waitFor(() => expect(log).toHaveBeenLastCalledWith(persistent
            ? '[M9][autotest] SUMMARY 3 PASS / 0 FAIL / 0 SKIP'
            : '[M9][autotest] SUMMARY 2 PASS / 0 FAIL / 1 SKIP'));
        if (!persistent) { expect(f.keyStore.setPassword).not.toHaveBeenCalled(); }
        expect([...f.vault]).toEqual([['openai', 'keep']]);
        expect(f.preferences.get(OP.CUSTOM_ENDPOINTS_PREF)).toEqual([{ id: 'keep', model: 'keep' }]);
    });
});

it('rebinds real Theia frontend modules without duplicate aliases and uses injected KeyStoreService', async () => {
    const f = fixture([['anthropic', 'cached'], ['openai', 'cached-openai']]);
    const container = new Container();
    container.bind(KeyStoreService).toConstantValue(f.keyStore);
    container.bind(PreferenceService).toConstantValue(f.preferences);
    container.bind(ILogger).toConstantValue(f.logger);
    const createProxy = jest.fn(() => f.keychainStatus);
    container.bind(RemoteConnectionProvider).toConstantValue({ createProxy });
    container.bind(EnvVariablesServer).toConstantValue({ getValue: async () => undefined });
    container.bind(AICorePreferences).toConstantValue({ get: () => 3, onPreferenceChanged: new Emitter().event });
    container.load(anthropicModule, openaiModule, providersModule);
    const manager = { setApiKey: jest.fn(), setProxyUrl: jest.fn(), createOrUpdateLanguageModels: jest.fn(), removeLanguageModels: jest.fn() };
    container.rebind(AnthropicLanguageModelsManager).toConstantValue(manager);
    container.rebind(OpenAiLanguageModelsManager).toConstantValue(manager);
    // These unrelated contributions need chat/registry services. Keep their real aliases, stub the instances.
    for (const token of [ArschatM2AutotestContribution, ArschatLocalLlmAutotestContribution, ArschatProvidersSeedContribution, CliAgentAutotestContribution]) {
        container.rebind<unknown>(token).toConstantValue({});
    }
    expect(container.get(ArschatKeychainStatusService)).toBe(f.keychainStatus);
    expect(createProxy).toHaveBeenCalledWith(arschatKeychainStatusPath);
    const contributions = container.getAll(FrontendApplicationContribution);
    const anthropic = container.get(AnthropicFrontendApplicationContribution);
    const openai = container.get(OpenAiFrontendApplicationContribution);
    expect(anthropic).toBeInstanceOf(ArschatAnthropicFrontendContribution);
    expect(openai).toBeInstanceOf(ArschatOpenAiFrontendContribution);
    expect(contributions.filter(c => c instanceof AnthropicFrontendApplicationContribution)).toEqual([anthropic]);
    expect(contributions.filter(c => c instanceof OpenAiFrontendApplicationContribution)).toEqual([openai]);
    expect(container.get(AnthropicFrontendApplicationContribution)).toBe(anthropic);
    anthropic.onStart();
    openai.onStart();
    await Promise.all([
        (anthropic as ArschatAnthropicFrontendContribution).ready(),
        (openai as ArschatOpenAiFrontendContribution).ready()
    ]);
    expect(manager.setApiKey.mock.calls).toEqual([['cached'], ['cached-openai']]);
    expect(f.keyStore.keys).toHaveBeenCalledTimes(1);
    (anthropic as ArschatAnthropicFrontendContribution).onStop();
    (openai as ArschatOpenAiFrontendContribution).onStop();
});
