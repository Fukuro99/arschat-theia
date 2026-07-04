// *****************************************************************************
// ArsChat PoC-3 verification helper (electron-main half).
//
// Same rationale as PoC-1/PoC-2's autotest contributions: this runs in a
// GUI-less verification environment, so screenshots are captured
// programmatically via `webContents.capturePage()` instead of by hand.
//
// Two captures, timed to bracket the frontend-side
// `ArschatPoc3AutotestContribution` (arschat-core/src/browser/):
//   t+22s: poc3-main-window.png   - after plugin deployment/activation and
//                                   the Dracula theme preference have had
//                                   time to settle, but *before* the
//                                   frontend opens the Extensions view. This
//                                   is the "themed main window" shot for 3-2.
//   t+30s: poc3-extensions-view.png - after the frontend's t+18s
//                                   `vsxExtensions.toggle` call has had time
//                                   to render, showing the Extensions view
//                                   for 3-1 evidence.
//
// Disabled by default (flag-gated) - no effect on a normal
// `npm run start:electron`.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC3_AUTOTEST';

// arschat-core/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');

@injectable()
export class ArschatPoc3AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }

        console.log('[PoC-3][autotest] enabled (electron-main)');

        setTimeout(() => {
            this.captureWindow('poc3-main-window.png', 22);
        }, 22000);

        setTimeout(() => {
            this.captureWindow('poc3-extensions-view.png', 30);
        }, 30000);
    }

    protected async captureWindow(fileName: string, atSeconds: number): Promise<void> {
        try {
            const windows = BrowserWindow.getAllWindows();
            console.log(`[PoC-3][autotest] t+${atSeconds}s: ${windows.length} window(s) open, capturing the first one`);
            const target = windows[0];
            if (!target) {
                console.error(`[PoC-3][autotest] t+${atSeconds}s: no window available to capture -> FAIL`);
                return;
            }

            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
            const artifactPath = path.join(ARTIFACT_DIR, fileName);

            const image = await target.webContents.capturePage();
            fs.writeFileSync(artifactPath, image.toPNG());
            console.log(`[PoC-3][autotest] screenshot saved -> ${artifactPath} -> PASS`);
        } catch (error) {
            console.error(`[PoC-3][autotest] t+${atSeconds}s: screenshot capture FAILED:`, error);
        }
    }
}
