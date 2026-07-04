// *****************************************************************************
// ArsChat persona management view contribution (PHASE1_DESIGN.md §6, M4).
//
// Registers the persona-management panel as a left-sidebar View (a normal
// toggleable view, like the M3 history panel). Seeded into the left area on
// first run; thereafter follows the persisted shell layout.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { ArschatPersonaManagementWidget } from './persona-management-widget';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';

export const ArschatPersonaCommand: Command = { id: 'arschat-agents:personas:toggle', label: 'ArsChat: ペルソナ管理を表示' };

@injectable()
export class ArschatPersonaManagementContribution extends AbstractViewContribution<ArschatPersonaManagementWidget> implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: ArschatPersonaManagementWidget.ID,
            widgetName: ArschatPersonaManagementWidget.LABEL,
            defaultWidgetOptions: { area: 'left', rank: 200 },
            toggleCommandId: ArschatPersonaCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatPersonaCommand, {
            execute: () => super.openView({ activate: true, reveal: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    /** Seed the persona panel into the left area on first run. */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: false });
        console.log('[arschat-agents] initializeLayout: persona panel added to the left area (fresh layout)');
    }
}
