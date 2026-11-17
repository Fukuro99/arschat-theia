// *****************************************************************************
// ArsChat M2 autotest (PHASE1_DESIGN.md §9 M2, task "検証").
//
// Enabled only when ARSCHAT_M2_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty -
// see BUILD_NOTES.md PoC-3 ハマった点 4). Completely no-op otherwise.
//
// It:
//   1. logs every registered LanguageModel (expects every ArsChat provider's
//      models - cloud ones and the local OpenAI-compatible endpoints);
//   2. for each provider, if it is "available" runs a live round-trip with the
//      prompt "Reply with exactly: PONG" (Anthropic/OpenAI gated on API keys,
//      every custom-endpoint provider gated on its configured /v1/models
//      endpoint answering); prints SKIP with the reason otherwise;
//   3. exercises the switch: flips arschat.provider.active via ProviderSwitchService
//      and logs the agent's resolved model id after each flip.
//
// All logging uses the [M2] prefix for grepability, mirroring the PoC autotests.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { LanguageModel, LanguageModelRegistry } from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ProviderSwitchService, ARSCHAT_CHAT_AGENT_ID } from './provider-switch-service';
import {
    ArschatProviderKind,
    PROVIDERS
} from './arschat-provider-preferences';

/** Unsloth Studio answers on :8888 when nothing is listening on its default :8000. */
const UNSLOTH_FALLBACK_MODELS_URL = 'http://localhost:8888/v1/models';

const PONG_PROMPT = 'Reply with exactly: PONG';

@injectable()
export class ArschatM2AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(LanguageModelRegistry)
    protected readonly languageModelRegistry!: LanguageModelRegistry;

    @inject(ProviderSwitchService)
    protected readonly switchService!: ProviderSwitchService;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M2_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        // Give the provider startup contributions (openai/anthropic model registration + our seeding) time to settle.
        setTimeout(() => this.run().catch(err => console.error('[M2][autotest] fatal error', err)), 12000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            const v = await this.envServer.getValue(key);
            return v?.value;
        } catch {
            return undefined;
        }
    }

    protected async run(): Promise<void> {
        console.log('[M2][autotest] enabled (frontend)');

        // ---- 1. registered LanguageModels ----
        const models = await this.languageModelRegistry.getLanguageModels();
        console.log(`[M2][autotest] ${models.length} language model(s) registered total`);
        for (const m of models) {
            console.log(`[M2][autotest]   id='${m.id}' status='${m.status.status}'${m.status.status !== 'ready' ? ` message='${m.status.message ?? ''}'` : ''}`);
        }
        for (const p of PROVIDERS) {
            const forProvider = await this.switchService.getModelsForProvider(p.kind);
            console.log(`[M2][autotest] provider '${p.kind}' (${p.label}): ${forProvider.length} model(s) -> [${forProvider.map(m => m.id).join(', ')}]`);
        }

        // ---- 2. per-provider live round-trip (or SKIP) ----
        for (const p of PROVIDERS) {
            await this.liveTestProvider(p.kind, models);
        }

        // ---- 3. switch exercise ----
        console.log('[M2][autotest] --- switch exercise ---');
        for (const p of PROVIDERS) {
            // Pick an actual model name; custom endpoint IDs only identify the LanguageModel.
            const modelName = await this.pickModelName(p.kind, models);
            const selection = await this.switchService.setActive(p.kind, modelName);
            const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as { languageModelRequirements?: Array<{ purpose: string; identifier?: string }> } | undefined;
            const resolvedFromAgent = agent?.languageModelRequirements?.find(r => r.purpose === 'chat')?.identifier;
            console.log(`[M2][autotest] switch -> provider='${p.kind}' resolvedModelId='${selection?.modelId ?? '<none>'}' agentRequirementIdentifier='${resolvedFromAgent ?? '<none>'}'`);
        }

        console.log('[M2][autotest] done');
    }

    protected async pickModelName(kind: ArschatProviderKind, models: LanguageModel[]): Promise<string | undefined> {
        const provider = PROVIDERS.find(p => p.kind === kind);
        if (provider?.fixedModelId) {
            const configuredModel = this.switchService.getCustomEndpointModel(kind);
            if (configuredModel && configuredModel !== 'local-model') {
                return configuredModel;
            }
            return (await this.switchService.fetchCustomEndpointModels(kind))[0];
        }
        const prefix = kind === 'openai' ? 'openai/' : 'anthropic/';
        const first = models.find(m => m.id.startsWith(prefix));
        return first ? first.id.substring(prefix.length) : undefined;
    }

    protected async liveTestProvider(kind: ArschatProviderKind, models: LanguageModel[]): Promise<void> {
        const provider = PROVIDERS.find(p => p.kind === kind)!;
        // Availability gate per provider.
        let available = false;
        let skipReason = '';

        if (kind === 'anthropic') {
            const key = await this.getBackendEnv('ANTHROPIC_API_KEY');
            available = !!key;
            skipReason = 'ANTHROPIC_API_KEY not set';
        } else if (kind === 'openai') {
            const key = await this.getBackendEnv('OPENAI_API_KEY');
            available = !!key;
            skipReason = 'OPENAI_API_KEY not set';
        } else if (provider.fixedModelId) {
            const modelsUrl = `${this.switchService.getCustomEndpointUrl(kind)}/models`;
            available = await this.probeEndpoint(modelsUrl);
            skipReason = `no server answering at ${modelsUrl}`;
            if (kind === 'unsloth' && !available) {
                // Unsloth Studio serves :8888 when :8000 is taken, so try it too.
                available = await this.probeEndpoint(UNSLOTH_FALLBACK_MODELS_URL);
                skipReason = `no server answering at ${modelsUrl} or ${UNSLOTH_FALLBACK_MODELS_URL}`;
            }
        }

        if (!available) {
            console.log(`[M2][autotest] ${provider.label}: live round-trip SKIP (${skipReason})`);
            return;
        }

        // Set the provider active, then send a real request through ChatService -> ArsChat agent.
        const modelName = await this.pickModelName(kind, models);
        await this.switchService.setActive(kind, modelName);
        const modelId = this.switchService.resolveActiveModelId();
        console.log(`[M2][autotest] ${provider.label}: attempting live round-trip via LanguageModel id='${modelId}'`);

        try {
            const reply = await this.roundTrip();
            console.log(`[M2][autotest] ${provider.label}: live round-trip reply='${reply.trim()}' -> ${reply.includes('PONG') ? 'PASS' : 'RESPONDED (unexpected text)'}`);
        } catch (e) {
            console.log(`[M2][autotest] ${provider.label}: live round-trip ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Sends the PONG prompt through ChatService pinned to the ArsChat agent and returns the accumulated text. */
    protected async roundTrip(): Promise<string> {
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
        const session = this.chatService.createSession(undefined, { focus: false }, agent);
        const invocation = await this.chatService.sendRequest(session.id, { text: PONG_PROMPT });
        if (!invocation) {
            throw new Error('ChatService.sendRequest returned undefined (session not found?)');
        }
        const response = await invocation.responseCompleted;
        // Accumulate text from all response content parts.
        const parts = response.response.content as Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined }>;
        return parts.map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
    }

    /** Best-effort probe of an OpenAI-compatible /models endpoint. Returns true if it answers (any HTTP status). */
    protected async probeEndpoint(url: string): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            const res = await fetch(url, { method: 'GET', signal: controller.signal });
            clearTimeout(timeout);
            // Any HTTP response (even 401/404) means a server is listening.
            return res.status > 0;
        } catch {
            return false;
        }
    }
}
