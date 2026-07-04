// *****************************************************************************
// ArsChat agents extension - frontend DI module (PHASE1_DESIGN.md §6, M2 stopgap).
//
// Registers the minimal ArsChat chat agent (see arschat-chat-agent.ts) with:
//   - ChatAgentService.registerChatAgent  (so ChatService can route to it)
//   - AgentService.registerAgent          (so ai-core knows it: settings, activation)
// mirroring the canonical dynamic-registration pattern used by Theia's own
// CustomAgentFactory (ai-chat-frontend-module.js).
//
// It then hands the live agent instance to ProviderSwitchService so header-driven
// provider switches rewrite this agent's model requirement.
//
// The full persona/skill implementation still lands in M4; this is the M2
// stopgap needed to demonstrate the 4-provider round-trip.
// *****************************************************************************

import { ContainerModule, interfaces, injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AgentService } from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { ArschatChatAgent } from './arschat-chat-agent';

@injectable()
export class ArschatAgentsRegistrationContribution implements FrontendApplicationContribution {

    @inject(ArschatChatAgent)
    protected readonly agent!: ArschatChatAgent;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(AgentService)
    protected readonly agentService!: AgentService;

    @inject(ProviderSwitchService)
    protected readonly switchService!: ProviderSwitchService;

    onStart(): void {
        this.chatAgentService.registerChatAgent(this.agent);
        this.agentService.registerAgent(this.agent);
        // Let the switch service drive this agent's model requirement from the active-provider preference.
        this.switchService.registerAgent(this.agent.id, this.agent);
        console.log(`[arschat-agents] registered ArsChat chat agent (id='${this.agent.id}')`);
    }
}

export function bindArschatAgents(bind: interfaces.Bind): void {
    bind(ArschatChatAgent).toSelf().inSingletonScope();
    bind(ArschatAgentsRegistrationContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatAgentsRegistrationContribution);
}

export default new ContainerModule(bind => {
    bindArschatAgents(bind);
});
