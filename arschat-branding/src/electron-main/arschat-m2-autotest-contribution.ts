// *****************************************************************************
// ArsChat M2 screenshot helper (PHASE1_DESIGN.md §9 M2 task "検証").
//
// GUI-less verification counterpart to the frontend M2 autotest: under
// ARSCHAT_M2_AUTOTEST=1 it captures the main window (which shows the chat
// header with the provider + model dropdowns) and saves it to
// `<repo-root>/poc-artifacts/m2-provider-switch.png`.
//
// t+18s so the frontend M2 autotest (t+12s + async probes) has already run and
// left an active provider/model selected in the header dropdowns. Disabled by
// default - no effect on a normal start.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M2_AUTOTEST';

// arschat-branding/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');
const ARTIFACT_PATH = path.join(ARTIFACT_DIR, 'm2-provider-switch.png');

@injectable()
export class ArschatM2AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }
        console.log('[M2][autotest] electron-main screenshot helper enabled');
        // The workbench can take ~20s to fully settle in this environment; capture
        // late so the loaded chat UI (with the provider/model dropdowns) is shown.
        setTimeout(() => this.captureMainWindow(0), 30000);
    }

    /**
     * capturePage can transiently fail ("Current display surface not available for
     * capture") OR return just the loading-spinner overlay before the workbench
     * shell has painted (the shell can attach as late as ~30s from frontend page
     * start in this GUI-less env). We keep retrying until we get a PNG large
     * enough to be the real UI (the loading overlay is ~6KB; a painted workbench
     * is ~90KB+), or we run out of attempts.
     */
    protected async captureMainWindow(attempt: number): Promise<void> {
        const maxAttempts = 15;
        const minRealUiBytes = 30000; // loading overlay is ~6KB; painted shell is ~90KB+.
        try {
            const windows = BrowserWindow.getAllWindows();
            console.log(`[M2][autotest] t+${30 + attempt * 4}s: ${windows.length} window(s) open, capturing (attempt ${attempt + 1}/${maxAttempts})`);
            const target = windows[0];
            if (!target) {
                console.error('[M2][autotest] no window available to capture -> FAIL');
                return;
            }
            // Ensure the window is on-screen and painting before capture (GUI-less env: the
            // display surface is only available when the window is shown/focused).
            if (target.isMinimized()) {
                target.restore();
            }
            target.show();
            target.focus();
            target.moveTop();
            await new Promise(resolve => setTimeout(resolve, 800));
            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
            const image = await target.webContents.capturePage();
            const png = image.toPNG();
            const isLastAttempt = attempt + 1 >= maxAttempts;
            if (png.length < minRealUiBytes && !isLastAttempt) {
                throw new Error(`PNG too small (${png.length}B) - workbench likely still loading`);
            }
            fs.writeFileSync(ARTIFACT_PATH, png);
            console.log(`[M2][autotest] screenshot saved (${png.length}B) -> ${ARTIFACT_PATH} -> ${png.length >= minRealUiBytes ? 'PASS' : 'SAVED (still small - workbench may not have painted)'}`);
        } catch (error) {
            if (attempt + 1 < maxAttempts) {
                console.warn(`[M2][autotest] capture attempt ${attempt + 1} not ready (${error instanceof Error ? error.message : String(error)}), retrying in 4s`);
                setTimeout(() => this.captureMainWindow(attempt + 1), 4000);
            } else {
                console.error('[M2][autotest] screenshot capture FAILED after retries:', error);
            }
        }
    }
}
