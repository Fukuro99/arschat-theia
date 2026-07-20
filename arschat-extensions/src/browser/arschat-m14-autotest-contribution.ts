// *****************************************************************************
// ArsChat M14 autotest: sandboxed extension host real-path checks.
//
// Enabled only when ARSCHAT_M14_AUTOTEST=1 (read from the BACKEND env via
// EnvVariablesServer). It installs an inline extension, drives the real host
// iframe bridge, and always uninstalls the test extension before SUMMARY.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { ILogger, URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { EXTENSION_RESPONSE_TYPE, ExtensionResponseMessage } from '../common/extension-bridge-protocol';
import { ExtensionPermissionId } from '../common/extension-manifest';
import { ExtensionHostWidget } from './extension-host-widget';
import { ExtensionManagerWidget } from './extension-manager-widget';
import { ExtensionRegistryService } from './extension-registry-service';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M14_AUTOTEST';
const TEST_EXTENSION_NAME = 'arschat-m14-autotest';

interface M14IframeReport {
    readonly type: 'm14-autotest-report';
    readonly extId: string;
    readonly storageGet?: ExtensionResponseMessage;
    readonly storageSet?: ExtensionResponseMessage;
    readonly chatSend?: ExtensionResponseMessage;
    readonly dom?: {
        readonly threw: boolean;
        readonly name?: string;
        readonly message?: string;
    };
}

@injectable()
export class ArschatM14AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(ExtensionRegistryService)
    protected readonly registry!: ExtensionRegistryService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected hostWidget: ExtensionHostWidget | undefined;
    protected iframeReport: M14IframeReport | undefined;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv(AUTOTEST_ENV_VAR);
        if (enabled !== '1') {
            return;
        }
        setTimeout(() => this.run().catch(err => this.log(`[M14][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
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
        this.log('[M14][autotest] enabled (frontend)');
        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        try {
            tally(await this.safeScenario('install-and-gate', () => this.scenarioInstallAndGate()));
            tally(await this.safeScenario('spoof-rejected', () => this.scenarioSpoofRejected()));
            tally(await this.safeScenario('manager-docked', () => this.scenarioManagerDocked()));
            tally(await this.safeScenario('dom-isolation', () => this.scenarioDomIsolation()));
            tally(await this.safeScenario('uninstall-cleans', () => this.scenarioUninstallCleans()));
        } finally {
            await this.cleanupTestExtension();
        }

        this.log(`[M14][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} scenarios)`);
        this.log('[M14][autotest] done');
    }

    protected async safeScenario(label: string, scenario: () => Promise<boolean>): Promise<boolean> {
        try {
            return await scenario();
        } catch (e) {
            this.log(`[M14][autotest] ${label}: error ${e instanceof Error ? e.message : String(e)} -> FAIL`);
            return false;
        }
    }

    protected async scenarioInstallAndGate(): Promise<boolean> {
        await this.cleanupTestExtension(false);
        this.iframeReport = undefined;
        await this.registry.installFromData(
            JSON.stringify({
                name: TEST_EXTENSION_NAME,
                displayName: 'M14 Autotest Extension',
                version: '0.0.1',
                description: 'Temporary M14 autotest extension',
                permissions: ['storage:read', 'storage:write', 'chat:send'],
                entry: 'main.html'
            }),
            this.testExtensionHtml(),
            { kind: 'autotest' },
            ['storage:read'] satisfies ExtensionPermissionId[]
        );

        const reportPromise = this.waitForIframeReport(9000);
        const widget = await this.openHostWidget();
        const iframe = await this.waitForIframe(widget, 5000);
        const report = await reportPromise;
        const storageGetOk = report?.storageGet?.ok === true;
        const storageSetDenied = report?.storageSet?.ok === false && report.storageSet.error?.code === 'PERMISSION_DENIED';
        const chatSendDenied = report?.chatSend?.ok === false && report.chatSend.error?.code === 'PERMISSION_DENIED';
        const ok = !!iframe && storageGetOk && storageSetDenied && chatSendDenied;
        this.log(`[M14][autotest] install-and-gate: iframePresent=${!!iframe} `
            + `storage.get.ok=${report?.storageGet?.ok ?? '<missing>'} `
            + `storage.set.error=${report?.storageSet?.error?.code ?? '<missing>'} `
            + `chat.send.error=${report?.chatSend?.error?.code ?? '<missing>'} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioSpoofRejected(): Promise<boolean> {
        const widget = await this.ensureHostWidget();
        if (!widget) {
            this.log('[M14][autotest] spoof-rejected: host widget missing -> FAIL');
            return false;
        }
        const requestId = 'm14-spoof-direct-window';
        let responded = false;
        const listener = (event: MessageEvent) => {
            const data = event.data;
            if (data?.type === EXTENSION_RESPONSE_TYPE && data.extId === TEST_EXTENSION_NAME && data.requestId === requestId) {
                responded = true;
            }
        };
        window.addEventListener('message', listener);
        try {
            window.postMessage({
                type: 'arschat-ext-request',
                extId: TEST_EXTENSION_NAME,
                requestId,
                method: 'storage.get',
                params: { key: 'spoof' }
            }, '*');
            await this.delay(600);
        } finally {
            window.removeEventListener('message', listener);
        }
        const ok = !responded;
        this.log(`[M14][autotest] spoof-rejected: responseSeen=${responded} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioManagerDocked(): Promise<boolean> {
        const docked = await this.waitFor(() => this.shell.getWidgets('left').some(widget => widget.id === ExtensionManagerWidget.ID), 5000);
        const leftIds = this.shell.getWidgets('left').map(widget => widget.id);
        this.log(`[M14][autotest] manager-docked: docked=${docked} leftWidgets=[${leftIds.join(', ')}] -> ${docked ? 'PASS' : 'FAIL'}`);
        return docked;
    }

    protected async scenarioDomIsolation(): Promise<boolean> {
        const report = this.iframeReport;
        const dom = report?.dom;
        const ok = dom?.threw === true && dom.name === 'SecurityError';
        this.log(`[M14][autotest] dom-isolation: threw=${dom?.threw ?? '<missing>'} `
            + `name=${dom?.name ?? '<missing>'} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioUninstallCleans(): Promise<boolean> {
        await this.registry.setStorage(TEST_EXTENSION_NAME, 'cleanup-probe', 'present');
        const dir = await this.extensionDirUri(TEST_EXTENSION_NAME);
        const mainBefore = await this.fileService.exists(dir.resolve('main.html'));
        const storageBefore = await this.fileService.exists(dir.resolve('storage.json'));
        await this.registry.uninstall(TEST_EXTENSION_NAME);
        const registryGone = !this.registry.getExtension(TEST_EXTENSION_NAME);
        const dirGone = !(await this.fileService.exists(dir));
        const mainGone = !(await this.fileService.exists(dir.resolve('main.html')));
        const storageGone = !(await this.fileService.exists(dir.resolve('storage.json')));
        const ok = mainBefore && storageBefore && registryGone && dirGone && mainGone && storageGone;
        this.log(`[M14][autotest] uninstall-cleans: before(main=${mainBefore}, storage=${storageBefore}) `
            + `registryGone=${registryGone} dirGone=${dirGone} mainGone=${mainGone} storageGone=${storageGone} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async cleanupTestExtension(log = true): Promise<void> {
        try {
            await this.registry.ready();
            const wasInstalled = !!this.registry.getExtension(TEST_EXTENSION_NAME);
            await this.registry.uninstall(TEST_EXTENSION_NAME);
            if (log && wasInstalled) {
                this.log(`[M14][autotest] cleanup: uninstalled ${TEST_EXTENSION_NAME}`);
            }
        } catch (e) {
            this.log(`[M14][autotest] cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    protected async openHostWidget(): Promise<ExtensionHostWidget> {
        const widget = await this.widgetManager.getOrCreateWidget<ExtensionHostWidget>(
            ExtensionHostWidget.FACTORY_ID,
            { name: TEST_EXTENSION_NAME }
        );
        this.hostWidget = widget;
        if (!this.shell.getWidgets('main').some(existing => existing.id === widget.id)) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);
        return widget;
    }

    protected async ensureHostWidget(): Promise<ExtensionHostWidget | undefined> {
        if (this.hostWidget && !this.hostWidget.isDisposed) {
            return this.hostWidget;
        }
        if (!this.registry.getExtension(TEST_EXTENSION_NAME)) {
            return undefined;
        }
        return this.openHostWidget();
    }

    protected async waitForIframe(widget: ExtensionHostWidget, timeoutMs: number): Promise<HTMLIFrameElement | undefined> {
        await this.waitFor(() => !!widget.node.querySelector('iframe'), timeoutMs);
        return widget.node.querySelector('iframe') as HTMLIFrameElement | null ?? undefined;
    }

    protected waitForIframeReport(timeoutMs: number): Promise<M14IframeReport | undefined> {
        return new Promise(resolve => {
            let done = false;
            const finish = (report?: M14IframeReport) => {
                if (done) {
                    return;
                }
                done = true;
                window.removeEventListener('message', listener);
                clearTimeout(timeout);
                if (report) {
                    this.iframeReport = report;
                }
                resolve(report);
            };
            const listener = (event: MessageEvent) => {
                const data = event.data;
                if (data?.type === 'm14-autotest-report' && data.extId === TEST_EXTENSION_NAME) {
                    finish(data as M14IframeReport);
                }
            };
            const timeout = setTimeout(() => finish(undefined), timeoutMs);
            window.addEventListener('message', listener);
        });
    }

    protected async extensionDirUri(name: string): Promise<URI> {
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir).resolve('arschat').resolve('extensions').resolve(name);
    }

    protected testExtensionHtml(): string {
        return `<!doctype html>
<html>
<head><title>M14 Autotest</title></head>
<body>
  <main id="m14-root">M14 autotest</main>
  <script>
    (function () {
      const extId = ${JSON.stringify(TEST_EXTENSION_NAME)};
      let seq = 0;
      const pending = new Map();
      window.addEventListener('message', event => {
        const data = event.data;
        if (!data || data.type !== 'arschat-ext-response' || data.extId !== extId) {
          return;
        }
        const resolve = pending.get(data.requestId);
        if (resolve) {
          pending.delete(data.requestId);
          resolve(data);
        }
      });
      function call(method, params) {
        const requestId = 'm14-iframe-' + (++seq);
        window.parent.postMessage({ type: 'arschat-ext-request', extId, requestId, method, params }, '*');
        return new Promise(resolve => {
          pending.set(requestId, resolve);
          setTimeout(() => {
            if (pending.delete(requestId)) {
              resolve({ type: 'arschat-ext-response', extId, requestId, ok: false, error: { code: 'TIMEOUT', message: method + ' timed out' } });
            }
          }, 4000);
        });
      }
      function probeDomIsolation() {
        try {
          const parentDocument = window.parent.document;
          return { threw: false, message: String(!!parentDocument) };
        } catch (error) {
          return { threw: true, name: error && error.name ? error.name : '', message: error && error.message ? error.message : String(error) };
        }
      }
      async function run() {
        const storageGet = await call('storage.get', { key: 'missing' });
        const storageSet = await call('storage.set', { key: 'blocked', value: 'nope' });
        const chatSend = await call('chat.send', { text: 'M14 denied chat.send probe' });
        const dom = probeDomIsolation();
        window.parent.postMessage({ type: 'm14-autotest-report', extId, storageGet, storageSet, chatSend, dom }, '*');
      }
      setTimeout(() => run(), 100);
    })();
  </script>
</body>
</html>`;
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
