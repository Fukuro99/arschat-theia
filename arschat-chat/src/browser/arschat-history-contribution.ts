// *****************************************************************************
// ArsChat history view contribution (PHASE1_DESIGN.md §5, M3).
//
// Registers the session-history panel as a left-sidebar View. Unlike the chat
// widget (which is force-opened into the main area on every start), the history
// panel is a normal toggleable View: it is seeded into the left area on first
// run via `initializeLayout`, and thereafter follows the persisted shell layout.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { ArschatHistoryWidget } from './arschat-history-widget';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';

export const ArschatHistoryCommand: Command = { id: 'arschat-chat:history:toggle', label: 'ArsChat: 履歴を表示' };

@injectable()
export class ArschatHistoryContribution extends AbstractViewContribution<ArschatHistoryWidget> implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: ArschatHistoryWidget.ID,
            widgetName: ArschatHistoryWidget.LABEL,
            defaultWidgetOptions: { area: 'left', rank: 100 },
            toggleCommandId: ArschatHistoryCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatHistoryCommand, {
            execute: () => super.openView({ activate: true, reveal: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    /** Seed the history panel into the left area on first run. */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: true });
        console.log('[arschat-chat] initializeLayout: history panel added to the left area (fresh layout)');
    }
}
