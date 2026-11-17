import 'reflect-metadata';
import { waitFor } from '@testing-library/react';
import { PreferenceScope } from '@theia/core';
import { ArschatProvidersSeedContribution } from 'arschat-providers/lib/browser/arschat-providers-seed-contribution';
import {
    CustomOpenAiModelEntry,
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    PREF_ACTIVE_MODEL,
    PREF_ACTIVE_PROVIDER,
    PROVIDERS,
    customEndpointProviders,
    defaultCustomEndpointFor
} from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';

function makeSeedService(endpoints: CustomOpenAiModelEntry[], ready = Promise.resolve()) {
    const written: CustomOpenAiModelEntry[][] = [];
    const set = jest.fn(async (_key: string, value: CustomOpenAiModelEntry[], _scope?: PreferenceScope) => { written.push(value); });
    const contribution = new ArschatProvidersSeedContribution() as any;
    contribution.preferenceService = {
        ready,
        get: (key: string, defaultValue?: unknown) => key === OPENAI_CUSTOM_ENDPOINTS_PREF ? endpoints : defaultValue,
        set
    };
    contribution.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { contribution: contribution as ArschatProvidersSeedContribution, written, set, logger: contribution.logger };
}

describe('ProviderSwitchService local LLM providers', () => {

    it('returns before preferences are ready and seeds only after a later contribution resolves them', async () => {
        let resolve!: () => void;
        const ready = new Promise<void>(done => { resolve = done; });
        const existing = { id: 'lmstudio', model: 'user-model', apiKey: 'user-key' };
        const { contribution, written, set } = makeSeedService([existing], ready);
        expect(contribution.onStart()).toBeUndefined();
        await Promise.resolve();
        expect(set).not.toHaveBeenCalled();
        resolve();
        await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
        expect(written[0][0]).toEqual(existing);
        expect(written[0]).toHaveLength(customEndpointProviders().length);
    });

    it.each(['readiness', 'write'])('logs a sanitized warning on %s failure', async failure => {
        let reject!: (error: Error) => void;
        const ready = failure === 'readiness'
            ? new Promise<void>((_resolve, fail) => { reject = fail; }) : Promise.resolve();
        const { contribution, set, logger } = makeSeedService([], ready);
        const error = new Error('private-key-in-error');
        if (failure === 'write') { set.mockRejectedValue(error); }
        contribution.onStart();
        if (failure === 'readiness') { reject(error); }
        await waitFor(() => expect(logger.warn.mock.calls).toEqual([
            ['[arschat-providers] failed to seed custom endpoints']
        ]));
    });

    it.each([
        ['no open workspace', false, false, false],
        ['an empty workspace', true, false, false],
        ['existing User settings', true, true, false],
        ['existing workspace settings', true, false, true]
    ] as const)('writes selections and endpoints only to User settings with %s', async (_label, workspaceOpen, existingUser, existingWorkspace) => {
        const endpoint = { id: 'lmstudio', model: 'saved-model', url: 'http://localhost:1234/v1', apiKey: 'saved-key' };
        const initial = (): Array<[string, unknown]> => [
            [PREF_ACTIVE_PROVIDER, 'lmstudio'],
            [PREF_ACTIVE_MODEL, 'saved-model'],
            [OPENAI_CUSTOM_ENDPOINTS_PREF, [endpoint]]
        ];
        const user = new Map<string, unknown>(existingUser ? initial() : []);
        const workspace = new Map<string, unknown>(existingWorkspace ? initial() : []);
        const workspaceBefore = new Map(workspace);
        const preferences = {
            ready: Promise.resolve(),
            get: (key: string, fallback?: unknown) => workspace.get(key) ?? user.get(key) ?? fallback,
            set: jest.fn(async (key: string, value: unknown, scope: PreferenceScope = PreferenceScope.Workspace) => {
                // Reproduce Theia's default scope and failure when no folder is open.
                if (scope === PreferenceScope.Workspace && !workspaceOpen) {
                    throw new Error('Unable to write to Workspace Settings.');
                }
                (scope === PreferenceScope.User ? user : workspace).set(key, value);
            })
        };
        const logger = { info: jest.fn(), warn: jest.fn() };
        const seed = new ArschatProvidersSeedContribution() as any;
        seed.preferenceService = preferences;
        seed.logger = logger;
        await seed.onStart();
        expect(preferences.set).toHaveBeenLastCalledWith(OPENAI_CUSTOM_ENDPOINTS_PREF, expect.any(Array), PreferenceScope.User);
        expect(user.get(OPENAI_CUSTOM_ENDPOINTS_PREF)).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'lmstudio', model: existingUser || existingWorkspace ? 'saved-model' : 'local-model' })
        ]));

        const service = new ProviderSwitchService() as any;
        service.preferenceService = preferences;
        service.logger = logger;
        await service.updateCustomEndpointUrl('lmstudio', 'http://localhost:9999');
        expect(preferences.set).toHaveBeenLastCalledWith(OPENAI_CUSTOM_ENDPOINTS_PREF, expect.arrayContaining([
            expect.objectContaining({ id: 'lmstudio', url: 'http://localhost:9999/v1', ...(existingUser || existingWorkspace ? { apiKey: 'saved-key' } : {}) })
        ]), PreferenceScope.User);
        await service.setActive('openai', 'first-model');
        expect(user.get(PREF_ACTIVE_PROVIDER)).toBe('openai');
        expect(user.get(PREF_ACTIVE_MODEL)).toBe('first-model');
        await service.setActiveModel('second-model');
        expect(preferences.set).toHaveBeenLastCalledWith(PREF_ACTIVE_MODEL, 'second-model', PreferenceScope.User);
        expect(user.get(PREF_ACTIVE_MODEL)).toBe('second-model');
        expect(preferences.set.mock.calls.every(([, , scope]) => scope === PreferenceScope.User)).toBe(true);
        expect(workspace).toEqual(workspaceBefore);
    });

    it('lists the eight providers in the documented order, custom-endpoint ones in seed order', () => {
        expect(PROVIDERS.map(p => p.kind)).toEqual([
            'anthropic', 'openai', 'lmstudio', 'ollama', 'vllm', 'llamacpp', 'unsloth', 'openai-compatible'
        ]);
        expect(customEndpointProviders().map(p => p.kind)).toEqual([
            'lmstudio', 'ollama', 'vllm', 'llamacpp', 'unsloth', 'openai-compatible'
        ]);
        expect(PROVIDERS.filter(p => p.local).map(p => p.kind)).toEqual([
            'lmstudio', 'ollama', 'vllm', 'llamacpp', 'unsloth', 'openai-compatible'
        ]);
    });

    it('keeps the lmstudio / unsloth default endpoints unchanged', () => {
        expect(defaultCustomEndpointFor('lmstudio')).toEqual({
            id: 'lmstudio',
            model: 'local-model',
            url: 'http://localhost:1234/v1',
            enableStreaming: true,
            developerMessageSettings: 'system'
        });
        expect(defaultCustomEndpointFor('unsloth')).toEqual({
            id: 'unsloth',
            model: 'local-model',
            url: 'http://localhost:8000/v1',
            apiKey: 'sk-unsloth-local',
            enableStreaming: true,
            developerMessageSettings: 'system'
        });
    });

    it('gives the four new local providers their documented default URLs and no API key', () => {
        const expected: Array<[string, string]> = [
            ['ollama', 'http://localhost:11434/v1'],
            ['vllm', 'http://localhost:8000/v1'],
            ['llamacpp', 'http://localhost:8080/v1'],
            ['openai-compatible', 'http://localhost:8000/v1']
        ];
        for (const [kind, url] of expected) {
            const entry = defaultCustomEndpointFor(kind as never);
            expect(entry).toEqual({
                id: kind,
                model: 'local-model',
                url,
                enableStreaming: true,
                developerMessageSettings: 'system'
            });
            expect(entry!.apiKey).toBeUndefined();
        }
    });

    it('defaults a fresh ollama endpoint to the Ollama URL', () => {
        const service = new ProviderSwitchService() as any;
        service.preferenceService = { get: (_key: string, defaultValue?: unknown) => defaultValue };
        expect(service.getCustomEndpointUrl('ollama')).toBe('http://localhost:11434/v1');
    });

    it('writes a vllm entry into the shared customOpenAiModels array without touching lmstudio', async () => {
        const stored: CustomOpenAiModelEntry[] = [{
            id: 'lmstudio',
            model: 'qwen/qwen3.6-35b-a3b',
            url: 'http://192.168.1.149:1234/v1'
        }];
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => key === OPENAI_CUSTOM_ENDPOINTS_PREF ? stored : defaultValue,
            set: jest.fn(async (_key: string, value: CustomOpenAiModelEntry[], _scope?: PreferenceScope) => { stored.length = 0; stored.push(...value); })
        };

        const normalized = await service.updateCustomEndpointUrl('vllm', 'http://192.168.1.149:8000');

        expect(normalized).toBe('http://192.168.1.149:8000/v1');
        expect(service.preferenceService.set).toHaveBeenCalledWith(OPENAI_CUSTOM_ENDPOINTS_PREF, stored, PreferenceScope.User);
        expect(stored).toHaveLength(2);
        expect(stored).toEqual(expect.arrayContaining([
            { id: 'lmstudio', model: 'qwen/qwen3.6-35b-a3b', url: 'http://192.168.1.149:1234/v1' },
            expect.objectContaining({ id: 'vllm', url: 'http://192.168.1.149:8000/v1' })
        ]));
    });

    it('resolves setActive for a custom-endpoint provider to its fixed model id', async () => {
        const preferences = new Map<string, unknown>();
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, defaultValue?: unknown) => preferences.has(key) ? preferences.get(key) : defaultValue,
            set: jest.fn(async (key: string, value: unknown, _scope?: PreferenceScope) => { preferences.set(key, value); })
        };
        service.settingsService = { updateAgentSettings: jest.fn(async () => undefined) };
        service.languageModelRegistry = { getLanguageModels: jest.fn(async () => []) };
        service.logger = { info: jest.fn(), warn: jest.fn() };

        const selection = await service.setActive('ollama', 'qwen3:8b');

        expect(selection).toEqual({ provider: 'ollama', model: 'qwen3:8b', modelId: 'ollama' });
        expect(preferences.get(PREF_ACTIVE_PROVIDER)).toBe('ollama');
        expect(preferences.get(PREF_ACTIVE_MODEL)).toBe('qwen3:8b');
        expect(preferences.get(OPENAI_CUSTOM_ENDPOINTS_PREF)).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'ollama', model: 'qwen3:8b' })
        ]));
        expect(service.preferenceService.set.mock.calls).toEqual([
            [PREF_ACTIVE_PROVIDER, 'ollama', PreferenceScope.User],
            [OPENAI_CUSTOM_ENDPOINTS_PREF, preferences.get(OPENAI_CUSTOM_ENDPOINTS_PREF), PreferenceScope.User],
            [PREF_ACTIVE_MODEL, 'qwen3:8b', PreferenceScope.User]
        ]);
    });

    it('seeds the missing local endpoints and keeps existing entries untouched', async () => {
        const lmstudio = { id: 'lmstudio', model: 'my-model', url: 'http://192.168.1.149:1234/v1', apiKey: 'secret' };
        const { contribution, written, set } = makeSeedService([lmstudio]);

        await contribution.onStart();

        expect(written).toHaveLength(1);
        expect(set).toHaveBeenCalledWith(OPENAI_CUSTOM_ENDPOINTS_PREF, written[0], PreferenceScope.User);
        expect(written[0]).toHaveLength(6);
        // The existing lmstudio entry keeps the user's edits.
        expect(written[0][0]).toEqual(lmstudio);
        const seeded = written[0].slice(1);
        expect(seeded.map(e => e.id)).toEqual(['ollama', 'vllm', 'llamacpp', 'unsloth', 'openai-compatible']);
        expect(seeded.find(e => e.id === 'ollama')).toEqual({
            id: 'ollama', model: 'local-model', url: 'http://localhost:11434/v1', enableStreaming: true, developerMessageSettings: 'system'
        });
        expect(seeded.find(e => e.id === 'unsloth')).toEqual({
            id: 'unsloth', model: 'local-model', url: 'http://localhost:8000/v1', apiKey: 'sk-unsloth-local', enableStreaming: true, developerMessageSettings: 'system'
        });
    });

    it('seeds fresh preferences explicitly in User settings', async () => {
        const { contribution, written, set } = makeSeedService([]);

        await contribution.onStart();

        expect(written).toHaveLength(1);
        expect(written[0]).toHaveLength(customEndpointProviders().length);
        expect(set).toHaveBeenCalledWith(OPENAI_CUSTOM_ENDPOINTS_PREF, written[0], PreferenceScope.User);
    });

    it('does not write anything when every local endpoint is already registered', async () => {
        const { contribution, written } = makeSeedService([
            { id: 'ollama' }, { id: 'vllm' }, { id: 'llamacpp' }, { id: 'unsloth' }, { id: 'openai-compatible' }, { id: 'lmstudio' }
        ] as CustomOpenAiModelEntry[]);

        await contribution.onStart();

        expect(written).toHaveLength(0);
    });
});
