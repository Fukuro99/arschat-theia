// *****************************************************************************
// ArsChat PoC-3 verification helper (frontend half).
//
// PoC-3 validates that real VS Code extensions (GitLens, ESLint, a color
// theme) run inside the Theia-based app once `@theia/plugin-ext-vscode` +
// `@theia/vsx-registry` are added as dependencies (see
// arschat-core/../electron-app/package.json). The color theme itself is
// applied declaratively via `theia.frontend.config.preferences` in
// electron-app/package.json (`workbench.colorTheme: "Dracula Theme"`) -
// exactly the same zero-code mechanism PoC-2 used for
// `workbench.statusBar.visible` - so no frontend code is needed for 3-2's
// theme requirement.
//
// What DOES need frontend code, because this is a GUI-less verification
// environment (see PoC-1/PoC-2 notes - no way to click around by hand):
//   t+10s: log the list of deployed plugins as reported by
//          HostedPluginSupport (authoritative evidence of what the plugin
//          system actually deployed), then open sample.js from the test
//          workspace in an editor. Opening a JavaScript file gives the
//          ESLint extension (activationEvents: onStartupFinished, lints
//          open documents via LSP) something real to lint.
//   t+18s: execute `vsxExtensions.toggle` to open the vsx-registry
//          Extensions view (PoC 3-1 UI-wiring evidence + makes the second
//          electron-main screenshot meaningful).
//   t+26s: dump all Problem markers (owner/uri/message). If the ESLint
//          extension's language server round-trip works, the deliberately
//          rule-breaking sample.js produces markers with owner 'eslint'.
//
// Disabled by default (flag-gated) - no effect on a normal
// `npm run start:electron`.
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FrontendApplication, FrontendApplicationContribution, open, OpenerService } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { HostedPluginSupport } from '@theia/plugin-ext/lib/hosted/browser/hosted-plugin';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MonacoEditorModel } from '@theia/monaco/lib/browser/monaco-editor-model';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC3_AUTOTEST';

// The command id registered by @theia/vsx-registry's VSXExtensionsContribution
// (node_modules/@theia/vsx-registry/lib/browser/vsx-extensions-contribution.js)
// to toggle open its Extensions view container.
const OPEN_EXTENSIONS_VIEW_COMMAND = 'vsxExtensions.toggle';

@injectable()
export class ArschatPoc3AutotestContribution implements FrontendApplicationContribution {

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(ProblemManager)
    protected readonly problemManager: ProblemManager;

    @inject(HostedPluginSupport)
    protected readonly hostedPluginSupport: HostedPluginSupport;

    // NOTE: the frontend runs in the Electron renderer where `process.env`
    // is a webpack shim and does NOT see OS environment variables (verified
    // empirically during PoC-3 - an env gate on `process.env` silently never
    // fired). The backend's env is queried through Theia's standard
    // EnvVariablesServer RPC service instead.
    @inject(EnvVariablesServer)
    protected readonly envServer: EnvVariablesServer;

    async onStart(_app: FrontendApplication): Promise<void> {
        const flag = await this.envServer.getValue(AUTOTEST_ENV_VAR);
        if (!flag || flag.value !== '1') {
            return;
        }

        console.log('[PoC-3][autotest] enabled (frontend)');

        setTimeout(() => {
            this.logDeployedPluginsAndOpenSample();
        }, 10000);

        setTimeout(() => {
            this.openExtensionsView();
        }, 18000);

        setTimeout(() => {
            this.dumpProblemMarkers();
        }, 26000);
    }

    protected async logDeployedPluginsAndOpenSample(): Promise<void> {
        try {
            await this.hostedPluginSupport.didStart;
            const ids = this.hostedPluginSupport.plugins.map(p => `${p.model.id}@${p.model.version}`);
            console.log(`[PoC-3][autotest] t+10s: deployed plugins (${ids.length}): ${ids.join(', ')}`);
        } catch (error) {
            console.error('[PoC-3][autotest] t+10s: failed to enumerate deployed plugins -> FAIL', error);
        }

        try {
            const roots = this.workspaceService.tryGetRoots();
            if (roots.length === 0) {
                console.error('[PoC-3][autotest] t+10s: no workspace root found -> cannot open sample.js');
                return;
            }
            const sampleUri = roots[0].resource.resolve('sample.js');
            const widget = await open(this.openerService, sampleUri);
            // Log the language id the editor actually assigned. Without the
            // `vscode.javascript` builtin extension deployed, bare Theia has
            // no `.js -> javascript` association and the file opens as
            // 'plaintext', in which case vscode-eslint's language probe
            // never triggers (found the hard way during PoC-3).
            let languageId = 'unknown';
            if (widget instanceof EditorWidget) {
                const doc = widget.editor.document;
                languageId = doc instanceof MonacoEditorModel ? doc.languageId : `unknown(${doc.constructor.name})`;
            }
            console.log(`[PoC-3][autotest] t+10s: opened ${sampleUri.toString()} in an editor, languageId='${languageId}' (gives ESLint something to lint)`);
        } catch (error) {
            console.error('[PoC-3][autotest] t+10s: failed to open sample.js -> FAIL', error);
        }
    }

    protected async openExtensionsView(): Promise<void> {
        try {
            console.log(`[PoC-3][autotest] t+18s: executing command '${OPEN_EXTENSIONS_VIEW_COMMAND}'`);
            await this.commandService.executeCommand(OPEN_EXTENSIONS_VIEW_COMMAND);
            console.log('[PoC-3][autotest] extensions view opened -> PASS (3-1 UI wiring confirmed)');
        } catch (error) {
            console.error('[PoC-3][autotest] failed to open extensions view -> FAIL', error);
        }
    }

    protected dumpProblemMarkers(): void {
        try {
            const markers = this.problemManager.findMarkers();
            console.log(`[PoC-3][autotest] t+26s: ${markers.length} problem marker(s) total`);
            for (const marker of markers) {
                const message = (marker.data && typeof marker.data.message === 'string') ? marker.data.message : '<no message>';
                console.log(`[PoC-3][autotest]   marker owner='${marker.owner}' uri='${marker.uri}' message='${message}'`);
            }
            const eslintMarkers = markers.filter(m => m.owner.toLowerCase().includes('eslint'));
            if (eslintMarkers.length > 0) {
                console.log(`[PoC-3][autotest] ESLint produced ${eslintMarkers.length} marker(s) -> PASS (LSP round-trip works)`);
            } else {
                console.warn('[PoC-3][autotest] no ESLint-owned markers found (check owner names above - the LSP may publish under a different owner, or activation failed)');
            }
        } catch (error) {
            console.error('[PoC-3][autotest] t+26s: failed to dump problem markers -> FAIL', error);
        }
    }
}
