// *****************************************************************************
// ArsChat IDE dilution: keep the product looking like a chat app, not an IDE,
// without touching Theia's node_modules sources.
//
// `FilterContribution` / `ContributionFilterRegistry` (from
// `@theia/core/lib/common/contribution-filter`). `ContributionProvider`
// calls `ContributionFilterRegistry.applyFilters(contributions, type)`
// for every multi-bound contribution type (CommandContribution,
// MenuContribution, KeybindingContribution, FrontendApplicationContribution,
// ...) - see node_modules/@theia/core/lib/common/contribution-provider.js:48.
// By filtering a contributing class out of a specific contribution *type*
// (before it ever runs), we can surgically remove a piece of IDE UI while
// leaving the rest of that class' bindings intact.
//
// -------------------------------------------------------------------------
// Two distinct kinds of IDE clutter, removed via two different filters:
//
// 1. Top-level MENU BAR entries (filter on `MenuContribution`)
//    A class' `registerMenus()` is what calls `registerSubmenu([...MAIN_MENU_BAR, ...])`
//    to add a top-level menu. There is no `unregisterSubmenu` API on
//    `MenuModelRegistry` (only `unregisterMenuAction`, which removes individual
//    leaf actions, not a whole submenu) - so filtering the contributing class
//    out of the `MenuContribution` multibinding, before `registerMenus()` runs,
//    is the only way to make an entire top-level menu never appear.
//    Top-level menus in the current dependency set (grep of `MAIN_MENU_BAR`):
//      - File / Edit / View / Help  -> @theia/core CommonFrontendContribution (KEEP)
//      - "Selection" (3_selection)  -> @theia/monaco  MonacoEditorMenuContribution
//      - "Go"        (5_go)         -> @theia/editor  EditorMenuContribution
//      - "Run"       (6_debug)      -> @theia/debug   DebugFrontendApplicationContribution
//      - "Terminal"  (7_terminal)   -> @theia/terminal TerminalFrontendContribution
//    The M5 plugin-ext expansion re-introduced only ONE new top-level menu:
//    "Run" (from @theia/debug). Selection/Go/Terminal were already filtered in
//    PoC-2; "Run" is the new addition here.
//
// 2. Left ACTIVITY BAR icons (filter on `FrontendApplicationContribution`)
//    Each IDE side view is contributed by an `AbstractViewContribution`
//    subclass that is *also* bound to `FrontendApplicationContribution`
//    (via `bindViewContribution` + an explicit `bind(FrontendApplicationContribution)`).
//    Its `initializeLayout()` calls `openView()` ->
//    `shell.addWidget(widget, { area: 'left' })`, which is what makes the view
//    container appear in the left activity bar (see
//    @theia/core/lib/browser/shell/view-contribution.js:64-76). Filtering the
//    class out of `FrontendApplicationContribution` suppresses that
//    `initializeLayout()` (and `onStart()`), so the IDE view never adds its own
//    activity-bar icon. These classes are ALSO filtered from `MenuContribution`
//    above, so their now-pointless "Toggle X" entries under the View menu (and
//    context-menu contributions) disappear too - the view is fully hidden.
//    Our own chat/history/persona views live in arschat-chat / arschat-agents
//    and are NOT filtered, so they remain in the activity bar. Explorer,
//    Search, Outline, and the vsx-registry Extensions view are deliberately
//    NOT filtered (ms-15/ms-12): these are now user-facing ArsChat surfaces,
//    and the stock views are kept as-is instead of custom UI. Their activity-bar
//    icons and View-menu toggles stay visible.
//
// Note: `notebook` does not contribute a left activity-bar icon (it is
// editor-hosted; it has no `initializeLayout`->`openView`), so there is nothing
// to filter there. The standard `@theia/ai-chat-ui` chat view (`AIChatContribution`,
// docked in the right side panel) IS filtered too (M6 e-26): ArsChat's own chat
// widget is the primary UI, so the redundant stock AI chat view is hidden to avoid
// a confusing "double chat".
//
// The status bar is hidden separately, declaratively, via
// `theia.frontend.config.preferences` (`workbench.statusBar.visible: false`) in
// electron-app/package.json - no code needed. Preferences can only hide the
// activity bar *in full* (`workbench.activityBar.visible`), which would also
// hide our own chat views, so per-view hiding must be done here with a filter.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { ContributionFilterRegistry, FilterContribution, MenuContribution } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoEditorMenuContribution } from '@theia/monaco/lib/browser/monaco-menu';
import { EditorMenuContribution } from '@theia/editor/lib/browser/editor-menu';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { ScmContribution } from '@theia/scm/lib/browser/scm-contribution';
import { DebugFrontendApplicationContribution } from '@theia/debug/lib/browser/debug-frontend-application-contribution';
import { TestViewContribution } from '@theia/test/lib/browser/view/test-view-contribution';
import { AIChatContribution } from '@theia/ai-chat-ui/lib/browser/ai-chat-ui-contribution';

/**
 * Classes whose top-level MENU-BAR entry must be removed. Each of these is a
 * `MenuContribution` whose `registerMenus()` adds a `[...MAIN_MENU_BAR, ...]`
 * submenu. Filtering them out of the `MenuContribution` type removes the whole
 * top-level menu (Selection / Go / Terminal / Run), leaving only File / Edit /
 * View / Help. The diluted IDE view contributions are included too, so their
 * "Toggle <view>" leaf entries under the View menu vanish along with the views.
 * Explorer/Search/Outline are intentionally omitted for MS15.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MENU_FILTERED: Array<new (...args: any[]) => object> = [
    // top-level menus
    MonacoEditorMenuContribution,          // "Selection"
    EditorMenuContribution,                // "Go"
    TerminalFrontendContribution,          // "Terminal"
    DebugFrontendApplicationContribution,  // "Run"
    // IDE side views (drop their View-menu toggle + context-menu entries)
    ScmContribution,
    TestViewContribution,
    // Stock @theia/ai-chat-ui chat view: ArsChat's own chat widget is the primary
    // UI, so the redundant stock AI chat view is hidden to avoid a "double chat"
    // (M6 e-26, orchestrator decision). Removes its View-menu toggle entry too.
    AIChatContribution
];

/**
 * Classes whose left ACTIVITY-BAR icon must be removed. Each is an
 * `AbstractViewContribution` bound to `FrontendApplicationContribution`; its
 * `initializeLayout()` self-adds the view to the left panel. Filtering them out
 * of `FrontendApplicationContribution` prevents that, so the IDE view never
 * appears in the activity bar. Explorer/Search/Outline are intentionally omitted
 * for MS15. `DebugFrontendApplicationContribution` is here too (its activity-bar
 * "Run and Debug" icon), on top of its "Run" menu removal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ACTIVITY_BAR_FILTERED: Array<new (...args: any[]) => object> = [
    ScmContribution,                       // Source Control
    DebugFrontendApplicationContribution,  // Run and Debug
    TestViewContribution,                  // Test
    AIChatContribution                     // stock AI chat view (double-chat avoidance)
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInstanceOfAny(obj: object, classes: Array<new (...args: any[]) => object>): boolean {
    return classes.some(ctor => obj instanceof ctor);
}

/**
 * IDE dilution: strips IDE-flavoured top-level menus and left activity-bar
 * icons that the M5 `@theia/plugin-ext` / `plugin-ext-vscode` / `vsx-registry`
 * dependency expansion pulled back in (scm / debug / task / test / notebook /
 * ...), while keeping the MS15 user-facing Explorer/Search/Outline views.
 * Restores the PoC-2 "chat app" chrome: a File / Edit / View / Help menu bar
 * and an activity bar carrying only ArsChat's own views plus the explicitly
 * restored stock views.
 */
@injectable()
export class ArschatMenuFilterContribution implements FilterContribution {
    registerContributionFilters(registry: ContributionFilterRegistry): void {
        // 1. Menu bar: remove Selection / Go / Terminal / Run + IDE view toggles.
        registry.addFilters([MenuContribution], [
            contrib => {
                const keep = !isInstanceOfAny(contrib, MENU_FILTERED);
                if (!keep) {
                    console.log(`[arschat-dilution] MenuContribution filtered out: ${contrib.constructor.name}`);
                }
                return keep;
            }
        ]);

        // 2. Activity bar: remove SCM / Debug / Test / stock AI chat icons by
        //    suppressing their initializeLayout().
        registry.addFilters([FrontendApplicationContribution], [
            contrib => {
                const keep = !isInstanceOfAny(contrib, ACTIVITY_BAR_FILTERED);
                if (!keep) {
                    console.log(`[arschat-dilution] FrontendApplicationContribution filtered out: ${contrib.constructor.name}`);
                }
                return keep;
            }
        ]);

        console.log('[arschat-dilution] ArschatMenuFilterContribution: menu + activity-bar filters registered');
    }
}
