// *****************************************************************************
// ArsChat agents extension - frontend DI module (PHASE1_DESIGN.md §6, M4).
//
// Binds and wires the persona + skill halves of arschat-agents:
//   - PersonaService  (persona CRUD/persistence/active tracking + prompt compose)
//   - SkillService    (skill .md loading, sample seeding, slash expansion)
//   - the ArsChat ChatAgent (single agent reflecting the active persona -
//     see arschat-chat-agent.ts for the §6 registration-approach rationale),
//     registered once via ChatAgentService.registerChatAgent + AgentService, and
//     handed to ProviderSwitchService (M2 model-switch wiring, unchanged).
//   - a reload command (skills reload without restart, §6 item 4).
//
// PersonaService and SkillService are also exported for cross-package use by the
// chat widget (persona dropdown + slash completion) via
// arschat-agents/lib/browser/*.
// *****************************************************************************

import { ContainerModule, interfaces, injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { AgentService } from '@theia/ai-core';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { ArschatChatAgent } from './arschat-chat-agent';
import { PersonaService } from './persona-service';
import { SkillService } from './skill-service';
import { ArschatPersonaManagementWidget } from './persona-management-widget';
import { ArschatPersonaManagementContribution } from './persona-management-contribution';
import { ArschatM4AutotestContribution } from './arschat-m4-autotest-contribution';

import '../../src/browser/style/index.css';

export const ArschatReloadSkillsCommand: Command = {
    id: 'arschat-agents:skills:reload',
    label: 'ArsChat: スキルを再読み込み'
};

@injectable()
export class ArschatAgentsRegistrationContribution implements FrontendApplicationContribution, CommandContribution {

    @inject(ArschatChatAgent)
    protected readonly agent!: ArschatChatAgent;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(AgentService)
    protected readonly agentService!: AgentService;

    @inject(ProviderSwitchService)
    protected readonly switchService!: ProviderSwitchService;

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    @inject(SkillService)
    protected readonly skillService!: SkillService;

    onStart(): void {
        // Let the composed system prompt include the skills catalogue.
        this.personaService.setSkillCatalog(this.skillService);

        // Register the single ArsChat chat agent (dynamic-registration API, §11).
        this.chatAgentService.registerChatAgent(this.agent);
        this.agentService.registerAgent(this.agent);
        // Keep the M2 provider-switch wiring: drive this agent's model requirement.
        this.switchService.registerAgent(this.agent.id, this.agent);
        console.log(`[arschat-agents] registered ArsChat chat agent (id='${this.agent.id}') with persona-driven system prompt`);
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatReloadSkillsCommand, {
            execute: () => this.skillService.reload()
        });
    }
}

export function bindArschatAgents(bind: interfaces.Bind): void {
    bind(PersonaService).toSelf().inSingletonScope();
    bind(SkillService).toSelf().inSingletonScope();
    bind(ArschatChatAgent).toSelf().inSingletonScope();
    bind(ArschatAgentsRegistrationContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatAgentsRegistrationContribution);
    bind(CommandContribution).toService(ArschatAgentsRegistrationContribution);

    // Persona management panel (left-sidebar View).
    bindViewContribution(bind, ArschatPersonaManagementContribution);
    bind(FrontendApplicationContribution).toService(ArschatPersonaManagementContribution);
    bind(ArschatPersonaManagementWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatPersonaManagementWidget.ID,
        createWidget: () => ctx.container.get<ArschatPersonaManagementWidget>(ArschatPersonaManagementWidget)
    })).inSingletonScope();

    // M4 autotest (no-op unless ARSCHAT_M4_AUTOTEST=1).
    bind(ArschatM4AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM4AutotestContribution);
}

export default new ContainerModule(bind => {
    bindArschatAgents(bind);
});
