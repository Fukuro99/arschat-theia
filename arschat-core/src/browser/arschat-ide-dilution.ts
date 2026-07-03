// *****************************************************************************
// ArsChat PoC-2 (2-2): "dilute" the IDE look, without touching Theia's
// node_modules sources.
//
// `FilterContribution` / `ContributionFilterRegistry` (from
// `@theia/core/lib/common/contribution-filter`). `ContributionProvider`
// calls `ContributionFilterRegistry.applyFilters(contributions, type)`
// for every multi-bound contribution type (CommandContribution,
// MenuContribution, KeybindingContribution, FrontendApplicationContribution,
// ...) - see node_modules/@theia/core/lib/common/contribution-provider.js:48.
// Because packages like `@theia/terminal` bind ONE class
// (`TerminalFrontendContribution`) separately to SEVERAL contribution
// symbols (CommandContribution, MenuContribution, KeybindingContribution,
// FrontendApplicationContribution, TabBarToolbarContribution,
// ColorContribution - see terminal-frontend-module.js:79), filtering it
// out *only* for the `MenuContribution` type removes just its top-level
// "Terminal" menu while leaving the terminal panel/commands/keybindings
// intact. This is exactly the granularity PoC-2 needs: remove menu
// clutter without breaking the underlying feature.
//
// There is no `unregisterSubmenu` API on `MenuModelRegistry` (only
// `unregisterMenuAction`, which removes individual leaf actions by id,
// not a whole submenu) - so filtering the *contributing class* out of
// the `MenuContribution` multibinding, before it ever runs
// `registerMenus()`, is the only way to make an entire top-level menu
// (e.g. "Selection", "Go", "Terminal") never appear at all.
//
// The status bar is NOT hidden with a FilterContribution / hand-written
// PreferenceContribution here - it uses an even simpler, zero-code, fully
// declarative mechanism instead: `theia.frontend.config.preferences` in
// electron-app/package.json (see that file). Theia's own built-in
// `FrontendConfigPreferenceContribution`
// (node_modules/@theia/core/lib/browser/preferences/frontend-config-preference-contributions.js)
// reads that config block and calls
// `PreferenceSchemaService.registerOverride(key, undefined, value)` for
// every entry, which is the exact same API this file would otherwise have
// had to call by hand. Since Theia already ships this contribution and
// wires it up automatically, no extension code is needed at all for
// preference-default overrides - only a package.json entry.
//
// Given this app's electron-app/package.json dependencies (@theia/core,
// editor, electron, filesystem, markers, messages, monaco, navigator,
// preferences, process, terminal, workspace), @theia/scm, @theia/debug and
// @theia/search-in-workspace are NOT present at all, so their activity-bar
// icons and "Run"/"Debug"/global-"Search" menus never register in the first
// place - nothing to filter for those (see BUILD_NOTES.md for the full
// audit). The only real IDE-menu clutter that *does* get contributed by the
// current dependency set is:
//   - "Selection" (from @theia/monaco -> MonacoEditorMenuContribution)
//   - "Go"        (from @theia/editor -> EditorMenuContribution)
//   - "Terminal"  (from @theia/terminal -> TerminalFrontendContribution)
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { ContributionFilterRegistry, FilterContribution, MenuContribution } from '@theia/core';
import { MonacoEditorMenuContribution } from '@theia/monaco/lib/browser/monaco-menu';
import { EditorMenuContribution } from '@theia/editor/lib/browser/editor-menu';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';

/**
 * 2-2 (menus): filters the "Selection", "Go" and "Terminal" top-level menus
 * out of the main menu bar by removing their contributing classes from the
 * `MenuContribution` multibinding before `registerMenus()` is ever invoked.
 * Only the `MenuContribution` type is filtered - `CommandContribution` /
 * `KeybindingContribution` / `FrontendApplicationContribution` bindings for
 * the very same classes are left untouched, so e.g. the terminal panel and
 * its commands/keybindings keep working; only its menu entry disappears.
 */
@injectable()
export class ArschatMenuFilterContribution implements FilterContribution {
    registerContributionFilters(registry: ContributionFilterRegistry): void {
        registry.addFilters([MenuContribution], [
            contrib => {
                const keep = !(contrib instanceof MonacoEditorMenuContribution)
                    && !(contrib instanceof EditorMenuContribution)
                    && !(contrib instanceof TerminalFrontendContribution);
                if (!keep) {
                    console.log(`[PoC-2] MenuContribution filtered out: ${contrib.constructor.name}`);
                }
                return keep;
            }
        ]);
        console.log('[PoC-2] ArschatMenuFilterContribution: filters registered for Selection/Go/Terminal menus');
    }
}
