// *****************************************************************************
// ArsChat ProviderSwitchService (PHASE1_DESIGN.md §4.2).
//
// The single choke point that turns "the user picked provider X / model Y in
// the header" into "the ArsChat chat agent resolves LanguageModel Z".
//
// ---- §10 risk resolution (does the agent auto-read AISettingsService?) ----
//
// Reading node_modules (read-only) settled the open question in §4.2/§10:
//
//   frontend-language-model-registry.js `selectLanguageModels()`:
//       const userSettings = (await this.settingsService
//           .getAgentSettings(request.agent))
//           ?.languageModelRequirements?.find(req => req.purpose === request.purpose);
//       const identifier = userSettings?.identifier ?? request.identifier;
//
//   chat-agents.js `AbstractChatAgent`:
//       getLanguageModelSelector(purpose) {
//           return this.languageModelRequirements.find(r => r.purpose === purpose);
//       }
//       selectLanguageModel(selector) {
//           return this.languageModelRegistry.selectLanguageModel({ agent: this.id, ...selector });
//       }
//
// So on the FRONTEND registry, AISettingsService.updateAgentSettings(...
// languageModelRequirements) IS read automatically and TAKES PRECEDENCE over
// the agent's own instance-field selector (its `identifier` wins via `??`).
// That is the officially-wired path. The agent instance field is only the
// fallback when settings don't specify an identifier for that purpose.
//
// We therefore drive BOTH (belt-and-suspenders, and to keep working even if a
// future Community Release changes the precedence):
//   (a) AISettingsService.updateAgentSettings(agentId, { languageModelRequirements })
//       - the path the registry natively consults;
//   (b) the live agent instance's `languageModelRequirements` field
//       - the fallback the base class reads directly.
// *****************************************************************************

import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, ILogger, PreferenceService } from '@theia/core';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelRequirement
} from '@theia/ai-core';
import {
    ArschatProviderKind,
    PREF_ACTIVE_MODEL,
    PREF_ACTIVE_PROVIDER,
    PROVIDERS,
    providerByKind
} from './arschat-provider-preferences';

/** The purpose all ArsChat chat requests use. */
export const ARSCHAT_CHAT_PURPOSE = 'chat';

/**
 * The stable id/name of the ArsChat chat agent (defined here in arschat-providers
 * so both the agent implementation (arschat-agents) and the M2 autotest can share
 * it without a circular dependency - arschat-agents already depends on providers).
 */
export const ARSCHAT_CHAT_AGENT_ID = 'ArsChat';

export interface ArschatActiveSelection {
    provider: ArschatProviderKind;
    /** The user-facing model name (for anthropic/openai) or the endpoint id (lmstudio/unsloth). */
    model: string;
    /** The resolved registered LanguageModel id the agent should use. */
    modelId: string;
}

@injectable()
export class ProviderSwitchService {

    /** The id of the ArsChat chat agent whose model requirement we drive. Set by arschat-agents at registration time. */
    protected agentId: string | undefined;
    /** Live agent instance whose `languageModelRequirements` we also patch directly (fallback path). */
    protected agentInstance: { languageModelRequirements: LanguageModelRequirement[] } | undefined;

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    @inject(AISettingsService)
    protected readonly settingsService!: AISettingsService;

    @inject(LanguageModelRegistry)
    protected readonly languageModelRegistry!: LanguageModelRegistry;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected readonly onDidChangeEmitter = new Emitter<ArschatActiveSelection>();
    get onDidChange(): Event<ArschatActiveSelection> {
        return this.onDidChangeEmitter.event;
    }

    @postConstruct()
    protected init(): void {
        this.preferenceService.ready.then(() => {
            // Re-apply whenever the active provider/model preference changes (e.g. from the header dropdown).
            this.preferenceService.onPreferenceChanged(event => {
                if ((event.preferenceName as string) === PREF_ACTIVE_PROVIDER || (event.preferenceName as string) === PREF_ACTIVE_MODEL) {
                    this.applyActiveSelection();
                }
            });
        });
    }

    /**
     * Called by arschat-agents right after it registers the ArsChat chat agent,
     * so the switch service knows which agent's requirements to drive.
     */
    registerAgent(agentId: string, agentInstance: { languageModelRequirements: LanguageModelRequirement[] }): void {
        this.agentId = agentId;
        this.agentInstance = agentInstance;
        // Apply the persisted selection now that we have an agent to drive.
        this.preferenceService.ready.then(() => this.applyActiveSelection());
    }

    getActiveProvider(): ArschatProviderKind {
        const raw = this.preferenceService.get<string>(PREF_ACTIVE_PROVIDER, 'anthropic');
        return (providerByKind(raw)?.kind) ?? 'anthropic';
    }

    getActiveModel(): string {
        return this.preferenceService.get<string>(PREF_ACTIVE_MODEL, '') ?? '';
    }

    /** Resolve the registered LanguageModel id for the current provider + model preference. */
    resolveActiveModelId(): string | undefined {
        const provider = providerByKind(this.getActiveProvider());
        if (!provider) {
            return undefined;
        }
        if (provider.fixedModelId) {
            return provider.fixedModelId;
        }
        const model = this.getActiveModel();
        if (!model) {
            return undefined;
        }
        return provider.modelIdFor(model);
    }

    /**
     * Set the active provider (and optionally model), persist to preferences, and
     * re-drive the agent's model requirement. Returns the resolved selection.
     */
    async setActive(provider: ArschatProviderKind, model?: string): Promise<ArschatActiveSelection | undefined> {
        await this.preferenceService.set(PREF_ACTIVE_PROVIDER, provider, undefined);
        if (model !== undefined) {
            await this.preferenceService.set(PREF_ACTIVE_MODEL, model, undefined);
        }
        return this.applyActiveSelection();
    }

    async setActiveModel(model: string): Promise<ArschatActiveSelection | undefined> {
        await this.preferenceService.set(PREF_ACTIVE_MODEL, model, undefined);
        return this.applyActiveSelection();
    }

    /**
     * Push the current preference-driven selection into the agent's model
     * requirement via both AISettingsService (the registry-consulted path) and
     * the live agent instance field (fallback).
     */
    async applyActiveSelection(): Promise<ArschatActiveSelection | undefined> {
        const provider = this.getActiveProvider();
        const model = providerByKind(provider)?.fixedModelId ?? this.getActiveModel();
        const modelId = this.resolveActiveModelId();

        if (this.agentId && modelId) {
            const requirement: LanguageModelRequirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: modelId };
            // (a) AISettingsService: the path FrontendLanguageModelRegistry.selectLanguageModels reads and prefers.
            await this.settingsService.updateAgentSettings(this.agentId, { languageModelRequirements: [requirement] });
            // (b) live agent instance field: the AbstractChatAgent fallback path.
            if (this.agentInstance) {
                this.agentInstance.languageModelRequirements = [requirement];
            }
            this.logger.info(`[arschat-providers] active selection: provider='${provider}' model='${model}' -> LanguageModel id='${modelId}' (agent='${this.agentId}')`);
        } else {
            this.logger.warn(`[arschat-providers] could not fully apply selection (provider='${provider}', model='${model}', modelId='${modelId ?? '<none>'}', agent='${this.agentId ?? '<none>'}')`);
        }

        const selection: ArschatActiveSelection = { provider, model, modelId: modelId ?? '' };
        this.onDidChangeEmitter.fire(selection);
        return modelId ? selection : undefined;
    }

    /** All registered LanguageModels (used by the header dropdown + autotest logging). */
    async getLanguageModels(): Promise<LanguageModel[]> {
        return this.languageModelRegistry.getLanguageModels();
    }

    /** LanguageModels belonging to a given ArsChat provider kind (matched by id prefix / fixed id). */
    async getModelsForProvider(kind: ArschatProviderKind): Promise<LanguageModel[]> {
        const provider = providerByKind(kind);
        if (!provider) {
            return [];
        }
        const models = await this.getLanguageModels();
        if (provider.fixedModelId) {
            return models.filter(m => m.id === provider.fixedModelId);
        }
        const prefix = kind === 'openai' ? 'openai/' : 'anthropic/';
        return models.filter(m => m.id.startsWith(prefix));
    }

    /** Convenience: the ArsChat provider kinds in display order. */
    get providers(): typeof PROVIDERS {
        return PROVIDERS;
    }
}
