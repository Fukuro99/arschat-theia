import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { ExtensionManagerWidget } from './extension-manager-widget';

export const ArschatExtensionsCommand: Command = {
    id: 'arschat-extensions:manager:toggle',
    label: 'ArsChat: Show Extensions'
};

@injectable()
export class ExtensionManagerContribution extends AbstractViewContribution<ExtensionManagerWidget> implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: ExtensionManagerWidget.ID,
            widgetName: ExtensionManagerWidget.LABEL,
            defaultWidgetOptions: { area: 'left', rank: 220 },
            toggleCommandId: ArschatExtensionsCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ArschatExtensionsCommand, {
            execute: () => super.openView({ activate: true, reveal: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: false });
    }
}
