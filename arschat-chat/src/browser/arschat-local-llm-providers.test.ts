import 'reflect-metadata';
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

function makeSeedService(endpoints: CustomOpenAiModelEntry[]): { contribution: ArschatProvidersSeedContribution, written: CustomOpenAiModelEntry[][] } {
    const written: CustomOpenAiModelEntry[][] = [];
    const contribution = new ArschatProvidersSeedContribution() as any;
    contribution.preferenceService = {
        ready: Promise.resolve(),
        get: (key: string, defaultValue?: unknown) => key === OPENAI_CUSTOM_ENDPOINTS_PREF ? endpoints : defaultValue,
        updateValue: jest.fn(async (_key: string, value: CustomOpenAiModelEntry[]) => { written.push(value); })
    };
    contribution.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { contribution: contribution as ArschatProvidersSeedContribution, written };
}

describe('ProviderSwitchService local LLM providers', () => {

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
            updateValue: jest.fn(async (_key: string, value: CustomOpenAiModelEntry[]) => { stored.length = 0; stored.push(...value); })
        };

        const normalized = await service.updateCustomEndpointUrl('vllm', 'http://192.168.1.149:8000');

        expect(normalized).toBe('http://192.168.1.149:8000/v1');
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
            set: jest.fn(async (key: string, value: unknown) => { preferences.set(key, value); }),
            updateValue: jest.fn(async (key: string, value: unknown) => { preferences.set(key, value); })
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
    });

    it('seeds the missing local endpoints and keeps existing entries untouched', async () => {
        const lmstudio = { id: 'lmstudio', model: 'my-model', url: 'http://192.168.1.149:1234/v1', apiKey: 'secret' };
        const { contribution, written } = makeSeedService([lmstudio]);

        await contribution.onStart();

        expect(written).toHaveLength(1);
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

    it('does not write anything when every local endpoint is already registered', async () => {
        const { contribution, written } = makeSeedService([
            { id: 'ollama' }, { id: 'vllm' }, { id: 'llamacpp' }, { id: 'unsloth' }, { id: 'openai-compatible' }, { id: 'lmstudio' }
        ] as CustomOpenAiModelEntry[]);

        await contribution.onStart();

        expect(written).toHaveLength(0);
    });
});
