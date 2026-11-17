// *****************************************************************************
// ArsChat branding - frontend DI module ("the app skin", frontend layer).
//
// Moved here from arschat-core during the M1 package re-org. Registers:
//   - the IDE-dilution FilterContribution (removes Selection/Go/Terminal menus)
//   - the flag-gated PoC-3/PoC-4/M12/M15 frontend regression autotests
//
// The chat view itself (widget, view contribution, custom response renderer)
// now lives in arschat-chat. This module carries only shell-level branding /
// IDE-dilution + the regression autotests, per PHASE1_DESIGN.md §2 (which lets
// the frontend "IDE dilution" and layout enforcement be treated as part of the
// app skin). Layout enforcement is kept with the chat view in arschat-chat
// because it is intrinsic to that view; only IDE dilution lives here.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { FilterContribution } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PluginViewRegistry } from '@theia/plugin-ext/lib/main/browser/view/plugin-view-registry';
import { ArschatPluginViewRegistry } from './arschat-plugin-view-registry';
import { ArschatMenuFilterContribution } from './arschat-ide-dilution';
import { ArschatStaleIdeViewCleanup } from './arschat-stale-ide-view-cleanup';
import { ArschatSideViewRestorer } from './arschat-extensions-view-restorer';
import { ArschatM12AutotestContribution } from './arschat-m12-autotest-contribution';
import { ArschatM15AutotestContribution } from './arschat-m15-autotest-contribution';
import { ArschatPoc3AutotestContribution } from './arschat-poc3-autotest-contribution';
import { ArschatPoc4AutotestContribution } from './arschat-poc4-autotest-contribution';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    // @theia/plugin-ext is a dependency and loads first. Its contribution's
    // toService(PluginViewRegistry) alias follows this replacement singleton.
    const bindPluginViewRegistry = isBound(PluginViewRegistry) ? rebind : bind;
    bindPluginViewRegistry(PluginViewRegistry).to(ArschatPluginViewRegistry).inSingletonScope();

    // IDE-dilution: menu filtering (Selection/Go/Terminal). Status bar
    // visibility is handled declaratively via electron-app/package.json
    // `theia.frontend.config.preferences`, not here.
    bind(ArschatMenuFilterContribution).toSelf().inSingletonScope();
    bind(FilterContribution).toService(ArschatMenuFilterContribution);

    // Stale-layout safety net: closes any diluted IDE / stock-chat side view that a
    // persisted layout restored (the filter above only stops FRESH self-docking).
    bind(ArschatStaleIdeViewCleanup).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatStaleIdeViewCleanup);

    // MS12/MS15: persisted layouts saved while stock views were diluted do not
    // re-run the stock initializeLayout paths, so restore the configured side
    // views after layout initialization without activating/revealing them.
    bind(ArschatSideViewRestorer).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatSideViewRestorer);

    // PoC-3: flag-gated autotest (opens the vsx-registry Extensions view,
    // logs deployed plugins, dumps ESLint problem markers).
    bind(ArschatPoc3AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatPoc3AutotestContribution);

    // PoC-4: flag-gated autotest (checks Anthropic provider wiring + MCP server
    // start/tool listing + custom renderer registration, opens the AI chat view).
    bind(ArschatPoc4AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatPoc4AutotestContribution);

    // MS12: flag-gated frontend autotest for the restored Extensions view and
    // Open VSX-backed live search.
    bind(ArschatM12AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM12AutotestContribution);

    // MS15: flag-gated frontend autotest for restored Explorer/Search/Outline
    // plus the updated dilution regression expectations.
    bind(ArschatM15AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM15AutotestContribution);
});
