// *****************************************************************************
// ArsChat Extensions view restorer (MS12).
//
// The vsx-registry Extensions view is now a legitimate ArsChat user-facing view:
// it lets users search/install Open VSX extensions from the stock Theia UI.
// Earlier dilution work filtered the VSX contribution out of the activity bar;
// Section 0 removes that filter for fresh layouts, but that alone does not repair an
// already-persisted layout profile that was saved while the Extensions container
// was absent. AbstractViewContribution.initializeLayout() only self-docks on a
// fresh layout, so existing users would keep missing the Extensions icon unless
// we put the container back after layout restore.
//
// This contribution runs after ShellLayoutRestorer has initialized/restored the
// layout. If the Extensions view container is not present in the left side panel,
// it creates/reuses the stock VSX container and docks it on the left. It does not
// activate or reveal the view; the chat remains the active product surface, and
// this only restores the activity-bar entry.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    ApplicationShell,
    FrontendApplication,
    FrontendApplicationContribution,
    WidgetManager
} from '@theia/core/lib/browser';
import { VSXExtensionsViewContainer } from '@theia/vsx-registry/lib/browser/vsx-extensions-view-container';

@injectable()
export class ArschatExtensionsViewRestorer implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        await this.restoreExtensionsViewContainer();
    }

    async restoreExtensionsViewContainer(): Promise<boolean> {
        const leftWidgets = this.shell.getWidgets('left');
        if (leftWidgets.some(widget => widget.id === VSXExtensionsViewContainer.ID)) {
            console.log('[arschat-extensions] Extensions view container already docked on the left');
            return false;
        }

        const widget = await this.widgetManager.getOrCreateWidget(VSXExtensionsViewContainer.ID);
        await this.shell.addWidget(widget, { area: 'left' });
        console.log(`[arschat-extensions] restored Extensions view container into the left activity bar: ${widget.id}`);
        return true;
    }
}
