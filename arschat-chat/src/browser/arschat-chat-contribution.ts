// *****************************************************************************
// ArsChat chat view contribution: the chat widget must occupy the main area on
// startup instead of an empty main panel (PoC-2 2-1, preserved through M1).
//
// Moved here from arschat-core (`ArschatCoreContribution`) during the M1
// package re-org and renamed. The layout-forcing lives WITH the chat view
// (rather than in arschat-branding) because it is intrinsic to *this* view:
// it opens/activates this specific widget. arschat-branding keeps only the
// truly shell-level "app skin" concerns (tray, window, IDE menu dilution).
// This is the placement judgment PHASE1_DESIGN.md §2 delegates - rationale
// recorded in BUILD_NOTES.md M1.
//
// `AbstractViewContribution` alone only registers a command/menu/keybinding to
// *toggle* the view; it does not guarantee the widget is shown on first boot
// nor that it survives across restarts once a user closed it. So this class
// also implements `FrontendApplicationContribution`:
//   - `initializeLayout` fires only when there is no persisted shell layout
//     yet (fresh profile / first run) - the standard seed-default-layout hook.
//   - `onStart` additionally force-opens+activates the widget on *every*
//     startup, which also self-heals a persisted layout that still references
//     the old 'arschat-core:widget' id (that stale entry is simply dropped by
//     Theia as an unknown widget, and this re-opens the new one).
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { ArschatChatWidget } from './arschat-chat-widget';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';

export const ArschatChatCommand: Command = { id: 'arschat-chat:command' };

@injectable()
export class ArschatChatContribution extends AbstractViewContribution<ArschatChatWidget> implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: ArschatChatWidget.ID,
            widgetName: ArschatChatWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: ArschatChatCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatChatCommand, {
            execute: () => super.openView({ activate: true, reveal: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    /**
     * Seeds the default layout on first run (no persisted workbench state yet)
     * so the chat widget occupies the main area immediately.
     */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: true, reveal: true });
        console.log('[arschat-chat] initializeLayout: chat widget opened in main area (fresh layout)');
    }

    /**
     * Force-open on every subsequent startup too, in case a previous session
     * persisted a layout where the widget was closed (or referenced the old
     * 'arschat-core:widget' id). Keeps "chat occupies the main area on launch"
     * true across restarts.
     */
    async onStart(_app: FrontendApplication): Promise<void> {
        const widget = await this.openView({ activate: true, reveal: true });
        console.log(`[arschat-chat] onStart: chat widget activated (id=${widget.id})`);
    }
}
