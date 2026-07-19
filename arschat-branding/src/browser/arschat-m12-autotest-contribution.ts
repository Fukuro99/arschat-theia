// *****************************************************************************
// ArsChat M12 autotest: Extensions view restoration + live Open VSX search.
//
// Enabled only when ARSCHAT_M12_AUTOTEST=1. It verifies that MS12 restored the
// stock vsx-registry Extensions view as a normal ArsChat activity-bar view, while
// preserving the IDE-dilution regressions from M6. The live-search scenario uses
// the real Open VSX-backed VSXExtensionsModel; it can fail when offline and is
// intended for manual/run-log verification.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandService, ILogger, MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { VSXExtensionsModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-model';
import { VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { VSXExtensionsViewContainer } from '@theia/vsx-registry/lib/browser/vsx-extensions-view-container';

const VSX_EXTENSIONS_TOGGLE_COMMAND = 'vsxExtensions.toggle';

@injectable()
export class ArschatM12AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(MenuModelRegistry)
    protected readonly menuRegistry!: MenuModelRegistry;

    @inject(VSXExtensionsSearchModel)
    protected readonly searchModel!: VSXExtensionsSearchModel;

    @inject(VSXExtensionsModel)
    protected readonly extensionsModel!: VSXExtensionsModel;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M12_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        setTimeout(() => this.run().catch(err => this.log(`[M12][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
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
        this.log('[M12][autotest] enabled (frontend)');
        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(this.scenarioIconDocked());
        tally(await this.scenarioOpenView());
        tally(await this.scenarioLiveSearch());
        tally(this.scenarioDilutionRegression());

        this.log(`[M12][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} checks)`);
        this.log('[M12][autotest] done');
    }

    protected scenarioIconDocked(): boolean {
        const leftIds = this.leftWidgetIds();
        const ok = leftIds.includes(VSXExtensionsViewContainer.ID);
        this.log(`[M12][autotest] icon-docked: leftWidgets=[${leftIds.join(', ')}] `
            + `expected=${VSXExtensionsViewContainer.ID} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioOpenView(): Promise<boolean> {
        const before = this.isExtensionsViewVisible();
        let executedToggle = false;
        if (!before) {
            try {
                await this.commandService.executeCommand(VSX_EXTENSIONS_TOGGLE_COMMAND);
                executedToggle = true;
            } catch (e) {
                this.log(`[M12][autotest] open-view: executeCommand('${VSX_EXTENSIONS_TOGGLE_COMMAND}') threw `
                    + `(${e instanceof Error ? e.message : String(e)}) -> FAIL`);
                return false;
            }
        }
        const opened = await this.waitFor(() => this.isExtensionsViewVisible(), 10000);
        this.log(`[M12][autotest] open-view: beforeVisible=${before} executedToggle=${executedToggle} `
            + `visible=${this.isExtensionsViewVisible()} -> ${opened ? 'PASS' : 'FAIL'}`);
        return opened;
    }

    protected async scenarioLiveSearch(): Promise<boolean> {
        const query = 'theme';
        this.searchModel.query = '';
        await this.waitFor(() => Array.from(this.extensionsModel.searchResult).length === 0, 2000);
        this.searchModel.query = query;
        const ok = await this.waitFor(() =>
            this.searchModel.query === query && Array.from(this.extensionsModel.searchResult).length > 0, 20000);
        const ids = Array.from(this.extensionsModel.searchResult);
        const heads = ids.slice(0, 5);
        this.log(`[M12][autotest] live-search: query='${query}' resultCount=${ids.length} `
            + `firstIds=[${heads.join(', ')}]${this.extensionsModel.searchError ? ` searchError='${this.extensionsModel.searchError}'` : ''} `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected scenarioDilutionRegression(): boolean {
        const menuOk = this.menuBarStillDiluted();
        const sideOk = this.sidePanelsStillDiluted();
        const ok = menuOk && sideOk;
        this.log(`[M12][autotest] dilution-regression: menu=${menuOk ? 'ok' : 'NO'} sidePanels=${sideOk ? 'ok' : 'NO'} `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected menuBarStillDiluted(): boolean {
        const labels = this.menuBarLabels();
        const has = (name: string): boolean => labels.some(label => label.toLowerCase() === name.toLowerCase());
        const expectedAbsent = ['Run', 'Selection', 'Go', 'Terminal'];
        const strays = expectedAbsent.filter(has);
        const ok = strays.length === 0;
        this.log(`[M12][autotest] dilution-regression/menu: labels=[${labels.join(', ')}] `
            + `strays=[${strays.join(', ')}] -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected sidePanelsStillDiluted(): boolean {
        const sideIds = [
            ...this.leftWidgetIds(),
            ...this.shell.getWidgets('right').map(widget => widget.id)
        ];
        const idePatterns = [
            'scm', 'debug', 'test', 'search-in-workspace', 'navigator', 'explorer',
            'files', 'outline', 'chat-view-widget'
        ];
        const strays = sideIds.filter(id =>
            !id.startsWith('arschat') &&
            id !== VSXExtensionsViewContainer.ID &&
            idePatterns.some(pattern => id.toLowerCase().includes(pattern)));
        const ok = strays.length === 0;
        this.log(`[M12][autotest] dilution-regression/activity-bar: sidePanelWidgets=[${sideIds.join(', ')}] `
            + `allowedVSX=${sideIds.includes(VSXExtensionsViewContainer.ID)} strayIdeViews=[${strays.join(', ')}] `
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

    protected isExtensionsViewVisible(): boolean {
        return this.shell.getWidgets('left')
            .some(widget => widget.id === VSXExtensionsViewContainer.ID && widget.isVisible);
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
