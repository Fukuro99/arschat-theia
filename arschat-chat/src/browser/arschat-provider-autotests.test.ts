import 'reflect-metadata';
import { PreferenceScope } from '@theia/core';
import { ArschatM2AutotestContribution } from 'arschat-providers/lib/browser/arschat-m2-autotest-contribution';
import { ArschatLocalLlmAutotestContribution } from 'arschat-providers/lib/browser/arschat-local-llm-autotest-contribution';
import {
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    customEndpointProviders,
    defaultCustomEndpointFor
} from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';

describe.each(customEndpointProviders().map(provider => provider.kind))('M2 model selection for %s', kind => {
    it.each(['qwen3.8-flash-next', '', 'local-model'])('preserves or discovers the actual model when configured as %p', async configuredModel => {
        const preferences = new Map<string, unknown>([
            [OPENAI_CUSTOM_ENDPOINTS_PREF, [{ ...defaultCustomEndpointFor(kind), model: configuredModel }]]
        ]);
        const service = new ProviderSwitchService() as any;
        service.preferenceService = {
            get: (key: string, fallback?: unknown) => preferences.has(key) ? preferences.get(key) : fallback,
            set: jest.fn(async (key: string, value: unknown, _scope?: PreferenceScope) => { preferences.set(key, value); })
        };
        service.settingsService = { updateAgentSettings: jest.fn(async () => undefined) };
        service.languageModelRegistry = { getLanguageModels: jest.fn(async () => []) };
        service.logger = { info: jest.fn(), warn: jest.fn() };
        service.fetchCustomEndpointModels = jest.fn(async () => ['discovered-model', 'second-model']);
        const contribution = new ArschatM2AutotestContribution() as any;
        contribution.switchService = service;

        const model = await contribution.pickModelName(kind, [{ id: kind }]);
        const selection = await service.setActive(kind, model);

        const expected = configuredModel === 'qwen3.8-flash-next' ? configuredModel : 'discovered-model';
        expect(model).toBe(expected);
        expect(selection).toEqual({ provider: kind, model: expected, modelId: kind });
        expect(service.getCustomEndpointModel(kind)).toBe(expected);
        if (configuredModel === 'qwen3.8-flash-next') {
            expect(service.fetchCustomEndpointModels).not.toHaveBeenCalled();
        } else {
            expect(service.fetchCustomEndpointModels).toHaveBeenCalledWith(kind);
        }
    });

    it('does not substitute the fixed ID when the endpoint has no models', async () => {
        const contribution = new ArschatM2AutotestContribution() as any;
        contribution.switchService = {
            getCustomEndpointModel: () => 'local-model',
            fetchCustomEndpointModels: jest.fn(async () => [])
        };
        expect(await contribution.pickModelName(kind, [{ id: kind }])).toBeUndefined();
    });
});

it.each(['openai', 'anthropic'])('keeps cloud model selection for %s', async kind => {
    const contribution = new ArschatM2AutotestContribution() as any;
    expect(await contribution.pickModelName(kind, [{ id: `${kind}/cloud-model` }])).toBe('cloud-model');
    expect(await contribution.pickModelName(kind, [])).toBeUndefined();
});

describe('local LLM autotest select validation', () => {
    it.each([
        ['vllm', 'vllm', true, 'PASS'],
        ['ollama', 'vllm', true, 'FAIL'],
        ['vllm', 'ollama', true, 'FAIL'],
        ['vllm', 'vllm', false, 'FAIL']
    ])('checks provider=%s, modelId=%s and registration=%s', async (provider, modelId, registered, expected) => {
        const contribution = new ArschatLocalLlmAutotestContribution() as any;
        contribution.getBackendEnv = async () => undefined;
        contribution.switchService = {
            updateCustomEndpointUrl: async (_kind: string, url: string) => url,
            fetchCustomEndpointModels: async () => ['qwen3.8-flash-next'],
            setActive: async () => ({ provider, modelId, model: 'qwen3.8-flash-next' })
        };
        contribution.waitForRegisteredModel = async () => registered;
        contribution.roundTrip = async () => 'PONG 東京';
        contribution.log = jest.fn();

        await contribution.run();

        expect(contribution.log).toHaveBeenCalledWith(expect.stringContaining(`select: ${expected} -`));
        expect(contribution.log).toHaveBeenCalledWith(expected === 'PASS' ? 'SUMMARY 5 PASS / 0 FAIL' : 'SUMMARY 4 PASS / 1 FAIL');
    });
});
