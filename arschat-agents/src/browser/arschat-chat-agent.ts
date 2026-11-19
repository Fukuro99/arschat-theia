// *****************************************************************************
// ArsChat chat agent (PHASE1_DESIGN.md §4.2 / §6, M4 production implementation).
//
// ---- Agent-registration approach (§6 decision, rationale recorded here) ----
//
// §6 offered two options for "persona = dynamic ChatAgent":
//   (a) evolve the single ArsChat agent so it reflects the ACTIVE persona, or
//   (b) register one ChatAgent per persona.
// We chose (a). Rationale:
//   - The M2 ProviderSwitchService already drives THIS one agent's model
//     requirement and the widget pins THIS agent id ('ArsChat') as the session
//     handler. Keeping a single stable agent id preserves all of that wiring
//     (session routing, pinnedAgent, provider switch) unchanged.
//   - Personas are edited frequently (CRUD). Re-registering/unregistering a
//     ChatAgent on every persona create/edit/delete is more moving parts and
//     more failure surface (dangling registrations, stale pinned agents) for
//     zero user-visible benefit - §6 itself notes "UX上の差異なし".
//   - The system prompt is supplied dynamically: getSystemMessageDescription()
//     is called by AbstractChatAgent per request, so it reads the active
//     persona's COMPOSED prompt from PersonaService AT SEND TIME. Switching or
//     editing a persona changes the next send's system prompt with no restart
//     and no re-registration.
// The dynamic-registration API (registerChatAgent/unregisterChatAgent) confirmed
// in §11 is still exercised: the agent is registered once at startup (see
// arschat-agents-frontend-module.ts).
//
// Model resolution is unchanged from M2: languageModelRequirements is driven live
// by ProviderSwitchService (both the AISettingsService override the registry
// prefers AND the instance field the base class falls back to).
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CLI_SETTINGS, isCliAgent } from 'arschat-providers/lib/common/cli-agents';
import { readCliSettings } from 'arschat-providers/lib/browser/cli-agent-preferences';
import { AbstractStreamParsingChatAgent, ChatAgentLocation, ChatSessionContext, SystemMessageDescription } from '@theia/ai-chat/lib/common/chat-agents';
import { AIVariableContext, LanguageModel, LanguageModelMessage, LanguageModelRequirement, LanguageModelResponse, ToolRequest } from '@theia/ai-core';
import { CodeChatResponseContent, MarkdownChatResponseContent, MutableChatRequestModel } from '@theia/ai-chat/lib/common/chat-model';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from './persona-service';
import { ArschatMemoryService } from './memory/memory-service';
import { isMockModel } from './memory/memory-utils';

@injectable()
export class ArschatChatAgent extends AbstractStreamParsingChatAgent {

    readonly id = ARSCHAT_CHAT_AGENT_ID;
    readonly name = ARSCHAT_CHAT_AGENT_ID;

    override description = 'ArsChat default chat agent. System prompt reflects the active ArsChat persona (and its skills catalogue); model follows the header provider/model selection (Anthropic / OpenAI / LM Studio / Unsloth Studio).';

    override readonly locations = ChatAgentLocation.ALL;

    protected override readonly defaultLanguageModelPurpose = ARSCHAT_CHAT_PURPOSE;

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    @inject(ArschatMemoryService)
    protected readonly memory!: ArschatMemoryService;

    @inject(PreferenceService) protected readonly cliPreferences!: PreferenceService;
    @inject(WorkspaceService) protected readonly cliWorkspace!: WorkspaceService;

    private readonly mockRequests = new WeakSet<MutableChatRequestModel>();

    /**
     * Non-readonly so ProviderSwitchService can rewrite it on provider switch.
     * Seeded with a bare `chat` purpose (no identifier) so that, until the first
     * switch is applied, the AISettingsService override (the registry-preferred
     * path) is what selects the model.
     */
    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: ARSCHAT_CHAT_PURPOSE }];

    /**
     * Expose the base class' `additionalToolRequests` so arschat-tools (M5 e-2)
     * can attach the file tools (read/write/edit) to this agent's requests. The
     * base `invoke()` spreads `additionalToolRequests` into the tools handed to
     * the language model (chat-agents.js), so setting them here makes the tools
     * resolvable on every ArsChat request without touching @mention parsing.
     */
    setToolRequests(tools: ToolRequest[]): void {
        this.additionalToolRequests = tools;
    }

    /**
     * Called by AbstractChatAgent per request. Reads the ACTIVE persona's composed
     * system prompt from PersonaService at send time, so persona switch/edit takes
     * effect immediately (no restart, no re-registration).
     */
    protected override async getSystemMessageDescription(context: AIVariableContext): Promise<SystemMessageDescription | undefined> {
        await this.personaService.ready();
        const persona = this.personaService.getActiveEffectiveSystemPrompt();
        // The base class passes ChatSessionContext, including THIS request. No shared mutable recall state.
        const query = ChatSessionContext.is(context) ? context.request?.request.text : undefined;
        const text = persona + (query ? await this.memory.recallBlock(query) : '');
        // Resolve at request time so late MCP registration and enabled changes are reflected immediately.
        const functions = this.memory.readTools();
        return text || functions.length ? { text, functionDescriptions: new Map(functions.map(tool => [tool.id, tool])) } : undefined;
    }

    protected override async sendLlmRequest(request: MutableChatRequestModel, messages: LanguageModelMessage[], tools: ToolRequest[],
        model: LanguageModel, promptVariantId?: string, customized?: boolean): Promise<LanguageModelResponse> {
        // Check the actual selected model too: AISettingsService can override ProviderSwitchService.
        if (isMockModel(model.id)) { this.mockRequests.add(request); }
        if (isCliAgent(model.id)) {
            await this.cliPreferences.ready;
            const settings = readCliSettings((key, fallback) => this.cliPreferences.get(key, fallback));
            if (!settings.workingDirectory) {
                const root = (await this.cliWorkspace.roots)[0];
                if (root?.resource.scheme === 'file') { settings.workingDirectory = FileUri.fsPath(root.resource); }
            }
            return this.languageModelService.sendRequest(model, {
                messages, settings: { [CLI_SETTINGS]: settings }, agentId: this.id,
                sessionId: request.session.id, requestId: request.id,
                cancellationToken: request.response.cancellationToken,
                promptVariantId, isPromptVariantCustomized: customized
            });
        }
        return super.sendLlmRequest(request, messages, tools, model, promptVariantId, customized);
    }

    protected override async onResponseComplete(request: MutableChatRequestModel): Promise<void> {
        await super.onResponseComplete(request);
        if (request.response.isCanceled || request.response.isError || this.mockRequests.has(request)) { return; }
        const assistant = request.response.response.content.flatMap(content => {
            if (MarkdownChatResponseContent.is(content)) { return [content.content.value]; }
            if (CodeChatResponseContent.is(content)) { return [content.code]; }
            return []; // Exclude native thinking, tool arguments/results, errors and UI payloads.
        }).join('\n');
        void this.memory.save({ user: request.request.text, assistant, sessionId: request.session.id, requestId: request.id });
    }
}
