// *****************************************************************************
// ArsChat providers seed contribution (PHASE1_DESIGN.md §4.1).
//
// On startup, ensures LM Studio and Unsloth Studio exist as entries in the
// shared Theia AI `ai-features.openAiCustom.customOpenAiModels` array (with
// stable ids `lmstudio` / `unsloth` and sensible default URLs). We only ADD
// missing entries - we never overwrite a user's edits to an existing entry, so
// the user can freely change the URL / model / apiKey afterwards.
//
// This is what makes "4 providers are configurable" true out of the box: two
// of the four (LM Studio, Unsloth) are OpenAI-compatible custom endpoints and
// would otherwise require the user to hand-author JSON. Anthropic and official
// OpenAI already ship default model lists in their own packages.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ILogger, PreferenceService } from '@theia/core';
import {
    LMSTUDIO_DEFAULT_URL,
    LMSTUDIO_ID,
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    UNSLOTH_DEFAULT_URL,
    UNSLOTH_ID
} from './arschat-provider-preferences';

interface CustomOpenAiModelEntry {
    id?: string;
    model?: string;
    url?: string;
    apiKey?: string | boolean;
    enableStreaming?: boolean;
    developerMessageSettings?: string;
    [k: string]: unknown;
}

@injectable()
export class ArschatProvidersSeedContribution implements FrontendApplicationContribution {

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    async onStart(): Promise<void> {
        await this.preferenceService.ready;
        const existing = this.preferenceService.get<CustomOpenAiModelEntry[]>(OPENAI_CUSTOM_ENDPOINTS_PREF, []) ?? [];
        const byId = new Set(existing.map(e => (typeof e.id === 'string' ? e.id : e.model)));

        const seeds: CustomOpenAiModelEntry[] = [];
        if (!byId.has(LMSTUDIO_ID)) {
            seeds.push({
                id: LMSTUDIO_ID,
                // A generic placeholder model name; the local server serves whatever model is loaded.
                model: 'local-model',
                url: LMSTUDIO_DEFAULT_URL,
                enableStreaming: true,
                developerMessageSettings: 'system'
            });
        }
        if (!byId.has(UNSLOTH_ID)) {
            seeds.push({
                id: UNSLOTH_ID,
                model: 'local-model',
                url: UNSLOTH_DEFAULT_URL,
                // Unsloth Studio requires a Bearer token; users replace this with their real sk-unsloth-... key.
                apiKey: 'sk-unsloth-local',
                enableStreaming: true,
                developerMessageSettings: 'system'
            });
        }

        if (seeds.length === 0) {
            this.logger.info('[arschat-providers] custom endpoints already present (lmstudio/unsloth), no seeding needed');
            return;
        }

        const merged = [...existing, ...seeds];
        try {
            await this.preferenceService.updateValue(OPENAI_CUSTOM_ENDPOINTS_PREF, merged);
            this.logger.info(`[arschat-providers] seeded custom OpenAI endpoints: ${seeds.map(s => s.id).join(', ')}`);
        } catch (e: unknown) {
            this.logger.warn(`[arschat-providers] failed to seed custom endpoints: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
