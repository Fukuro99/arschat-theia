// *****************************************************************************
// ArsChat PoC-2 (2-1): the chat widget must occupy the main area on startup,
// instead of an editor / Getting Started page (which doesn't exist here since
// @theia/getting-started is not a dependency, but the main area would
// otherwise simply be empty).
//
// `AbstractViewContribution` alone only registers a command/menu/keybinding
// to *toggle* the view - it does not by itself guarantee the widget is shown
// on first boot, nor that it survives across restarts once a user has closed
// it. To guarantee "chat is the first thing you see" for the PoC, this class
// also implements `FrontendApplicationContribution`:
//   - `initializeLayout` fires only when there is no persisted shell layout
//     yet (fresh profile / first run) - the standard hook for seeding a
//     default layout.
//   - `onStart` additionally force-opens+activates the widget on *every*
//     startup (not just the first), which matters for a PoC where we
//     repeatedly stop/start the app during verification and don't want a
//     previously-closed widget to leave the main area empty.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { ArschatCoreWidget } from './arschat-core-widget';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';

export const ArschatCoreCommand: Command = { id: 'arschat-core:command' };

@injectable()
export class ArschatCoreContribution extends AbstractViewContribution<ArschatCoreWidget> implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: ArschatCoreWidget.ID,
            widgetName: ArschatCoreWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: ArschatCoreCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatCoreCommand, {
            execute: () => super.openView({ activate: true, reveal: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    /**
     * PoC-2 (2-1): seeds the default layout on first run (no persisted
     * workbench state yet) so the chat widget occupies the main area
     * immediately, instead of an empty main panel.
     */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: true, reveal: true });
        console.log('[PoC-2] initializeLayout: chat widget opened in main area (fresh layout)');
    }

    /**
     * PoC-2 (2-1): also force-open on every subsequent startup, in case a
     * previous session persisted a layout where the widget was closed. This
     * keeps "chat occupies the main area on launch" true across restarts,
     * which matters for repeated PoC verification runs.
     */
    async onStart(_app: FrontendApplication): Promise<void> {
        const widget = await this.openView({ activate: true, reveal: true });
        console.log(`[PoC-2] onStart: chat widget activated (id=${widget.id})`);
    }
}
