// *****************************************************************************
// ArsChat M11 autotest: terminal toggle live DOM checks.
//
// Enabled only when ARSCHAT_M11_AUTOTEST=1. It drives the real ArsChat header
// button and verifies Theia's existing terminal toggle command expands/collapses
// the bottom panel.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ILogger } from '@theia/core';
import { TERMINAL_WIDGET_FACTORY_ID } from '@theia/terminal/lib/browser/terminal-widget-impl';
import { ArschatChatWidget } from './arschat-chat-widget';

@injectable()
export class ArschatM11AutotestContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M11_AUTOTEST');
        if (enabled !== '1') {
            return;
        }
        setTimeout(() => this.run().catch(err => this.log(`[M11][autotest] fatal error ${err instanceof Error ? err.message : String(err)}`)), 16000);
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
        this.log('[M11][autotest] enabled (frontend)');
        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        tally(await this.scenarioButtonExists());
        tally(await this.scenarioOpenTerminal());
        tally(await this.scenarioCloseTerminal());

        this.log(`[M11][autotest] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} checks)`);
        this.log('[M11][autotest] done');
    }

    protected async scenarioButtonExists(): Promise<boolean> {
        const widget = await this.getChatWidget('button exists');
        const button = widget?.node.querySelector('#arschat-terminal-toggle-button') as HTMLElement | null | undefined;
        const ok = !!button;
        this.log(`[M11][autotest] button exists: found=${ok} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioOpenTerminal(): Promise<boolean> {
        const widget = await this.getChatWidget('open terminal');
        const button = widget?.node.querySelector('#arschat-terminal-toggle-button') as HTMLElement | null | undefined;
        if (!widget || !button) {
            this.log('[M11][autotest] open terminal: widget/button missing -> FAIL');
            return false;
        }
        if (this.shell.isExpanded('bottom')) {
            await this.shell.collapsePanel('bottom');
            await this.delay(120);
        }
        button.click();
        // Restored terminals can first fail to attach to the old shell after an Electron restart,
        // then create a replacement shell, so becoming visible can legitimately take longer.
        const opened = await this.waitFor(() => this.shell.isExpanded('bottom') && this.visibleTerminalWidgets().length > 0, 20000);
        const ids = this.bottomTerminalWidgetIds();
        this.log(`[M11][autotest] terminal ids after open: ${ids.length > 0 ? ids.join(', ') : '<none>'}`);
        if (!opened) {
            const diagnostics = this.bottomTerminalWidgetDiagnostics();
            this.log(`[M11][autotest] terminal diagnostics after open FAIL: ${diagnostics.length > 0 ? diagnostics.join(', ') : '<none>'}`);
        }
        const ok = opened;
        this.log(`[M11][autotest] open terminal: bottomExpanded=${this.shell.isExpanded('bottom')} visibleTerminals=${this.visibleTerminalWidgets().length} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async scenarioCloseTerminal(): Promise<boolean> {
        const widget = await this.getChatWidget('close terminal', false);
        const button = widget?.node.querySelector('#arschat-terminal-toggle-button') as HTMLElement | null | undefined;
        if (!widget || !button) {
            this.log('[M11][autotest] close terminal: widget/button missing -> FAIL');
            return false;
        }
        button.click();
        let closed = await this.waitFor(() => !this.shell.isExpanded('bottom'), 5000);
        if (!closed && this.shell.isExpanded('bottom')) {
            button.click();
            closed = await this.waitFor(() => !this.shell.isExpanded('bottom'), 5000);
        }
        const ok = closed;
        this.log(`[M11][autotest] close terminal: bottomExpanded=${this.shell.isExpanded('bottom')} -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
    }

    protected async getChatWidget(label: string, activate = true): Promise<ArschatChatWidget | undefined> {
        const widget = await this.widgetManager.getWidget<ArschatChatWidget>(ArschatChatWidget.ID);
        if (!widget) {
            this.log(`[M11][autotest] ${label}: ArschatChatWidget not found -> FAIL`);
            return undefined;
        }
        if (activate) {
            await this.shell.activateWidget(ArschatChatWidget.ID).catch(() => { /* noop */ });
        }
        return widget;
    }

    protected visibleTerminalWidgets(): Array<{ id: string; isVisible: boolean }> {
        return this.terminalWidgets()
            .filter(widget => widget.isVisible)
            .map(widget => ({ id: widget.id, isVisible: widget.isVisible }));
    }

    protected bottomTerminalWidgetIds(): string[] {
        return this.terminalWidgets()
            .map(widget => widget.id);
    }

    protected bottomTerminalWidgetDiagnostics(): string[] {
        return this.terminalWidgets()
            .map(widget => `${widget.id}{isVisible=${widget.isVisible}, isDisposed=${widget.isDisposed}}`);
    }

    protected terminalWidgets(): ReturnType<ApplicationShell['getWidgets']> {
        return this.shell.getWidgets('bottom')
            .filter(widget => this.isTerminalWidget(widget));
    }

    protected isTerminalWidget(widget: { id: string }): boolean {
        return widget.id.startsWith(`${TERMINAL_WIDGET_FACTORY_ID}-`);
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
