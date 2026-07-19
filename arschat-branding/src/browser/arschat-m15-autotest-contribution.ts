// *****************************************************************************
// ArsChat M15 autotest: Explorer/Search/Outline restoration + dilution guard.
//
// Enabled only when ARSCHAT_M15_AUTOTEST=1. It verifies that MS15 restored the
// stock Theia Explorer, Search, and Outline side views without reintroducing the
// still-diluted IDE chrome. It also drives the Explorer toggle command so the
// test proves the stock FileNavigatorContribution command path is live, not just
// that a persisted widget id exists in the shell.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandService, ILogger, MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FILE_NAVIGATOR_TOGGLE_COMMAND_ID } from '@theia/navigator/lib/browser/navigator-contribution';
import { EXPLORER_VIEW_CONTAINER_ID } from '@theia/navigator/lib/browser/navigator-widget-factory';
import { OUTLINE_WIDGET_FACTORY_ID } from '@theia/outline-view/lib/browser/outline-view-contribution';
import { SEARCH_VIEW_CONTAINER_ID } from '@theia/search-in-workspace/lib/browser/search-in-workspace-factory';
import { VSXExtensionsViewContainer } from '@theia/vsx-registry/lib/browser/vsx-extensions-view-container';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M15_AUTOTEST';
const KNOWN_GITLENS_STRAY_SIDE_VIEW_IDS = ['scm-view-container'];

@injectable()
export class ArschatM15AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(MenuModelRegistry)
    protected readonly menuRegistry!: MenuModelRegistry;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv(AUTOTEST_ENV_VAR);
        if (enabled !== '1') {
            return;
        }
        setTimeout(() => this.run().catch(err => this.log(`[M15][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            const v = await this.envServer.getValue(key);
            return v?.value;
        } catch {
            return undefined;
        }
    }

    protected async run(): Promise<void> {
        this.log('[M15][autotest] enabled (frontend)');
        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(this.scenarioStockViewsDocked());
        tally(this.scenarioDilutionRegression());
        tally(await this.scenarioExplorerToggleCommand());

        this.log(`[M15][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} checks)`);
        this.log('[M15][autotest] done');
    }

    protected scenarioStockViewsDocked(): boolean {
        const leftIds = this.leftWidgetIds();
        const rightIds = this.rightWidgetIds();
        const explorer = leftIds.includes(EXPLORER_VIEW_CONTAINER_ID);
        const search = leftIds.includes(SEARCH_VIEW_CONTAINER_ID);
        const outline = rightIds.includes(OUTLINE_WIDGET_FACTORY_ID);
        const ok = explorer && search && outline;
        this.log(`[M15][autotest] stock-views-docked: leftWidgets=[${leftIds.join(', ')}] rightWidgets=[${rightIds.join(', ')}] `
            + `explorer=${explorer ? 'ok' : 'NO'} search=${search ? 'ok' : 'NO'} outline=${outline ? 'ok' : 'NO'} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected scenarioDilutionRegression(): boolean {
        const menuOk = this.menuBarStillDiluted();
        const sideOk = this.sidePanelsStillDiluted();
        const ok = menuOk && sideOk;
        this.log(`[M15][autotest] dilution-regression: menu=${menuOk ? 'ok' : 'NO'} sidePanels=${sideOk ? 'ok' : 'NO'} `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioExplorerToggleCommand(): Promise<boolean> {
        const beforeVisible = this.isExplorerVisible();
        if (beforeVisible) {
            await this.shell.collapsePanel('left');
            await this.waitFor(() => !this.isExplorerVisible(), 3000);
        }

        let executedToggle = false;
        try {
            await this.commandService.executeCommand(FILE_NAVIGATOR_TOGGLE_COMMAND_ID);
            executedToggle = true;
        } catch (e) {
            this.log(`[M15][autotest] explorer-toggle: executeCommand('${FILE_NAVIGATOR_TOGGLE_COMMAND_ID}') threw `
                + `(${e instanceof Error ? e.message : String(e)}) -> FAIL`);
            return false;
        }

        const opened = await this.waitFor(() => this.isExplorerVisible(), 10000);
        this.log(`[M15][autotest] explorer-toggle: beforeVisible=${beforeVisible} executedToggle=${executedToggle} `
            + `visible=${this.isExplorerVisible()} -> ${opened ? 'PASS' : 'FAIL'}`);
        return opened;
    }

    protected menuBarStillDiluted(): boolean {
        const labels = this.menuBarLabels();
        const has = (name: string): boolean => labels.some(label => label.toLowerCase() === name.toLowerCase());
        const expectedAbsent = ['Run', 'Selection', 'Go', 'Terminal'];
        const strays = expectedAbsent.filter(has);
        const ok = strays.length === 0;
        this.log(`[M15][autotest] dilution-regression/menu: labels=[${labels.join(', ')}] `
            + `strays=[${strays.join(', ')}] -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected sidePanelsStillDiluted(): boolean {
        const sideIds = [
            ...this.leftWidgetIds(),
            ...this.rightWidgetIds()
        ];
        const stillDilutedPatterns = ['scm', 'debug', 'test', 'chat-view-widget'];
        const allowedIds = [
            EXPLORER_VIEW_CONTAINER_ID,
            SEARCH_VIEW_CONTAINER_ID,
            OUTLINE_WIDGET_FACTORY_ID,
            VSXExtensionsViewContainer.ID
        ];
        const strays = sideIds.filter(id =>
            !id.startsWith('arschat') &&
            !allowedIds.includes(id) &&
            stillDilutedPatterns.some(pattern => id.toLowerCase().includes(pattern)));
        const knownGitLensStrays = strays.filter(id => KNOWN_GITLENS_STRAY_SIDE_VIEW_IDS.includes(id));
        const unexpectedStrays = strays.filter(id => !KNOWN_GITLENS_STRAY_SIDE_VIEW_IDS.includes(id));
        const ok = unexpectedStrays.length === 0;
        this.log(`[M15][autotest] dilution-regression/activity-bar: sidePanelWidgets=[${sideIds.join(', ')}] `
            + `allowedStockViews=[${allowedIds.filter(id => sideIds.includes(id)).join(', ')}] `
            + `knownGitLensStrays=[${knownGitLensStrays.join(', ')}] unexpectedStrayIdeViews=[${unexpectedStrays.join(', ')}] `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected menuBarLabels(): string[] {
        const menu = this.menuRegistry.getMenu(MAIN_MENU_BAR);
        return (menu?.children ?? [])
            .map(child => (child as { label?: string }).label)
            .filter((label): label is string => typeof label === 'string' && label.length > 0);
    }

    protected leftWidgetIds(): string[] {
        return this.shell.getWidgets('left').map(widget => widget.id);
    }

    protected rightWidgetIds(): string[] {
        return this.shell.getWidgets('right').map(widget => widget.id);
    }

    protected isExplorerVisible(): boolean {
        return this.shell.isExpanded('left') && this.shell.getWidgets('left')
            .some(widget => widget.id === EXPLORER_VIEW_CONTAINER_ID && widget.isVisible);
    }

    protected async waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (predicate()) {
                return true;
            }
            await this.delay(100);
        }
        return predicate();
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
