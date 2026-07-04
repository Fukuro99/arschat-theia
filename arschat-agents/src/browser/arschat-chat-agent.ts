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
import { AbstractStreamParsingChatAgent, ChatAgentLocation, SystemMessageDescription } from '@theia/ai-chat/lib/common/chat-agents';
import { LanguageModelRequirement } from '@theia/ai-core';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import { PersonaService } from './persona-service';

@injectable()
export class ArschatChatAgent extends AbstractStreamParsingChatAgent {

    readonly id = ARSCHAT_CHAT_AGENT_ID;
    readonly name = ARSCHAT_CHAT_AGENT_ID;

    override description = 'ArsChat default chat agent. System prompt reflects the active ArsChat persona (and its skills catalogue); model follows the header provider/model selection (Anthropic / OpenAI / LM Studio / Unsloth Studio).';

    override readonly locations = ChatAgentLocation.ALL;

    protected override readonly defaultLanguageModelPurpose = ARSCHAT_CHAT_PURPOSE;

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    /**
     * Non-readonly so ProviderSwitchService can rewrite it on provider switch.
     * Seeded with a bare `chat` purpose (no identifier) so that, until the first
     * switch is applied, the AISettingsService override (the registry-preferred
     * path) is what selects the model.
     */
    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: ARSCHAT_CHAT_PURPOSE }];

    /**
     * Called by AbstractChatAgent per request. Reads the ACTIVE persona's composed
     * system prompt from PersonaService at send time, so persona switch/edit takes
     * effect immediately (no restart, no re-registration).
     */
    protected override async getSystemMessageDescription(): Promise<SystemMessageDescription | undefined> {
        await this.personaService.ready();
        const text = this.personaService.getActiveEffectiveSystemPrompt();
        return text ? { text } : undefined;
    }
}
