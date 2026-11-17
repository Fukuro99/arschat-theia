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
import { Emitter, Event, ILogger, PreferenceScope, PreferenceService } from '@theia/core';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelRequirement
} from '@theia/ai-core';
import {
    ArschatProviderKind,
    CustomOpenAiModelEntry,
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    PREF_ACTIVE_MODEL,
    PREF_ACTIVE_PROVIDER,
    PROVIDERS,
    defaultCustomEndpointFor,
    providerByKind
} from './arschat-provider-preferences';

export type { CustomOpenAiModelEntry } from './arschat-provider-preferences';

/** The purpose all ArsChat chat requests use. */
export const ARSCHAT_CHAT_PURPOSE = 'chat';

/**
 * Theia AI's official-OpenAI API key preference. A custom endpoint entry with
 * `apiKey: true` means "use this global OpenAI API key" (see @theia/ai-openai
 * openai-preferences.ts `API_KEY_PREF`); we read it to build the Authorization
 * header when fetching that endpoint's /models.
 */
export const OPENAI_OFFICIAL_API_KEY_PREF = 'ai-features.openAiOfficial.openAiApiKey';

/**
 * The stable id/name of the ArsChat chat agent (defined here in arschat-providers
 * so both the agent implementation (arschat-agents) and the M2 autotest can share
 * it without a circular dependency - arschat-agents already depends on providers).
 */
export const ARSCHAT_CHAT_AGENT_ID = 'ArsChat';

export interface ArschatActiveSelection {
    provider: ArschatProviderKind;
    /** The user-facing model name. For LM Studio/Unsloth this is the server model name, not the fixed endpoint id. */
    model: string;
    /** The resolved registered LanguageModel id the agent should use. */
    modelId: string;
}

export interface FetchCustomEndpointModelsOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export function normalizeOpenAiBaseUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error('URL must start with http:// or https://');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL must start with http:// or https://');
    }
    if (parsed.search || parsed.hash) {
        throw new Error('URL must not include query parameters or fragments');
    }
    const path = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = /\/v1$/i.test(path) ? path : `${path}/v1`;
    return parsed.toString();
}

export function buildOpenAiModelsUrl(rawBaseUrl: string): string {
    return `${normalizeOpenAiBaseUrl(rawBaseUrl)}/models`;
}

export function parseOpenAiModelIds(payload: unknown): string[] {
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
        throw new Error('Models response does not contain a data array');
    }
    return Array.from(new Set(data
        .map(item => (item as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
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
     * Serializes whole setActive() runs. A single run writes PREF_ACTIVE_PROVIDER,
     * then (for custom endpoints) the endpoint model, then PREF_ACTIVE_MODEL - so
     * two interleaving runs could land a mixed state (e.g. an old
     * setActive('lmstudio','qwen') resuming after a newer setActive('anthropic',
     * 'claude') completed would revert the active model to 'qwen'). Chaining the
     * whole body guarantees the last-called selection lands last.
     */
    protected setActiveChain: Promise<unknown> = Promise.resolve();

    /**
     * Set the active provider (and optionally model), persist to preferences, and
     * re-drive the agent's model requirement. Returns the resolved selection.
     */
    setActive(provider: ArschatProviderKind, model?: string): Promise<ArschatActiveSelection | undefined> {
        const run = this.setActiveChain.then(() => this.doSetActive(provider, model));
        // Continue the chain with a pre-caught promise so one failed run does not
        // poison later ones; the caller still sees the rejection via `run`.
        this.setActiveChain = run.then(() => undefined, () => undefined);
        return run;
    }

    // NOTE on chain layering: doSetActive awaits updateCustomEndpointModel, whose
    // write is queued on customEndpointUpdateChain. Tasks on that chain never wait
    // on setActiveChain (doUpdateCustomEndpoint only reads/writes the preference),
    // so the two chains form a strict one-way dependency and cannot deadlock.
    protected async doSetActive(provider: ArschatProviderKind, model?: string): Promise<ArschatActiveSelection | undefined> {
        await this.preferenceService.set(PREF_ACTIVE_PROVIDER, provider, PreferenceScope.User);
        if (model !== undefined) {
            if (providerByKind(provider)?.fixedModelId) {
                await this.updateCustomEndpointModel(provider, model);
            }
            await this.preferenceService.set(PREF_ACTIVE_MODEL, model, PreferenceScope.User);
        }
        // Already ON the chain here: call the body directly. Going through the
        // queued applyActiveSelection() would await the chain's own tail = self-deadlock.
        return this.doApplyActiveSelection();
    }

    async setActiveModel(model: string): Promise<ArschatActiveSelection | undefined> {
        await this.preferenceService.set(PREF_ACTIVE_MODEL, model, PreferenceScope.User);
        return this.applyActiveSelection();
    }

    /**
     * Re-apply the current preference-driven selection to the agent + listeners.
     * This is the CHAIN-EXTERNAL entry point (preference-change listener,
     * registerAgent, setActiveModel, external callers): it queues the application
     * onto setActiveChain so it cannot run between an in-flight setActive()'s
     * preference writes - reading a mixed provider/model state - and then land
     * that stale intermediate selection on the agent/onDidChange AFTER the final
     * one. Serialization keeps "the last-called selection is applied last".
     */
    applyActiveSelection(): Promise<ArschatActiveSelection | undefined> {
        const run = this.setActiveChain.then(() => this.doApplyActiveSelection());
        this.setActiveChain = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Push the current preference-driven selection into the agent's model
     * requirement via both AISettingsService (the registry-consulted path) and
     * the live agent instance field (fallback).
     *
     * Only call this from a task already running ON setActiveChain (doSetActive /
     * the applyActiveSelection wrapper): awaiting the chain's tail from a task on
     * the chain would self-deadlock, so on-chain callers must use this body directly.
     */
    protected async doApplyActiveSelection(): Promise<ArschatActiveSelection | undefined> {
        const provider = this.getActiveProvider();
        const providerDescriptor = providerByKind(provider);
        const model = this.getActiveDisplayModel(provider, providerDescriptor);
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

    protected getActiveDisplayModel(provider: ArschatProviderKind, providerDescriptor = providerByKind(provider)): string {
        if (!providerDescriptor?.fixedModelId) {
            return this.getActiveModel();
        }
        const customEndpointModel = this.getCustomEndpointModel(provider);
        if (customEndpointModel) {
            return customEndpointModel;
        }
        const activeModel = this.getActiveModel();
        if (this.isActiveModelFromFixedProvider(provider, activeModel)) {
            return activeModel;
        }
        return providerDescriptor.fixedModelId;
    }

    protected isActiveModelFromFixedProvider(provider: ArschatProviderKind, activeModel: string): boolean {
        if (!activeModel) {
            return false;
        }
        const providerDescriptor = providerByKind(provider);
        if (!providerDescriptor?.fixedModelId) {
            return false;
        }
        return activeModel === providerDescriptor.fixedModelId || activeModel === this.getCustomEndpointModel(provider);
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

    getCustomEndpoint(kind: ArschatProviderKind): CustomOpenAiModelEntry | undefined {
        const endpointId = this.customEndpointIdFor(kind);
        if (!endpointId) {
            return undefined;
        }
        const existing = this.getCustomEndpoints().find(e => (e.id ?? e.model) === endpointId);
        return existing ?? this.defaultCustomEndpoint(kind);
    }

    getCustomEndpointUrl(kind: ArschatProviderKind): string {
        return this.getCustomEndpoint(kind)?.url ?? this.defaultCustomEndpoint(kind)?.url ?? '';
    }

    getCustomEndpointModel(kind: ArschatProviderKind): string {
        return this.getCustomEndpoint(kind)?.model ?? '';
    }

    async updateCustomEndpointUrl(kind: ArschatProviderKind, rawUrl: string): Promise<string> {
        const normalized = normalizeOpenAiBaseUrl(rawUrl);
        await this.updateCustomEndpoint(kind, { url: normalized });
        return normalized;
    }

    async updateCustomEndpointModel(kind: ArschatProviderKind, model: string): Promise<void> {
        if (model.trim().length === 0) {
            return;
        }
        await this.updateCustomEndpoint(kind, { model });
    }

    async fetchCustomEndpointModels(kind: ArschatProviderKind, options: FetchCustomEndpointModelsOptions = {}): Promise<string[]> {
        const endpoint = this.getCustomEndpoint(kind);
        if (!endpoint?.url) {
            throw new Error(`No custom endpoint URL configured for provider '${kind}'`);
        }
        const timeoutMs = options.timeoutMs ?? 4000;
        const controller = new AbortController();
        const abortFromCaller = (): void => controller.abort();
        if (options.signal?.aborted) {
            controller.abort();
        } else {
            options.signal?.addEventListener('abort', abortFromCaller, { once: true });
        }
        const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = this.resolveCustomEndpointAuthHeader(endpoint);
            const response = await fetch(buildOpenAiModelsUrl(endpoint.url), { signal: controller.signal, headers });
            if (!response.ok) {
                throw new Error(`Models request failed with HTTP ${response.status}`);
            }
            return parseOpenAiModelIds(await response.json());
        } finally {
            window.clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abortFromCaller);
        }
    }

    /**
     * Build the Authorization header for a custom endpoint's /models request.
     *  - `apiKey: '<literal>'`  -> `Bearer <literal>` (per-endpoint key).
     *  - `apiKey: true`         -> Theia's "use the global OpenAI API key" flag, so
     *                              we read `ai-features.openAiOfficial.openAiApiKey`
     *                              and send it as `Bearer <globalKey>` when non-empty.
     *  - otherwise / empty      -> no Authorization header.
     */
    protected resolveCustomEndpointAuthHeader(endpoint: CustomOpenAiModelEntry): Record<string, string> {
        const apiKey = endpoint.apiKey;
        if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
            return { Authorization: `Bearer ${apiKey.trim()}` };
        }
        if (apiKey === true) {
            const globalKey = this.preferenceService.get<string>(OPENAI_OFFICIAL_API_KEY_PREF, '')?.trim();
            if (globalKey) {
                return { Authorization: `Bearer ${globalKey}` };
            }
        }
        return {};
    }

    /** Convenience: the ArsChat provider kinds in display order. */
    get providers(): typeof PROVIDERS {
        return PROVIDERS;
    }

    protected getCustomEndpoints(): CustomOpenAiModelEntry[] {
        return this.preferenceService.get<CustomOpenAiModelEntry[]>(OPENAI_CUSTOM_ENDPOINTS_PREF, []) ?? [];
    }

    /**
     * Serializes every read-modify-write of the shared customOpenAiModels
     * preference ARRAY. LM Studio and Unsloth both live in that one array, so two
     * concurrent updates (e.g. the widget's commit chains, which are per provider)
     * would each read the old array and the later write would silently
     * revert the other provider's change (lost update). Chaining the whole
     * read -> merge -> write makes the writes strictly sequential.
     */
    protected customEndpointUpdateChain: Promise<void> = Promise.resolve();

    protected updateCustomEndpoint(kind: ArschatProviderKind, patch: Partial<CustomOpenAiModelEntry>): Promise<CustomOpenAiModelEntry | undefined> {
        const run = this.customEndpointUpdateChain.then(() => this.doUpdateCustomEndpoint(kind, patch));
        // Continue the chain with a pre-caught promise so one failed update does
        // not poison later ones; the caller still sees the rejection via `run`.
        this.customEndpointUpdateChain = run.then(() => undefined, () => undefined);
        return run;
    }

    protected async doUpdateCustomEndpoint(kind: ArschatProviderKind, patch: Partial<CustomOpenAiModelEntry>): Promise<CustomOpenAiModelEntry | undefined> {
        const endpointId = this.customEndpointIdFor(kind);
        if (!endpointId) {
            return undefined;
        }
        const endpoints = this.getCustomEndpoints();
        const index = endpoints.findIndex(e => (e.id ?? e.model) === endpointId);
        const current = index >= 0 ? endpoints[index] : this.defaultCustomEndpoint(kind);
        const next: CustomOpenAiModelEntry = { ...current, ...patch, id: endpointId };
        const updated = [...endpoints];
        if (index >= 0) {
            updated[index] = next;
        } else {
            updated.push(next);
        }
        await this.preferenceService.set(OPENAI_CUSTOM_ENDPOINTS_PREF, updated, PreferenceScope.User);
        return next;
    }

    /** The customOpenAiModels entry id backing a custom-endpoint provider (undefined for cloud ones). */
    protected customEndpointIdFor(kind: ArschatProviderKind): string | undefined {
        return providerByKind(kind)?.fixedModelId;
    }

    protected defaultCustomEndpoint(kind: ArschatProviderKind): CustomOpenAiModelEntry | undefined {
        return defaultCustomEndpointFor(kind);
    }
}
