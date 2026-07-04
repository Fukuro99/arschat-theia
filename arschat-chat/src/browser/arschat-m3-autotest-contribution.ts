// *****************************************************************************
// ArsChat M3 autotest (PHASE1_DESIGN.md §9 M3, task "検証").
//
// Enabled only when ARSCHAT_M3_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty - see
// BUILD_NOTES.md PoC-3 ハマった点 4). Completely no-op otherwise.
//
// It verifies M3 without a live LLM by:
//   1. registering a MOCK LanguageModel that STREAMS a fixed reply in several
//      chunks, including a ```code``` fence and a <think>...</think> block, so
//      the chat widget's streaming / Markdown+highlight / think-folding paths
//      are exercised for real;
//   2. pointing the ArsChat chat agent at the mock model (AISettingsService +
//      the live agent instance field, same belt-and-suspenders as M2's
//      ProviderSwitchService) and sending a request through ChatService, then
//      asserting the accumulated streamed text contains the code fence and the
//      <think> block;
//   3. asserting the session was PERSISTED (ChatService.getPersistedSessions()
//      shows it, i.e. a ${configDir}/chatSessions/<id>.json + index.json exist)
//      and that getOrRestoreSession() restores its request/response history
//      (the "reload -> history panel shows + restores" contract).
//
// A separate electron-main contribution captures the two required screenshots.
// All logging uses the [M3] prefix for grepability, mirroring the PoC/M2 tests.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CancellationToken, CommandService, ILogger } from '@theia/core';
import { ArschatHistoryCommand } from './arschat-history-contribution';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelResponse,
    LanguageModelStreamResponsePart,
    LanguageModelStatus,
    UserRequest
} from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';

const MOCK_MODEL_ID = 'arschat-mock/stream-test';

/**
 * The fixed reply the mock model streams, split into chunks. Contains a fenced
 * code block (for syntax-highlight rendering) and a <think> block (for the
 * collapsible think UI). Kept as chunk fragments so the stream arrives in
 * pieces, exercising the rAF-batched incremental render.
 */
const MOCK_CHUNKS: string[] = [
    '<think>\nThe user greeted me. ',
    'I will reply with a short markdown answer that ',
    'includes a code block.\n</think>\n\n',
    '# こんにちは\n\n',
    'これは **ArsChat** のモック応答です。次のコードを見てください:\n\n',
    '```ts\n',
    'function greet(name: string): string {\n',
    '    return `Hello, ${name}!`;\n',
    '}\n',
    '```\n\n',
    '- リスト項目 1\n',
    '- リスト項目 2\n'
];

/** A minimal streaming LanguageModel used only for M3 autotest verification. */
class ArschatMockLanguageModel implements LanguageModel {
    readonly id = MOCK_MODEL_ID;
    readonly name = 'ArsChat Mock (stream test)';
    readonly vendor = 'ArsChat';
    readonly status: LanguageModelStatus = { status: 'ready' };

    async request(_request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const chunks = MOCK_CHUNKS;
        const stream: AsyncIterable<LanguageModelStreamResponsePart> = {
            async *[Symbol.asyncIterator](): AsyncIterator<LanguageModelStreamResponsePart> {
                for (const c of chunks) {
                    if (cancellationToken?.isCancellationRequested) {
                        return;
                    }
                    // small delay so the stream genuinely arrives over multiple frames
                    await new Promise(resolve => setTimeout(resolve, 40));
                    yield { content: c };
                }
            }
        };
        return { stream };
    }
}

@injectable()
export class ArschatM3AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(LanguageModelRegistry)
    protected readonly languageModelRegistry!: LanguageModelRegistry;

    @inject(AISettingsService)
    protected readonly settingsService!: AISettingsService;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    /**
     * Log to BOTH the renderer devtools console and (via ILogger, which proxies
     * over RPC to the backend logger) the process stdout, so results are visible
     * in a headless run where the renderer console is not captured.
     */
    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M3_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        // Register the mock model immediately so it's available for the header dropdown too.
        this.languageModelRegistry.addLanguageModels([new ArschatMockLanguageModel()]);
        this.log(`[M3][autotest] registered mock LanguageModel id='${MOCK_MODEL_ID}'`);
        // Let the workbench + agents settle before driving the round-trip.
        setTimeout(() => this.run().catch(err => this.log(`[M3][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 14000);
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
        this.log('[M3][autotest] enabled (frontend)');

        // Point the ArsChat agent at the mock model (both paths, per M2 §10 analysis).
        const requirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: MOCK_MODEL_ID };
        await this.settingsService.updateAgentSettings(ARSCHAT_CHAT_AGENT_ID, { languageModelRequirements: [requirement] });
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as
            { languageModelRequirements?: Array<{ purpose: string; identifier?: string }> } | undefined;
        if (agent) {
            agent.languageModelRequirements = [requirement];
        }
        this.log(`[M3][autotest] ArsChat agent pointed at mock model (agent found=${!!agent})`);

        // ---- 1. streaming round-trip ----
        const chatAgent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
        const session = this.chatService.createSession(undefined, { focus: false }, chatAgent);
        this.log(`[M3][autotest] created session id='${session.id}'`);

        const invocation = await this.chatService.sendRequest(session.id, { text: 'こんにちは、コード例を見せて' });
        if (!invocation) {
            this.log('[M3][autotest] sendRequest returned undefined -> FAIL');
            return;
        }
        const response = await invocation.responseCreated;
        let observedIncrementalGrowth = false;
        let lastLen = 0;
        const sub = response.onDidChange(() => {
            const len = this.responseToText(response).length;
            if (len > lastLen && lastLen > 0) {
                observedIncrementalGrowth = true;
            }
            lastLen = len;
        });
        await invocation.responseCompleted;
        sub.dispose();

        const finalText = this.responseToText(response);
        const hasCode = finalText.includes('```') || finalText.includes('function greet');
        const hasThink = finalText.includes('<think>') && finalText.includes('</think>');
        this.log(`[M3][autotest] streaming round-trip: complete=${response.isComplete} error=${response.isError} len=${finalText.length}`);
        this.log(`[M3][autotest]   incrementalGrowthObserved=${observedIncrementalGrowth} hasCodeBlock=${hasCode} hasThinkBlock=${hasThink} -> ${response.isComplete && hasCode && hasThink ? 'PASS' : 'CHECK'}`);

        // ---- 2. persistence ----
        // The store auto-saves debounced (500ms); wait a bit then read the index.
        await new Promise(resolve => setTimeout(resolve, 1500));
        try {
            const persisted = await this.chatService.getPersistedSessions();
            const meta = persisted[session.id];
            this.log(`[M3][autotest] persistence: ${Object.keys(persisted).length} session(s) in store; this session present=${!!meta}${meta ? ` title='${meta.title}' saveDate=${new Date(meta.saveDate).toISOString()}` : ''} -> ${meta ? 'PASS' : 'FAIL'}`);
        } catch (e) {
            this.log('[M3][autotest] persistence check ERROR: ' + (e instanceof Error ? e.message : String(e)));
        }

        // ---- 3. restore (simulates the history-panel click / app-restart path) ----
        try {
            const restored = await this.chatService.getOrRestoreSession(session.id);
            const requests = restored?.model.getRequests() ?? [];
            const restoredText = requests.map(r => this.responseToText(r.response)).join('');
            const restoreOk = !!restored && requests.length >= 1 && restoredText.length > 0;
            this.log(`[M3][autotest] restore: restored=${!!restored} requestCount=${requests.length} restoredResponseLen=${restoredText.length} -> ${restoreOk ? 'PASS' : 'FAIL'}`);
        } catch (e) {
            this.log('[M3][autotest] restore check ERROR: ' + (e instanceof Error ? e.message : String(e)));
        }

        // ---- 4. reveal the history panel so the electron-main screenshot shows it ----
        try {
            await this.commandService.executeCommand(ArschatHistoryCommand.id);
            this.log('[M3][autotest] history panel revealed for screenshot');
        } catch (e) {
            this.log('[M3][autotest] could not reveal history panel: ' + (e instanceof Error ? e.message : String(e)));
        }

        this.log('[M3][autotest] done');
    }

    protected responseToText(response: { response: { content: Array<{ asString?: () => string | undefined; asDisplayString?: () => string | undefined }> } }): string {
        return response.response.content.map(c => c.asString?.() ?? c.asDisplayString?.() ?? '').join('');
    }
}
