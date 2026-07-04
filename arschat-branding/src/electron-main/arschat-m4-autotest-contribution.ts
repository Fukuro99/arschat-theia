// *****************************************************************************
// ArsChat M4 screenshot helper (PHASE1_DESIGN.md §9 M4 task "検証").
//
// GUI-less verification counterpart to the frontend M4 autotest. Under
// ARSCHAT_M4_AUTOTEST=1 it captures the main window twice, late enough that the
// frontend autotest (t+14s + persona switch + skill sends + a triggered persona
// panel reveal) has produced a rendered UI:
//   - poc-artifacts/m4-persona-switch.png  - the chat header with the persona
//     dropdown + the persona management panel;
//   - poc-artifacts/m4-skill-complete.png  - the slash-command completion popup.
//
// Reuses the M2/M3 capture strategy (retry until the PNG is large enough to be
// the painted shell, not the loading overlay). Disabled by default.
//
// NOTE: the slash-completion popup is transient (it appears only while typing a
// `/` trigger). The frontend M4 autotest cannot leave a real popup open across
// the screenshot reliably in a headless run, so m4-skill-complete.png is a
// best-effort capture; if the shell does not render in the sandbox, the
// authoritative popup screenshot is produced from the real render pipeline (see
// the puppeteer fallback used for the M3 screenshots) and BUILD_NOTES records it.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M4_AUTOTEST';

// arschat-branding/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');

@injectable()
export class ArschatM4AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }
        console.log('[M4][autotest] electron-main screenshot helper enabled');
        setTimeout(() => this.capture('m4-persona-switch.png', 0), 30000);
        setTimeout(() => this.capture('m4-skill-complete.png', 0), 42000);
    }

    protected async capture(fileName: string, attempt: number): Promise<void> {
        const maxAttempts = 12;
        const minRealUiBytes = 30000; // loading overlay is ~6KB; painted shell is ~90KB+.
        const artifactPath = path.join(ARTIFACT_DIR, fileName);
        try {
            const windows = BrowserWindow.getAllWindows();
            const target = windows[0];
            if (!target) {
                console.error(`[M4][autotest] no window available to capture ${fileName} -> FAIL`);
                return;
            }
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
            fs.writeFileSync(artifactPath, png);
            console.log(`[M4][autotest] screenshot saved (${png.length}B) -> ${artifactPath} -> ${png.length >= minRealUiBytes ? 'PASS' : 'SAVED (still small)'}`);
        } catch (error) {
            if (attempt + 1 < maxAttempts) {
                console.warn(`[M4][autotest] capture ${fileName} attempt ${attempt + 1} not ready (${error instanceof Error ? error.message : String(error)}), retrying in 4s`);
                setTimeout(() => this.capture(fileName, attempt + 1), 4000);
            } else {
                console.error(`[M4][autotest] screenshot capture ${fileName} FAILED after retries:`, error);
            }
        }
    }
}
