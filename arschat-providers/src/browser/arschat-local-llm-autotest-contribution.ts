// *****************************************************************************
// ArsChat local-LLM autotest (local-llm providers brief §1-5).
//
// A real-machine verification of ONE local OpenAI-compatible provider, enabled
// only when ARSCHAT_LOCAL_LLM_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty -
// see BUILD_NOTES.md PoC-3 ハマった点 4). Completely no-op otherwise.
//
// Env:
//   ARSCHAT_LOCAL_LLM_PROVIDER  provider kind with a fixedModelId (default 'vllm')
//   ARSCHAT_LOCAL_LLM_URL       endpoint URL (default: that provider's defaultUrl)
//   ARSCHAT_LOCAL_LLM_MODEL     model name (default: whatever /models answers first)
//
// Scenarios, run ~10s after startup and logged with the [LOCAL-LLM][autotest]
// prefix (endpoint / models / select / pong / japanese), closed by a
// "SUMMARY n PASS / m FAIL" line.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { LanguageModelRegistry } from '@theia/ai-core';
import { ArschatProviderKind, VLLM_ID, customEndpointProviders, defaultCustomEndpointFor } from './arschat-provider-preferences';
import { ProviderSwitchService, ARSCHAT_CHAT_AGENT_ID } from './provider-switch-service';

const PONG_PROMPT = 'Reply with exactly: PONG';
const JAPANESE_PROMPT = '日本の首都を漢字2文字で答えてください。';

/** A single chat round-trip with a local model can take a while (reasoning models...). */
const CHAT_TIMEOUT_MS = 120000;
/** Custom model re-registration happens asynchronously on the preference change. */
const REGISTRY_POLL_MS = 10000;

interface Scenario {
    name: string;
    run: () => Promise<string>;
    check: (detail: string) => boolean;
}

@injectable()
export class ArschatLocalLlmAutotestContribution implements FrontendApplicationContribution {

    protected pass = 0;
    protected fail = 0;

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
        if (await this.getBackendEnv('ARSCHAT_LOCAL_LLM_AUTOTEST') !== '1') {
            return;
        }
        // Give the provider startup contributions (openai model registration + our seeding) time to settle.
        setTimeout(() => this.run().catch(err => console.error('[LOCAL-LLM][autotest] fatal error', err)), 10000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            const v = await this.envServer.getValue(key);
            return v?.value;
        } catch {
            return undefined;
        }
    }

    protected log(message: string): void {
        console.log(`[LOCAL-LLM][autotest] ${message}`);
    }

    protected async run(): Promise<void> {
        const kind = (await this.getBackendEnv('ARSCHAT_LOCAL_LLM_PROVIDER')) || VLLM_ID;
        const known = customEndpointProviders().map(p => p.kind);
        if (!known.includes(kind as ArschatProviderKind)) {
            this.log(`SETUP FAILED: '${kind}' is not a custom-endpoint provider (expected one of: ${known.join(', ')})`);
            this.log('SUMMARY 0 PASS / 1 FAIL');
            return;
        }
        const providerKind = kind as ArschatProviderKind;
        const fixedModelId = defaultCustomEndpointFor(providerKind)?.id;
        if (!fixedModelId) {
            this.log(`SETUP FAILED: no default endpoint for '${kind}'`);
            this.log('SUMMARY 0 PASS / 1 FAIL');
            return;
        }
        const url = (await this.getBackendEnv('ARSCHAT_LOCAL_LLM_URL')) || defaultCustomEndpointFor(providerKind)?.url || '';
        let configuredModel = (await this.getBackendEnv('ARSCHAT_LOCAL_LLM_MODEL')) || '';

        this.log(`enabled (frontend) provider='${kind}' url='${url}'`);

        const scenarios: Scenario[] = [
            {
                // updateCustomEndpointUrl throws on a malformed URL, which the runner logs as FAIL.
                name: 'endpoint',
                run: async () => `normalized URL '${await this.switchService.updateCustomEndpointUrl(providerKind, url)}'`,
                check: detail => detail.includes("normalized URL 'http")
            },
            {
                name: 'models',
                run: async () => {
                    const models = await this.switchService.fetchCustomEndpointModels(providerKind, { timeoutMs: 10000 });
                    if (models.length === 0) {
                        return 'no models';
                    }
                    if (!configuredModel) {
                        configuredModel = models[0];
                    }
                    return `${models.length} model(s) [${models.join(', ')}] -> using '${configuredModel}'`;
                },
                check: detail => !detail.startsWith('no models')
            },
            {
                name: 'select',
                run: async () => {
                    const selection = await this.switchService.setActive(providerKind, configuredModel);
                    if (!selection) {
                        throw new Error('setActive returned undefined');
                    }
                    if (selection.provider !== providerKind) {
                        throw new Error(`setActive returned provider='${selection.provider}', expected '${providerKind}'`);
                    }
                    const registered = await this.waitForRegisteredModel(fixedModelId);
                    return `setActive -> provider='${selection.provider}' modelId='${selection.modelId}', registry ready=${registered}`;
                },
                check: detail => detail.includes(`modelId='${providerKind}'`) && detail.includes('registry ready=true')
            },
            {
                name: 'pong',
                run: () => this.roundTrip(PONG_PROMPT),
                check: reply => reply.includes('PONG')
            },
            {
                name: 'japanese',
                run: () => this.roundTrip(JAPANESE_PROMPT),
                check: reply => reply.includes('東京')
            }
        ];

        for (const scenario of scenarios) {
            await this.runScenario(scenario);
        }

        this.log(`SUMMARY ${this.pass} PASS / ${this.fail} FAIL`);
    }

    protected async runScenario(scenario: Scenario): Promise<void> {
        try {
            const detail = await scenario.run();
            const ok = scenario.check(detail);
            if (ok) {
                this.pass++;
            } else {
                this.fail++;
            }
            this.log(`${scenario.name}: ${ok ? 'PASS' : 'FAIL'} - ${this.excerpt(detail)}`);
        } catch (e) {
            this.fail++;
            this.log(`${scenario.name}: FAIL - ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Polls the registry until the custom endpoint's LanguageModel id shows up. */
    protected async waitForRegisteredModel(modelId: string, timeoutMs = REGISTRY_POLL_MS): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const models = await this.languageModelRegistry.getLanguageModels();
            if (models.some(m => m.id === modelId)) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise<void>(resolve => setTimeout(resolve, 250));
        }
    }

    /** Sends one prompt through ChatService pinned to the ArsChat agent and returns the accumulated text. */
    protected async roundTrip(promptText: string, timeoutMs = CHAT_TIMEOUT_MS): Promise<string> {
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
        const session = this.chatService.createSession(undefined, { focus: false }, agent);
        const invocation = await this.chatService.sendRequest(session.id, { text: promptText });
        if (!invocation) {
            throw new Error('ChatService.sendRequest returned undefined (session not found?)');
        }
        const response = await Promise.race([
            invocation.responseCompleted,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`responseCompleted timed out after ${timeoutMs}ms`)), timeoutMs))
        ]);
        const parts = response.response.content as Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined }>;
        return parts.map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
    }

    protected excerpt(s: string): string {
        const oneLine = s.replace(/\s+/g, ' ').trim();
        return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
    }
}
