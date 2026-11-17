// *****************************************************************************
// ArsChat providers seed contribution (PHASE1_DESIGN.md §4.1).
//
// On startup, ensures every ArsChat custom-endpoint provider (LM Studio /
// Ollama / vLLM / llama.cpp / Unsloth Studio / generic OpenAI-compatible)
// exists as an entry in the shared Theia AI
// `ai-features.openAiCustom.customOpenAiModels` array, with its stable id and
// default URL. We only ADD missing entries - we never overwrite a user's edits
// to an existing entry, so the user can freely change the URL / model / apiKey
// afterwards.
//
// This is what makes all of ArsChat's providers configurable out of the box:
// the custom-endpoint ones are OpenAI-compatible local servers and would
// otherwise require the user to hand-author JSON. Anthropic and official OpenAI
// already ship default model lists in their own packages.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ILogger, PreferenceService } from '@theia/core';
import {
    CustomOpenAiModelEntry,
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    customEndpointProviders,
    defaultCustomEndpointFor
} from './arschat-provider-preferences';

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
        for (const provider of customEndpointProviders()) {
            const id = provider.fixedModelId;
            if (!id || byId.has(id)) {
                continue;
            }
            const seed = defaultCustomEndpointFor(provider.kind);
            if (seed) {
                seeds.push(seed);
            }
        }

        if (seeds.length === 0) {
            this.logger.info('[arschat-providers] custom endpoints already present, no seeding needed');
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
