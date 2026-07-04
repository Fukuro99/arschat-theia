// *****************************************************************************
// ArsChat tools extension - frontend DI module (PHASE1_DESIGN.md §7, M5 e-2).
//
// Wires the first three AI tools (read_file / write_file / edit_file) as
// @theia/ai-core ToolProviders and attaches them to the active ArsChat
// ChatAgent so the model can actually call them from a chat request.
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
import { ILogger } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ToolInvocationRegistry, bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ArschatChatAgent } from 'arschat-agents/lib/browser/arschat-chat-agent';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { ReadFileToolProvider } from './read-file-tool-provider';
import { WriteFileToolProvider } from './write-file-tool-provider';
import { EditFileToolProvider } from './edit-file-tool-provider';
import { ARSCHAT_FILE_TOOL_IDS } from '../common/tool-ids';

@injectable()
export class ArschatToolsRegistrationContribution implements FrontendApplicationContribution {

    @inject(ToolInvocationRegistry)
    protected readonly toolRegistry!: ToolInvocationRegistry;

    @inject(ArschatChatAgent)
    protected readonly agent!: ArschatChatAgent;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    onStart(): void {
        // The three ToolProviders were already collected into the registry by
        // ToolInvocationRegistryImpl.init(); resolve exactly ours by id.
        const tools = this.toolRegistry.getFunctions(...ARSCHAT_FILE_TOOL_IDS);
        this.agent.setToolRequests(tools);
        const resolved = tools.map(t => t.id).join(', ') || '<none>';
        this.logger.info(`[arschat-tools] attached ${tools.length} file tool(s) to ArsChat agent: ${resolved}`);
        if (tools.length !== ARSCHAT_FILE_TOOL_IDS.length) {
            this.logger.warn(`[arschat-tools] expected ${ARSCHAT_FILE_TOOL_IDS.length} tools (${ARSCHAT_FILE_TOOL_IDS.join(', ')}) `
                + `but the registry only resolved ${tools.length}. Check ToolProvider bindings.`);
        }
    }
}

export function bindArschatTools(bind: interfaces.Bind): void {
    bind(ArschatFileToolsService).toSelf().inSingletonScope();

    // Register the three ToolProviders (each bound to self + as a ToolProvider
    // contribution, per bindToolProvider's contract).
    bindToolProvider(ReadFileToolProvider, bind);
    bindToolProvider(WriteFileToolProvider, bind);
    bindToolProvider(EditFileToolProvider, bind);

    // Attach the resolved tools to the ArsChat agent on startup.
    bind(ArschatToolsRegistrationContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatToolsRegistrationContribution);
}

export default new ContainerModule(bind => {
    bindArschatTools(bind);
});
