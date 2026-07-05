// *****************************************************************************
// ArsChat M5 autotest (PHASE1_DESIGN.md §9 M5, task e-7 "検証").
//
// Enabled only when ARSCHAT_M5_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty - see
// the M3/M4 autotests). Completely no-op otherwise.
//
// Verifies M5 (tool execution + approval flow + MCP import) offline - no live
// API key, no real network - by registering a MOCK LanguageModel that drives the
// six ArsChat tools the same way a real provider adapter (Anthropic/OpenAI)
// would: it receives request.tools (already wrapped with Theia's confirmation
// gate by FrontendChatToolRequestService.toChatToolRequest), streams a
// `tool_calls` part (so the ToolCallChatResponseContent is added to the
// response), then calls the WRAPPED handler itself and streams the result back.
// Because the handler is the confirmation-wrapped one, write/edit/run_command
// block on `content.confirmed` until this autotest calls confirm()/deny()
// programmatically (mirroring the e-3 widget test that drives
// ToolCallChatResponseContentImpl by hand).
//
// Scenarios (all offline):
//   1. tool registration: the 6 tools (read/write/edit_file, run_command,
//      web_search, fetch_page) are in the ToolInvocationRegistry AND on the
//      ArsChat agent's additionalToolRequests.
//   2. read_file: create a temp file, have the mock call read_file, assert the
//      file content came back as the tool result (read stays ALWAYS_ALLOW, so no
//      confirmation is needed - proves that path too).
//   3a. write_file approval (allow): the mock calls write_file; the tool enters
//       the 承認待ち state (does NOT execute unconfirmed); the autotest calls
//       confirm(); the real file is written on disk.
//   3b. write_file approval (deny): the mock calls write_file for a second path;
//       the autotest calls deny(); no file is written and a denial result is
//       returned to the model.
//   4. run_command: the mock calls run_command with a harmless echo; the autotest
//       confirms (run_command is confirm-required like write); the backend RPC
//       runs it and exit code 0 + stdout come back.
//   5. MCP import dry-run: feed a fixture legacy config to convertLegacyMCPConfig
//      and log importedCount + warnings (NO preference write).
//
// web_search / fetch_page need a live network, so they are covered by scenario 1
// (registration) only; their execution path is the e-5 jest smoke
// (ARSCHAT_WEB_SMOKE=1). See BUILD_NOTES M5 e-7.
//
// All logs use the [M5] prefix, mirroring the M2/M3/M4 tests, so PASS/FAIL is
// judged from stdout in a headless run.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CancellationToken, ILogger, URI } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    AISettingsService,
    LanguageModel,
    LanguageModelRegistry,
    LanguageModelResponse,
    LanguageModelStreamResponsePart,
    LanguageModelStatus,
    ToolRequest,
    ToolInvocationContext,
    UserRequest
} from '@theia/ai-core';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ToolCallChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import { ArschatChatAgent } from 'arschat-agents/lib/browser/arschat-chat-agent';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import {
    ARSCHAT_ALL_TOOL_IDS,
    READ_FILE_TOOL_ID,
    WRITE_FILE_TOOL_ID,
    EDIT_FILE_TOOL_ID,
    RUN_COMMAND_TOOL_ID,
    WEB_SEARCH_TOOL_ID,
    FETCH_PAGE_TOOL_ID
} from '../common/tool-ids';
import { convertLegacyMCPConfig } from '../common/mcp-config-import';

const MOCK_MODEL_ID = 'arschat-mock/m5-tool-driver';

/**
 * Instruction for the mock model: "on the next request, call this one tool with
 * these arguments, then stream its result back as text". Set by the contribution
 * right before each ChatService.sendRequest so the mock knows what to do.
 */
interface ToolCallPlan {
    toolId: string;
    args: string;
    /** A stable id for the tool call, used to match the ToolCallChatResponseContent. */
    callId: string;
}

/**
 * A mock streaming LanguageModel that plays the role of a provider adapter for
 * tool calling: it takes the confirmation-wrapped ToolRequests from
 * `request.tools`, emits the tool_call as a stream part, then INVOKES the wrapped
 * handler (which is where Theia's confirmation gate lives) and streams the
 * result. The last invoked tool's result is captured so the autotest can assert
 * on it.
 */
class ArschatM5MockLanguageModel implements LanguageModel {
    readonly id = MOCK_MODEL_ID;
    readonly name = 'ArsChat Mock (M5 tool driver)';
    readonly vendor = 'ArsChat';
    readonly status: LanguageModelStatus = { status: 'ready' };

    /** Set by the contribution before each send. */
    plan: ToolCallPlan | undefined;
    /** The last tool result the mock got back from a handler (string or object). */
    lastToolResult: unknown;
    /** Whether the last request actually resolved a matching wrapped tool. */
    lastToolResolved = false;

    constructor(protected readonly log: (m: string) => void) { }

    async request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const plan = this.plan;
        const tools = (request.tools ?? []) as ToolRequest[];
        this.lastToolResult = undefined;
        this.lastToolResolved = false;

        const self = this;
        const stream: AsyncIterable<LanguageModelStreamResponsePart> = {
            async *[Symbol.asyncIterator](): AsyncIterator<LanguageModelStreamResponsePart> {
                if (!plan) {
                    // No tool plan -> just a plain text reply (keeps the agent happy).
                    yield { content: 'モック応答（ツール呼び出しなし）。' };
                    return;
                }
                const tool = tools.find(t => t.id === plan.toolId || t.name === plan.toolId);
                if (!tool) {
                    self.log(`[M5][autotest][mock] tool '${plan.toolId}' NOT present in request.tools `
                        + `(available=[${tools.map(t => t.id).join(', ')}])`);
                    yield { content: `ERROR: tool ${plan.toolId} not available` };
                    return;
                }
                self.log(`[M5][autotest][mock] emitting tool_call id='${plan.callId}' tool='${plan.toolId}' args=${plan.args}`);
                // 1) Emit the tool_call so the ToolCallChatResponseContent is added to the
                //    response (the confirmation wrapper matches on it by id).
                yield { tool_calls: [{ id: plan.callId, function: { name: plan.toolId, arguments: plan.args }, finished: false }] };

                // 2) Invoke the WRAPPED handler (confirmation gate lives here). For
                //    confirm-required tools this blocks until the autotest calls
                //    confirm()/deny() on the matching content part.
                try {
                    const result = await tool.handler(plan.args, ToolInvocationContext.create(plan.callId));
                    self.lastToolResult = result;
                    self.lastToolResolved = true;
                    self.log(`[M5][autotest][mock] tool '${plan.toolId}' handler returned: ${self.stringifyResult(result).slice(0, 300)}`);
                    yield { content: typeof result === 'string' ? result : JSON.stringify(result) };
                } catch (e) {
                    self.log(`[M5][autotest][mock] tool '${plan.toolId}' handler THREW: ${e instanceof Error ? e.message : String(e)}`);
                    yield { content: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        };
        // cancellationToken is honored implicitly: the handlers race their own timeouts.
        void cancellationToken;
        return { stream };
    }

    stringifyResult(result: unknown): string {
        return typeof result === 'string' ? result : JSON.stringify(result);
    }
}

@injectable()
export class ArschatM5AutotestContribution implements FrontendApplicationContribution {

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

    @inject(ToolInvocationRegistry)
    protected readonly toolRegistry!: ToolInvocationRegistry;

    @inject(ArschatChatAgent)
    protected readonly agent!: ArschatChatAgent;

    @inject(ArschatFileToolsService)
    protected readonly fileTools!: ArschatFileToolsService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(EnvVariablesServer)
    protected readonly env!: EnvVariablesServer;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected mock: ArschatM5MockLanguageModel | undefined;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M5_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        this.mock = new ArschatM5MockLanguageModel(m => this.log(m));
        this.languageModelRegistry.addLanguageModels([this.mock]);
        this.log(`[M5][autotest] registered mock LanguageModel id='${MOCK_MODEL_ID}'`);
        // Let the workbench + agents + tool registration settle before driving.
        setTimeout(() => this.run().catch(err => this.log(`[M5][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 15000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            const v = await this.envServer.getValue(key);
            return v?.value;
        } catch {
            return undefined;
        }
    }

    /** Point the ArsChat agent at the mock model (both paths, per M2 §10 analysis). */
    protected async pointAgentAtMock(): Promise<void> {
        const requirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: MOCK_MODEL_ID };
        await this.settingsService.updateAgentSettings(ARSCHAT_CHAT_AGENT_ID, { languageModelRequirements: [requirement] });
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as
            { languageModelRequirements?: Array<{ purpose: string; identifier?: string }> } | undefined;
        if (agent) {
            agent.languageModelRequirements = [requirement];
        }
    }

    protected async run(): Promise<void> {
        this.log('[M5][autotest] enabled (frontend)');
        await this.pointAgentAtMock();

        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(this.scenario1Registration());
        tally(await this.scenario2ReadFile());
        tally(await this.scenario3WriteApproval());
        tally(await this.scenario4RunCommand());
        tally(this.scenario5McpDryRun());

        this.log(`[M5][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} scenarios)`);
        this.log('[M5][autotest] done');
    }

    // ---------------------------------------------------------------- Scenario 1
    protected scenario1Registration(): boolean {
        const expected = [
            READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID,
            RUN_COMMAND_TOOL_ID, WEB_SEARCH_TOOL_ID, FETCH_PAGE_TOOL_ID
        ];
        const inRegistry = expected.filter(id => !!this.toolRegistry.getFunction(id));
        const agentToolIds = (this.agent as unknown as { additionalToolRequests?: ToolRequest[] })
            .additionalToolRequests?.map(t => t.id) ?? [];
        const onAgent = expected.filter(id => agentToolIds.includes(id));
        const registryOk = inRegistry.length === expected.length;
        const agentOk = onAgent.length === expected.length && agentToolIds.length === ARSCHAT_ALL_TOOL_IDS.length;
        const ok = registryOk && agentOk;
        this.log(`[M5][autotest] (1) tool registration: registry=[${inRegistry.join(', ')}] (${inRegistry.length}/${expected.length}) `
            + `agent.additionalToolRequests=[${agentToolIds.join(', ')}] onAgent=${onAgent.length}/${expected.length} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ---------------------------------------------------------------- Scenario 2
    protected async scenario2ReadFile(): Promise<boolean> {
        const marker = `M5_READ_MARKER_${Date.now()}`;
        const content = `hello from ArsChat M5 autotest\n${marker}\n第二行`;
        let uri: URI;
        try {
            uri = await this.autotestScratchUri('m5-read.txt');
            // Seed the file directly via the FileService glue (NOT via the tool), so
            // read_file has a real target. This bypasses any confirmation.
            await this.fileTools.writeFile(uri.path.fsPath(), content);
        } catch (e) {
            this.log(`[M5][autotest] (2) read_file: could not seed temp file -> FAIL (${e instanceof Error ? e.message : String(e)})`);
            return false;
        }
        const result = await this.driveToolCall(READ_FILE_TOOL_ID, JSON.stringify({ path: uri.path.fsPath() }), 'read-1');
        const resultText = typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
        const gotContent = resultText.includes(marker) && resultText.includes('hello from ArsChat M5 autotest');
        const noConfirmNeeded = !result.confirmationSeen; // read_file is ALWAYS_ALLOW
        const ok = result.resolved && gotContent && noConfirmNeeded;
        this.log(`[M5][autotest] (2) read_file: resolved=${result.resolved} contentReturned=${gotContent} `
            + `ranWithoutConfirmation=${noConfirmNeeded} -> ${ok ? 'PASS' : 'FAIL'}`);
        await this.deleteQuietly(uri);
        return ok;
    }

    // ---------------------------------------------------------------- Scenario 3
    protected async scenario3WriteApproval(): Promise<boolean> {
        const stamp = Date.now();
        // 3a: allow path — a unique path that cannot pre-exist, so "written" is
        // unambiguous. Must NOT exist until confirm(), then must be written.
        const allowUri = await this.autotestScratchUri(`m5-write-allow-${stamp}.txt`);
        const preExistsAllow = await this.fileExists(allowUri);
        const writeMarker = `M5_WRITE_MARKER_${stamp}`;
        const allow = await this.driveToolCall(
            WRITE_FILE_TOOL_ID,
            JSON.stringify({ path: allowUri.path.fsPath(), content: `${writeMarker}\nwritten by M5 autotest` }),
            'write-allow-1',
            { decision: 'confirm' }
        );
        // Give the write a moment to flush, then check disk.
        await this.delay(300);
        const allowExists = await this.fileExists(allowUri);
        const allowContentOk = allowExists && (await this.readRaw(allowUri)).includes(writeMarker);
        const allowConfirmedGate = allow.confirmationSeen && !allow.executedBeforeConfirm;
        const allowOk = !preExistsAllow && allow.resolved && allowConfirmedGate && allowContentOk;
        this.log(`[M5][autotest] (3a) write_file allow: enteredConfirmState=${allow.confirmationSeen} `
            + `notExecutedBeforeConfirm=${!allow.executedBeforeConfirm} fileWrittenAfterConfirm=${allowContentOk} -> ${allowOk ? 'PASS' : 'FAIL'}`);

        // 3b: deny path — deny() must leave no file and return a denial result.
        const denyUri = await this.autotestScratchUri(`m5-write-deny-${stamp}.txt`);
        const preExistsDeny = await this.fileExists(denyUri);
        const deny = await this.driveToolCall(
            WRITE_FILE_TOOL_ID,
            JSON.stringify({ path: denyUri.path.fsPath(), content: 'this must never be written' }),
            'write-deny-1',
            { decision: 'deny' }
        );
        await this.delay(200);
        const denyExists = await this.fileExists(denyUri);
        const denialResult = this.isDenial(deny.toolResult);
        const denyOk = !preExistsDeny && deny.confirmationSeen && !denyExists && denialResult;
        this.log(`[M5][autotest] (3b) write_file deny: enteredConfirmState=${deny.confirmationSeen} `
            + `fileNotWritten=${!denyExists} denialResultReturned=${denialResult} -> ${denyOk ? 'PASS' : 'FAIL'}`);

        // Cleanup the allow file (best-effort).
        if (allowExists) {
            await this.deleteQuietly(allowUri);
        }
        return allowOk && denyOk;
    }

    // ---------------------------------------------------------------- Scenario 4
    protected async scenario4RunCommand(): Promise<boolean> {
        const echoMarker = `M5_RUN_MARKER_${Date.now()}`;
        // Cross-platform echo: works in pwsh, cmd (chcp preamble), and posix sh.
        const command = `echo ${echoMarker}`;
        const run = await this.driveToolCall(
            RUN_COMMAND_TOOL_ID,
            JSON.stringify({ command }),
            'run-1',
            { decision: 'confirm' }
        );
        const resultText = typeof run.toolResult === 'string' ? run.toolResult : JSON.stringify(run.toolResult ?? '');
        const exitZero = /exit code:\s*0\b/.test(resultText);
        const gotStdout = resultText.includes(echoMarker);
        const confirmedGate = run.confirmationSeen && !run.executedBeforeConfirm;
        const ok = run.resolved && confirmedGate && exitZero && gotStdout;
        this.log(`[M5][autotest] (4) run_command: enteredConfirmState=${run.confirmationSeen} exitCode0=${exitZero} `
            + `stdoutReturned=${gotStdout} viaBackendRPC=${run.resolved} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ---------------------------------------------------------------- Scenario 5
    protected scenario5McpDryRun(): boolean {
        // A representative legacy config: stdio (local) + streamable-http (remote) +
        // enabled:false. No preference is touched — pure conversion only.
        const fixture = {
            servers: [
                { name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/tmp'], enabled: true, description: 'ファイル操作' },
                { name: 'resonitelink', type: 'streamable-http', url: 'http://127.0.0.1:7790/mcp', enabled: true },
                { name: 'disabledOne', type: 'stdio', command: 'node', args: ['x.js'], enabled: false }
            ]
        };
        const result = convertLegacyMCPConfig(fixture);
        const ok = result.importedCount === 3 && result.warnings.length === 0;
        this.log(`[M5][autotest] (5) MCP dry-run: importedCount=${result.importedCount} warnings=${result.warnings.length} `
            + `notes=${result.notes.length} servers=[${Object.keys(result.servers).join(', ')}] (no preference write) -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    // ------------------------------------------------------------------ helpers

    /**
     * Drive a single tool call through the real ChatService/agent/mock round-trip.
     * Sets the mock's plan, sends a request, and — for confirm-required tools —
     * watches the response's onInteractionNeeded (+ a content poll fallback) to
     * find the pending ToolCallChatResponseContent and confirm()/deny() it per the
     * requested decision. Returns diagnostics for the assertions.
     */
    protected async driveToolCall(
        toolId: string,
        args: string,
        callId: string,
        opts?: { decision?: 'confirm' | 'deny' }
    ): Promise<{
        resolved: boolean;
        toolResult: unknown;
        confirmationSeen: boolean;
        /** True if the tool's handler ran BEFORE we confirmed (a confirmation-bypass bug). */
        executedBeforeConfirm: boolean;
    }> {
        if (!this.mock) {
            return { resolved: false, toolResult: undefined, confirmationSeen: false, executedBeforeConfirm: false };
        }
        this.mock.plan = { toolId, args, callId };

        const chatAgent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
        const session = this.chatService.createSession(undefined, { focus: false }, chatAgent);
        const invocation = await this.chatService.sendRequest(session.id, { text: `ツール ${toolId} を実行して` });
        if (!invocation) {
            this.log(`[M5][autotest] driveToolCall(${toolId}): sendRequest returned undefined`);
            return { resolved: false, toolResult: undefined, confirmationSeen: false, executedBeforeConfirm: false };
        }

        let confirmationSeen = false;
        let executedBeforeConfirm = false;
        const decision = opts?.decision;

        const response = await invocation.responseCreated;
        // Decide + record the confirmation the moment the tool call needs interaction.
        const handleContent = (content: ToolCallChatResponseContent): void => {
            if (content.name !== toolId || content.finished) {
                return;
            }
            if (decision) {
                confirmationSeen = true;
                // If the handler had already produced a result before we act, that's a
                // bypass — but with the CONFIRM gate the handler awaits confirmed, so
                // this stays false in the correct implementation.
                if (this.mock?.lastToolResolved) {
                    executedBeforeConfirm = true;
                }
                if (decision === 'confirm') {
                    content.confirm();
                } else {
                    content.deny('M5 autotest programmatic denial');
                }
            }
        };

        const interactionSub = response.onInteractionNeeded(c => {
            if (ToolCallChatResponseContent.is(c)) {
                handleContent(c);
            }
        });
        // Fallback poll: onInteractionNeeded fires once, but if we subscribed a hair
        // late, scan the content array for a pending tool call needing confirmation.
        const poll = setInterval(() => {
            if (!decision || confirmationSeen) {
                return;
            }
            for (const c of response.response.content) {
                if (ToolCallChatResponseContent.is(c) && c.name === toolId && !c.finished) {
                    handleContent(c);
                }
            }
        }, 100);

        await invocation.responseCompleted;
        interactionSub.dispose();
        clearInterval(poll);

        return {
            resolved: this.mock.lastToolResolved,
            toolResult: this.mock.lastToolResult,
            confirmationSeen: decision ? confirmationSeen : false,
            executedBeforeConfirm
        };
    }

    protected isDenial(result: unknown): boolean {
        return !!result && typeof result === 'object' && (result as { denied?: boolean }).denied === true;
    }

    /** A writable scratch file URI under the config dir (no workspace assumed). */
    protected async autotestScratchUri(name: string): Promise<URI> {
        const configDir = await this.env.getConfigDirUri();
        return new URI(configDir).resolve(`arschat/m5-autotest/${name}`);
    }

    protected async fileExists(uri: URI): Promise<boolean> {
        try {
            return await this.fileService.exists(uri);
        } catch {
            return false;
        }
    }

    protected async readRaw(uri: URI): Promise<string> {
        try {
            return (await this.fileService.read(uri)).value;
        } catch {
            return '';
        }
    }

    protected async deleteQuietly(uri: URI): Promise<void> {
        try {
            await this.fileService.delete(uri, { recursive: false, useTrash: false });
        } catch {
            /* best-effort */
        }
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
