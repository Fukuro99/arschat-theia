// *****************************************************************************
// ArsChat tools extension - frontend DI module (PHASE1_DESIGN.md §7, M5 e-2/e-4).
//
// Wires the AI tools (read_file / write_file / edit_file from e-2/e-3, plus
// run_command from e-4) as @theia/ai-core ToolProviders and attaches them to the
// active ArsChat ChatAgent so the model can call them from a chat request.
// run_command differs: its heavy lifting runs on the *backend* (spawn needs Node),
// reached through a JSON-RPC proxy bound here from commandRunnerServicePath; the
// backend module (../node/arschat-tools-backend-module) serves the impl.
//
// ---- Wiring, layer by layer -------------------------------------------------
//   1. ArschatFileToolsService  (browser/): the single FileService/Workspace
//      glue that performs the reads/writes. Bound to self, singleton.
//   2. {Read,Write,Edit}FileToolProvider (browser/): each implements
//      @theia/ai-core's ToolProvider (getTool(): ToolRequest) and is registered
//      via bindToolProvider(). @theia/ai-core's ToolInvocationRegistryImpl.init()
//      (@postConstruct) collects every bound ToolProvider and registers its
//      ToolRequest - so bindToolProvider() alone makes the tools appear in the
//      ToolInvocationRegistry.
//   3. ArschatToolsRegistrationContribution (FrontendApplicationContribution):
//      on startup, resolves exactly our three tools from the
//      ToolInvocationRegistry by id and hands them to the ArsChat agent via
//      agent.setToolRequests(). The base AbstractChatAgent spreads
//      `additionalToolRequests` into the tools passed to the language model on
//      every request (chat-agents.js), so the model can call read/write/edit on
//      any ArsChat send - no @tool mention required.
//
// ---- Approval (e-3) ---------------------------------------------------------
//   Theia 1.71.2 owns the confirmation state machine: @theia/ai-chat's
//   FrontendChatToolRequestService.toChatToolRequest() wraps each tool handler
//   and, when ToolConfirmationManager.getConfirmationMode() returns CONFIRM,
//   pauses on the tool's ToolCallChatResponseContent (requestUserConfirmation() +
//   response.fireInteractionNeeded()) until the UI calls confirm()/deny().
//   write_file / edit_file carry `confirmAlwaysAllow` (see file-tool-requests.ts),
//   which forces them into CONFIRM mode; read_file stays ALWAYS_ALLOW. The
//   approval card + allow/deny + scope (once/session/forever) UI lives in our
//   own ArschatChatWidget (arschat-chat), reusing ToolConfirmationManager for the
//   session/forever scope so we do not re-implement state management.
// *****************************************************************************

import { ContainerModule, interfaces, injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, ILogger } from '@theia/core';
import { FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider } from '@theia/core/lib/browser';
import { ToolInvocationRegistry, bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { ArschatChatAgent } from 'arschat-agents/lib/browser/arschat-chat-agent';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { ReadFileToolProvider } from './read-file-tool-provider';
import { WriteFileToolProvider } from './write-file-tool-provider';
import { EditFileToolProvider } from './edit-file-tool-provider';
import { RunCommandToolProvider } from './run-command-tool-provider';
import { WebSearchToolProvider } from './web-search-tool-provider';
import { FetchPageToolProvider } from './fetch-page-tool-provider';
import { RenderUiToolProvider } from './render-ui-tool-provider';
import { ArschatUiInteractionService } from './arschat-ui-interaction-service';
import { ARSCHAT_ALL_TOOL_IDS, ARSCHAT_UI_TOOL_IDS } from '../common/tool-ids';
import { CommandRunnerService, commandRunnerServicePath } from '../common/command-runner-protocol';
import { WebFetchService, webFetchServicePath } from '../common/web-fetch-protocol';
import { ArschatMCPImportContribution } from './mcp-import-contribution';
import { ArschatM5AutotestContribution } from './arschat-m5-autotest-contribution';
import { ArschatM5LiveContribution } from './arschat-m5-live-contribution';
import { shouldPromoteUiToolConfirmation } from './ui-tool-confirmation';

@injectable()
export class ArschatToolsRegistrationContribution implements FrontendApplicationContribution {

    @inject(ToolInvocationRegistry)
    protected readonly toolRegistry!: ToolInvocationRegistry;

    @inject(ArschatChatAgent)
    protected readonly agent!: ArschatChatAgent;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    @inject(ToolConfirmationManager)
    protected readonly confirmationManager!: ToolConfirmationManager;

    onStart(): void {
        // All ToolProviders (file tools + run_command + web_search/fetch_page) were
        // already collected into the registry by ToolInvocationRegistryImpl.init();
        // resolve exactly ours by id.
        const tools = this.toolRegistry.getFunctions(...ARSCHAT_ALL_TOOL_IDS);
        const uiTools = this.toolRegistry.getFunctions(...ARSCHAT_UI_TOOL_IDS);
        const confirmationSettings = this.confirmationManager.getAllConfirmationSettings();
        for (const tool of uiTools) {
            if (shouldPromoteUiToolConfirmation(tool.id, confirmationSettings)) {
                // UI tools must bypass CONFIRM so their custom form can resolve the handler,
                // but DISABLED is Theia's pre-handler denial path and is a user setting.
                this.confirmationManager.setConfirmationMode(tool.id, ToolConfirmationMode.ALWAYS_ALLOW, tool);
            }
        }
        this.agent.setToolRequests(tools);
        const resolved = tools.map(t => t.id).join(', ') || '<none>';
        this.logger.info(`[arschat-tools] attached ${tools.length} tool(s) to ArsChat agent: ${resolved}`);
        if (tools.length !== ARSCHAT_ALL_TOOL_IDS.length) {
            this.logger.warn(`[arschat-tools] expected ${ARSCHAT_ALL_TOOL_IDS.length} tools (${ARSCHAT_ALL_TOOL_IDS.join(', ')}) `
                + `but the registry only resolved ${tools.length}. Check ToolProvider bindings.`);
        }
    }
}

export function bindArschatTools(bind: interfaces.Bind): void {
    bind(ArschatFileToolsService).toSelf().inSingletonScope();
    bind(ArschatUiInteractionService).toSelf().inSingletonScope();

    // run_command's backend runs over JSON-RPC: bind a proxy to the
    // CommandRunnerService symbol from the shared service path (RemoteConnectionProvider
    // is Theia's RPC entry point; same pattern as @theia/file-search / @theia/ai-mcp).
    bind(CommandRunnerService).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<CommandRunnerService>(commandRunnerServicePath);
    }).inSingletonScope();

    // web_search / fetch_page share one backend service, reached the same way
    // (JSON-RPC proxy from webFetchServicePath).
    bind(WebFetchService).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<WebFetchService>(webFetchServicePath);
    }).inSingletonScope();

    // Register the ToolProviders (each bound to self + as a ToolProvider
    // contribution, per bindToolProvider's contract).
    bindToolProvider(ReadFileToolProvider, bind);
    bindToolProvider(WriteFileToolProvider, bind);
    bindToolProvider(EditFileToolProvider, bind);
    bindToolProvider(RunCommandToolProvider, bind);
    bindToolProvider(WebSearchToolProvider, bind);
    bindToolProvider(FetchPageToolProvider, bind);
    bindToolProvider(RenderUiToolProvider, bind);

    // Attach the resolved tools to the ArsChat agent on startup.
    bind(ArschatToolsRegistrationContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatToolsRegistrationContribution);

    // M5 e-6: command to import the current ArsChat mcp-config.json into
    // Theia's `ai-features.mcp.mcpServers` preference. Explicit user action
    // (no ToolConfirmationManager approval), registered on the command palette.
    bind(ArschatMCPImportContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(ArschatMCPImportContribution);

    // M5 e-7 autotest (no-op unless ARSCHAT_M5_AUTOTEST=1): drives the six tools
    // through the real agent/mock round-trip and asserts registration + read +
    // write/edit approval (allow/deny) + run_command + MCP import dry-run.
    bind(ArschatM5AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM5AutotestContribution);

    // M5 e-10 LIVE verification (no-op unless ARSCHAT_M5_LIVE=1): repoints the
    // shared `lmstudio` endpoint at a LAN LM Studio (OpenAI-compatible), switches
    // the ArsChat agent to it, and runs L1..L5 (read / write allow / write deny /
    // always-allow measurement / run_command) against a REAL LLM through the real
    // ChatService + confirmation gate. Restores mutated preferences afterwards.
    bind(ArschatM5LiveContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM5LiveContribution);
}

export default new ContainerModule(bind => {
    bindArschatTools(bind);
});
