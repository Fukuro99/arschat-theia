// *****************************************************************************
// ArsChat stock side-view restorer (MS12/MS15).
//
// Explorer, Search, Outline, and Extensions are now legitimate ArsChat
// user-facing stock Theia views. Earlier dilution builds could save a persisted
// layout while one or more of these views were absent. Removing a contribution
// filter only repairs fresh layouts: AbstractViewContribution.initializeLayout()
// self-docks during first layout creation, but existing users keep the old
// persisted layout unless we put the missing stock widgets back after restore.
//
// This contribution runs after ShellLayoutRestorer has initialized/restored the
// layout. For each configured (factory id, side area) pair, it creates/reuses the
// stock widget and docks it into the expected side if absent. It does not activate
// or reveal any view; the chat remains the active product surface, and this only
// restores the activity-bar entries.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    ApplicationShell,
    FrontendApplication,
    FrontendApplicationContribution,
    WidgetManager
} from '@theia/core/lib/browser';
import { EXPLORER_VIEW_CONTAINER_ID } from '@theia/navigator/lib/browser/navigator-widget-factory';
import { OUTLINE_WIDGET_FACTORY_ID } from '@theia/outline-view/lib/browser/outline-view-contribution';
import { SEARCH_VIEW_CONTAINER_ID } from '@theia/search-in-workspace/lib/browser/search-in-workspace-factory';
import { VSXExtensionsViewContainer } from '@theia/vsx-registry/lib/browser/vsx-extensions-view-container';

type RestoredSideViewArea = 'left' | 'right';

export interface RestoredSideView {
    readonly id: string;
    readonly area: RestoredSideViewArea;
}

export const RESTORED_SIDE_VIEWS: readonly RestoredSideView[] = [
    { id: EXPLORER_VIEW_CONTAINER_ID, area: 'left' },
    // The Search child widget has a direct factory id `search-in-workspace`, but
    // SearchInWorkspaceFrontendContribution docks the stock activity-bar surface
    // through the view-container factory `search-view-container`.
    { id: SEARCH_VIEW_CONTAINER_ID, area: 'left' },
    { id: OUTLINE_WIDGET_FACTORY_ID, area: 'right' },
    { id: VSXExtensionsViewContainer.ID, area: 'left' },
    { id: 'arschat-extensions:manager', area: 'left' }
];

@injectable()
export class ArschatSideViewRestorer implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        await this.restoreConfiguredSideViews();
    }

    async restoreConfiguredSideViews(): Promise<string[]> {
        const restored: string[] = [];
        for (const view of RESTORED_SIDE_VIEWS) {
            try {
                if (this.isDocked(view)) {
                    console.log(`[arschat-side-views] ${view.id} already docked on the ${view.area}`);
                    continue;
                }
                const widget = await this.widgetManager.getOrCreateWidget(view.id);
                await this.shell.addWidget(widget, { area: view.area });
                restored.push(widget.id);
                console.log(`[arschat-side-views] restored ${widget.id} into the ${view.area} side panel`);
            } catch (error) {
                // Keep later stock view restorations alive when an app target omits
                // an optional view contribution/factory from its dependency graph.
                console.warn(`[arschat-side-views] failed to restore ${view.id}; continuing`, error);
            }
        }
        return restored;
    }

    protected isDocked(view: RestoredSideView): boolean {
        return this.shell.getWidgets(view.area).some(widget => widget.id === view.id);
    }
}
