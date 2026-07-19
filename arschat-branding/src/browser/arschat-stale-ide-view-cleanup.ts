// *****************************************************************************
// ArsChat stale IDE-view cleanup (M6 e-26).
//
// The `ArschatMenuFilterContribution` (arschat-ide-dilution.ts) prevents IDE
// side views from being ADDED on a FRESH layout: it filters the view's
// `FrontendApplicationContribution`, so its `initializeLayout()`/`onStart()`
// never runs and it never self-docks into the activity bar.
//
// But that filter does NOT cover a STALE persisted layout (the e-21 申し送り
// "永続レイアウトの罠"): if a previous run docked an IDE view (e.g. an earlier
// IDE-flavoured build, or the stock @theia/ai-chat-ui chat view) and the app was
// closed gracefully, Theia's `ShellLayoutRestorer` re-creates that widget by id
// via its still-registered `WidgetFactory` on the next start - the filter has no
// say in restore. The view would then reappear in the side panel.
//
// This contribution closes that gap: after the layout is initialized/restored
// (`onDidInitializeLayout`), it scans the left/right side panels and closes any
// widget whose id belongs to a diluted IDE view (or the stock AI chat view),
// never touching ArsChat's own `arschat-`prefixed views. On a clean layout it is
// a cheap no-op.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    ApplicationShell,
    FrontendApplication,
    FrontendApplicationContribution,
    Widget,
    WidgetManager
} from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { SCM_VIEW_CONTAINER_ID } from '@theia/scm/lib/browser/scm-contribution';

/**
 * Substrings that only a still-diluted IDE side view (or the stock
 * @theia/ai-chat-ui chat view, `chat-view-widget`) carries in its widget id.
 * Mirrors the id set the M6/M12/M15 autotests check for. ArsChat's own views are
 * `arschat-`prefixed and excluded. `vsx`/`extension` (ms-12) and
 * Explorer/Search/Outline (ms-15) are legitimate, user-facing views now, so a
 * persisted layout that restores them must be left intact.
 */
export const STALE_IDE_VIEW_ID_PATTERNS: readonly string[] = [
    'scm', 'debug', 'test', 'chat-view-widget'
];

/** True when `id` denotes a diluted IDE/stock-chat view (and not an ArsChat view). */
export function isStaleIdeViewId(id: string): boolean {
    if (id.startsWith('arschat')) {
        return false;
    }
    const lower = id.toLowerCase();
    return STALE_IDE_VIEW_ID_PATTERNS.some(p => lower.includes(p));
}

/** Filter a list of widget ids down to the ones a stale layout should not keep. */
export function selectStaleIdeViewIds(ids: readonly string[]): string[] {
    return ids.filter(isStaleIdeViewId);
}

@injectable()
export class ArschatStaleIdeViewCleanup implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    /**
     * Runs after the shell layout is initialized/restored. This is the point where
     * `ShellLayoutRestorer` has re-created any persisted widgets, so a stale IDE
     * view (if any) is now docked and can be removed.
     */
    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        // Verification-only seed (no-op in production): dock a REAL IDE view so the
        // removal path below is exercised against a genuine restored view in the
        // running shell. Gated by ARSCHAT_M6_SEED_STALE=1 (backend env), like the
        // other flag-gated autotests.
        if (await this.backendFlag('ARSCHAT_M6_SEED_STALE')) {
            await this.seedStaleViewForVerification();
        }
        this.removeStaleIdeViews();
    }

    /**
     * Close every diluted IDE/stock-chat view currently docked in the side panels.
     * Returns the ids that were removed (for testing / logging).
     */
    removeStaleIdeViews(): string[] {
        const sideWidgets: Widget[] = [
            ...this.shell.getWidgets('left'),
            ...this.shell.getWidgets('right')
        ];
        const removed: string[] = [];
        for (const widget of sideWidgets) {
            if (isStaleIdeViewId(widget.id)) {
                widget.close();
                widget.dispose();
                removed.push(widget.id);
                console.log(`[arschat-dilution] removed stale IDE view restored into the layout: ${widget.id}`);
            }
        }
        if (removed.length === 0) {
            console.log('[arschat-dilution] stale-layout scan: no stray IDE views to remove');
        } else {
            console.log(`[arschat-dilution] stale-layout scan: removed ${removed.length} stray view(s) [${removed.join(', ')}]`);
        }
        return removed;
    }

    protected async seedStaleViewForVerification(): Promise<void> {
        try {
            const widget = await this.widgetManager.getOrCreateWidget(SCM_VIEW_CONTAINER_ID);
            this.shell.addWidget(widget, { area: 'left' });
            console.log(`[arschat-dilution][seedtest] seeded a stale IDE view into the layout: ${widget.id}`);
        } catch (e) {
            console.log(`[arschat-dilution][seedtest] could not seed stale view: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    protected async backendFlag(key: string): Promise<boolean> {
        try {
            return (await this.envServer.getValue(key))?.value === '1';
        } catch {
            return false;
        }
    }
}
