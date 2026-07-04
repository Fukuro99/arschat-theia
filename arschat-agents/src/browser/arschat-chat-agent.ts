// *****************************************************************************
// ArsChat chat agent (PHASE1_DESIGN.md §4.2 / §6, M2 stopgap).
//
// A minimal ChatAgent brought forward from M4 so M2 can prove a full chat
// round-trip across all four providers. The real persona-driven agent (dynamic
// system-prompt composition, skills) lands in M4 - this one has a single fixed
// system prompt.
//
// Model resolution: its `languageModelRequirements` is driven live by
// ProviderSwitchService (arschat-providers). When the user flips the header
// dropdown, the switch service rewrites this agent's requirement AND the
// AISettingsService override, so `AbstractStreamParsingChatAgent.getLanguageModel`
// resolves the newly-active provider's model. See provider-switch-service.ts
// for the §10 risk analysis proving this is the correct wiring.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { AbstractStreamParsingChatAgent, ChatAgentLocation, SystemMessageDescription } from '@theia/ai-chat/lib/common/chat-agents';
import { LanguageModelRequirement } from '@theia/ai-core';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';

const ARSCHAT_SYSTEM_PROMPT = [
    'You are ArsChat, a helpful desktop AI assistant.',
    'Answer concisely and follow the user\'s instructions exactly.',
    'When the user asks you to reply with an exact string, reply with only that string and nothing else.'
].join(' ');

@injectable()
export class ArschatChatAgent extends AbstractStreamParsingChatAgent {

    readonly id = ARSCHAT_CHAT_AGENT_ID;
    readonly name = ARSCHAT_CHAT_AGENT_ID;

    override description = 'ArsChat default chat agent. Routes chat to the provider/model selected in the ArsChat header (Anthropic / OpenAI / LM Studio / Unsloth Studio).';

    override readonly locations = ChatAgentLocation.ALL;

    protected override readonly defaultLanguageModelPurpose = ARSCHAT_CHAT_PURPOSE;

    /**
     * Non-readonly so ProviderSwitchService can rewrite it on provider switch.
     * Seeded with a bare `chat` purpose (no identifier) so that, until the first
     * switch is applied, the AISettingsService override (the registry-preferred
     * path) is what selects the model.
     */
    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: ARSCHAT_CHAT_PURPOSE }];

    protected override async getSystemMessageDescription(): Promise<SystemMessageDescription | undefined> {
        return { text: ARSCHAT_SYSTEM_PROMPT };
    }
}
