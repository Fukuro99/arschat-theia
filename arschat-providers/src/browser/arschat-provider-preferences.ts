// *****************************************************************************
// ArsChat provider preferences (PHASE1_DESIGN.md §4).
//
// Two concerns live here:
//
// 1. ArsChat's own "active provider / model" preferences. These are what the
//    chat header dropdowns bind to and what ProviderSwitchService reads to
//    decide which registered LanguageModel the ArsChat agent should resolve.
//    We deliberately keep these ArsChat-namespaced (`arschat.provider.*`)
//    rather than reusing a Theia AI preference, because "which provider is
//    active *right now*" is an ArsChat UX concept, not a Theia AI one.
//
// 2. The identifiers/metadata of the providers ArsChat supports (2 cloud +
//    6 local OpenAI-compatible ones, see PROVIDERS below). The *connection*
//    details themselves reuse the existing Theia AI preferences:
//      - Anthropic         -> ai-features.anthropic.*
//      - OpenAI official   -> ai-features.openAiOfficial.*
//      - LM Studio         -> ai-features.openAiCustom.customOpenAiModels[id=lmstudio]
//      - Ollama            -> ai-features.openAiCustom.customOpenAiModels[id=ollama]
//      - vLLM              -> ai-features.openAiCustom.customOpenAiModels[id=vllm]
//      - llama.cpp         -> ai-features.openAiCustom.customOpenAiModels[id=llamacpp]
//      - Unsloth Studio    -> ai-features.openAiCustom.customOpenAiModels[id=unsloth]
//      - OpenAI-compatible -> ai-features.openAiCustom.customOpenAiModels[id=openai-compatible]
//
//    The last six are OpenAI-compatible custom endpoints, so they are registered
//    as entries in the `customOpenAiModels` array with the stable ids above.
//    Because @theia/ai-openai registers custom models under the *raw* `id`
//    (NOT prefixed with `openai/` - verified in
//    openai-frontend-application-contribution.js `createCustomModelDescriptions`),
//    the resulting LanguageModel ids are literally those entry ids.
// *****************************************************************************

import { interfaces } from '@theia/core/shared/inversify';
import { PreferenceContribution, PreferenceProxy, PreferenceService, createPreferenceProxy } from '@theia/core';
import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';

/** ArsChat's active-provider preference key. */
export const PREF_ACTIVE_PROVIDER = 'arschat.provider.active';
/** ArsChat's active-model preference key (the id of a registered LanguageModel). */
export const PREF_ACTIVE_MODEL = 'arschat.provider.model';

/** Theia AI custom-endpoint preference (array) shared by all OpenAI-compatible local endpoints. */
export const OPENAI_CUSTOM_ENDPOINTS_PREF = 'ai-features.openAiCustom.customOpenAiModels';
/** Theia AI official OpenAI models preference (array of model names). */
export const OPENAI_OFFICIAL_MODELS_PREF = 'ai-features.openAiOfficial.officialOpenAiModels';
/** Theia AI Anthropic models preference (array of model names). */
export const ANTHROPIC_MODELS_PREF = 'ai-features.anthropic.AnthropicModels';

/** Stable custom-endpoint ids (== resulting LanguageModel id). */
export const LMSTUDIO_ID = 'lmstudio';
export const OLLAMA_ID = 'ollama';
export const VLLM_ID = 'vllm';
export const LLAMACPP_ID = 'llamacpp';
export const UNSLOTH_ID = 'unsloth';
export const OPENAI_COMPATIBLE_ID = 'openai-compatible';

/** LM Studio's standard local OpenAI-compatible endpoint. */
export const LMSTUDIO_DEFAULT_URL = 'http://localhost:1234/v1';
/** Ollama's OpenAI-compatible endpoint (its native /api endpoints are not used - see the local-llm brief). */
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1';
/** vLLM server's OpenAI-compatible endpoint. */
export const VLLM_DEFAULT_URL = 'http://localhost:8000/v1';
/** llama.cpp server's OpenAI-compatible endpoint. */
export const LLAMACPP_DEFAULT_URL = 'http://localhost:8080/v1';
/** Unsloth Studio's OpenAI-compatible endpoint (localhost:8000, :8888 as fallback - see §4.1). */
export const UNSLOTH_DEFAULT_URL = 'http://localhost:8000/v1';
/** Generic fallback for any other OpenAI-compatible server. */
export const OPENAI_COMPATIBLE_DEFAULT_URL = 'http://localhost:8000/v1';

export type ArschatProviderKind =
    | 'anthropic'
    | 'openai'
    | 'lmstudio'
    | 'ollama'
    | 'vllm'
    | 'llamacpp'
    | 'unsloth'
    | 'openai-compatible'
    | 'codex-cli'
    | 'claude-code-cli';

/** One entry of the shared `ai-features.openAiCustom.customOpenAiModels` array. */
export interface CustomOpenAiModelEntry {
    id?: string;
    model?: string;
    url?: string;
    apiKey?: string | boolean;
    enableStreaming?: boolean;
    developerMessageSettings?: string;
    [k: string]: unknown;
}

export interface ArschatProviderDescriptor {
    /** Stable ArsChat provider key (== value stored in `arschat.provider.active`). */
    readonly kind: ArschatProviderKind;
    /** Human-readable label for the header dropdown. */
    readonly label: string;
    /**
     * How a model name maps to a registered LanguageModel id.
     *  - anthropic: `anthropic/<model>`
     *  - openai:    `openai/<model>`
     *  - custom endpoints: the custom endpoint id itself (single model per endpoint here)
     */
    readonly modelIdFor: (model: string) => string;
    /** Preference key listing this provider's available model names (undefined for custom single-model endpoints). */
    readonly modelsPref?: string;
    /** For custom endpoints: the fixed LanguageModel id used regardless of model name. */
    readonly fixedModelId?: string;
    /** For custom endpoints: the URL used until the user configures the entry. */
    readonly defaultUrl?: string;
    /** For custom endpoints: an API key the local server needs (only Unsloth today). */
    readonly defaultApiKey?: string;
    /** True for the six local OpenAI-compatible endpoints (false/undefined for cloud ones). */
    readonly local?: boolean;
    readonly group?: 'cli';
}

export const PROVIDERS: readonly ArschatProviderDescriptor[] = [
    {
        kind: 'anthropic',
        label: 'Anthropic',
        modelIdFor: model => `anthropic/${model}`,
        modelsPref: ANTHROPIC_MODELS_PREF
    },
    {
        kind: 'openai',
        label: 'OpenAI',
        modelIdFor: model => `openai/${model}`,
        modelsPref: OPENAI_OFFICIAL_MODELS_PREF
    },
    {
        kind: 'lmstudio',
        label: 'LM Studio',
        modelIdFor: () => LMSTUDIO_ID,
        fixedModelId: LMSTUDIO_ID,
        defaultUrl: LMSTUDIO_DEFAULT_URL,
        local: true
    },
    {
        kind: 'ollama',
        label: 'Ollama',
        modelIdFor: () => OLLAMA_ID,
        fixedModelId: OLLAMA_ID,
        defaultUrl: OLLAMA_DEFAULT_URL,
        local: true
    },
    {
        kind: 'vllm',
        label: 'vLLM',
        modelIdFor: () => VLLM_ID,
        fixedModelId: VLLM_ID,
        defaultUrl: VLLM_DEFAULT_URL,
        local: true
    },
    {
        kind: 'llamacpp',
        label: 'llama.cpp',
        modelIdFor: () => LLAMACPP_ID,
        fixedModelId: LLAMACPP_ID,
        defaultUrl: LLAMACPP_DEFAULT_URL,
        local: true
    },
    {
        kind: 'unsloth',
        label: 'Unsloth Studio',
        modelIdFor: () => UNSLOTH_ID,
        fixedModelId: UNSLOTH_ID,
        defaultUrl: UNSLOTH_DEFAULT_URL,
        defaultApiKey: 'sk-unsloth-local',
        local: true
    },
    {
        kind: 'openai-compatible',
        label: 'OpenAI 互換 (その他)',
        modelIdFor: () => OPENAI_COMPATIBLE_ID,
        fixedModelId: OPENAI_COMPATIBLE_ID,
        defaultUrl: OPENAI_COMPATIBLE_DEFAULT_URL,
        local: true
    },
    { kind: 'codex-cli', label: 'Codex (CLI)', modelIdFor: () => 'codex-cli', fixedModelId: 'codex-cli', group: 'cli' },
    { kind: 'claude-code-cli', label: 'Claude Code (CLI)', modelIdFor: () => 'claude-code-cli', fixedModelId: 'claude-code-cli', group: 'cli' }
];

export function providerByKind(kind: string): ArschatProviderDescriptor | undefined {
    return PROVIDERS.find(p => p.kind === kind);
}

/** The providers backed by an entry in the shared customOpenAiModels array, in display order. */
export function customEndpointProviders(): readonly ArschatProviderDescriptor[] {
    return PROVIDERS.filter(p => !!p.fixedModelId && p.group !== 'cli');
}

/** The default customOpenAiModels entry for a custom-endpoint provider (undefined for cloud ones). */
export function defaultCustomEndpointFor(kind: ArschatProviderKind): CustomOpenAiModelEntry | undefined {
    const provider = providerByKind(kind);
    if (!provider?.fixedModelId || !provider.defaultUrl) {
        return undefined;
    }
    const entry: CustomOpenAiModelEntry = {
        id: provider.fixedModelId,
        // A generic placeholder model name; the local server serves whatever model is loaded.
        model: 'local-model',
        url: provider.defaultUrl,
        enableStreaming: true,
        developerMessageSettings: 'system'
    };
    if (provider.defaultApiKey) {
        entry.apiKey = provider.defaultApiKey;
    }
    return entry;
}

export const arschatProviderPreferenceSchema: PreferenceSchema = {
    properties: {
        [PREF_ACTIVE_PROVIDER]: {
            type: 'string',
            enum: PROVIDERS.map(p => p.kind),
            default: 'anthropic',
            description: 'ArsChat: the currently active LLM provider. Switched live from the chat header.'
        },
        [PREF_ACTIVE_MODEL]: {
            type: 'string',
            default: '',
            description: 'ArsChat: the id of the currently active registered LanguageModel (resolved from the active provider + selected model).'
        }
    }
};

export interface ArschatProviderPreferences {
    [PREF_ACTIVE_PROVIDER]: string;
    [PREF_ACTIVE_MODEL]: string;
}

export const ArschatProviderPreferences = Symbol('ArschatProviderPreferences');

export function bindArschatProviderPreferences(bind: interfaces.Bind): void {
    bind(PreferenceContribution).toConstantValue({ schema: arschatProviderPreferenceSchema });
    bind(ArschatProviderPreferences).toDynamicValue(ctx =>
        createPreferenceProxy(ctx.container.get(PreferenceService), arschatProviderPreferenceSchema)
    ).inSingletonScope();
}

export type ArschatProviderPreferenceProxy = PreferenceProxy<ArschatProviderPreferences>;
