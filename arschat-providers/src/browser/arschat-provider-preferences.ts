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
// 2. The identifiers/metadata of the four providers ArsChat supports. The
//    *connection* details themselves reuse the existing Theia AI preferences
//    (see PROVIDERS below):
//      - Anthropic       -> ai-features.anthropic.*
//      - OpenAI official -> ai-features.openAiOfficial.*
//      - LM Studio       -> ai-features.openAiCustom.customOpenAiModels[id=lmstudio]
//      - Unsloth Studio  -> ai-features.openAiCustom.customOpenAiModels[id=unsloth]
//
//    LM Studio / Unsloth are OpenAI-compatible custom endpoints, so they are
//    registered as entries in the `customOpenAiModels` array with stable ids
//    `lmstudio` / `unsloth`. Because @theia/ai-openai registers custom models
//    under the *raw* `id` (NOT prefixed with `openai/` - verified in
//    openai-frontend-application-contribution.js `createCustomModelDescriptions`),
//    the resulting LanguageModel ids are literally `lmstudio` / `unsloth`.
// *****************************************************************************

import { interfaces } from '@theia/core/shared/inversify';
import { PreferenceContribution, PreferenceProxy, PreferenceService, createPreferenceProxy } from '@theia/core';
import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';

/** ArsChat's active-provider preference key. */
export const PREF_ACTIVE_PROVIDER = 'arschat.provider.active';
/** ArsChat's active-model preference key (the id of a registered LanguageModel). */
export const PREF_ACTIVE_MODEL = 'arschat.provider.model';

/** Theia AI custom-endpoint preference (array) shared by LM Studio + Unsloth. */
export const OPENAI_CUSTOM_ENDPOINTS_PREF = 'ai-features.openAiCustom.customOpenAiModels';
/** Theia AI official OpenAI models preference (array of model names). */
export const OPENAI_OFFICIAL_MODELS_PREF = 'ai-features.openAiOfficial.officialOpenAiModels';
/** Theia AI Anthropic models preference (array of model names). */
export const ANTHROPIC_MODELS_PREF = 'ai-features.anthropic.AnthropicModels';

/** Stable custom-endpoint ids (== resulting LanguageModel id). */
export const LMSTUDIO_ID = 'lmstudio';
export const UNSLOTH_ID = 'unsloth';

/** LM Studio's standard local OpenAI-compatible endpoint. */
export const LMSTUDIO_DEFAULT_URL = 'http://localhost:1234/v1';
/** Unsloth Studio's OpenAI-compatible endpoint (localhost:8000, :8888 as fallback - see §4.1). */
export const UNSLOTH_DEFAULT_URL = 'http://localhost:8000/v1';

export type ArschatProviderKind = 'anthropic' | 'openai' | 'lmstudio' | 'unsloth';

export interface ArschatProviderDescriptor {
    /** Stable ArsChat provider key (== value stored in `arschat.provider.active`). */
    readonly kind: ArschatProviderKind;
    /** Human-readable label for the header dropdown. */
    readonly label: string;
    /**
     * How a model name maps to a registered LanguageModel id.
     *  - anthropic: `anthropic/<model>`
     *  - openai:    `openai/<model>`
     *  - lmstudio/unsloth: the custom endpoint id itself (single model per endpoint here)
     */
    readonly modelIdFor: (model: string) => string;
    /** Preference key listing this provider's available model names (undefined for custom single-model endpoints). */
    readonly modelsPref?: string;
    /** For custom endpoints: the fixed LanguageModel id used regardless of model name. */
    readonly fixedModelId?: string;
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
        fixedModelId: LMSTUDIO_ID
    },
    {
        kind: 'unsloth',
        label: 'Unsloth Studio',
        modelIdFor: () => UNSLOTH_ID,
        fixedModelId: UNSLOTH_ID
    }
];

export function providerByKind(kind: string): ArschatProviderDescriptor | undefined {
    return PROVIDERS.find(p => p.kind === kind);
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
