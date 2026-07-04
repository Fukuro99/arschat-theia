// *****************************************************************************
// ArsChat PoC-4 verification helper (electron-main half).
//
// Same rationale as PoC-1/2/3's autotest contributions: this runs in a
// GUI-less verification environment, so the screenshot is captured
// programmatically via `webContents.capturePage()` instead of by hand.
//
// Timed to fire after the frontend-side `ArschatPoc4AutotestContribution`
// (arschat-core/src/browser/) has opened the AI chat view at t+20s.
//
// Disabled by default (flag-gated) - no effect on a normal
// `npm run start:electron`.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC4_AUTOTEST';

// arschat-core/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');

@injectable()
export class ArschatPoc4AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }

        console.log('[PoC-4][autotest] enabled (electron-main)');

        setTimeout(() => {
            this.captureWindow('poc4-chat-view.png', 26);
        }, 26000);
    }

    protected async captureWindow(fileName: string, atSeconds: number): Promise<void> {
        try {
            const windows = BrowserWindow.getAllWindows();
            console.log(`[PoC-4][autotest] t+${atSeconds}s: ${windows.length} window(s) open, capturing the first one`);
            const target = windows[0];
            if (!target) {
                console.error(`[PoC-4][autotest] t+${atSeconds}s: no window available to capture -> FAIL`);
                return;
            }

            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
            const artifactPath = path.join(ARTIFACT_DIR, fileName);

            const image = await target.webContents.capturePage();
            fs.writeFileSync(artifactPath, image.toPNG());
            console.log(`[PoC-4][autotest] screenshot saved -> ${artifactPath} -> PASS`);
        } catch (error) {
            console.error(`[PoC-4][autotest] t+${atSeconds}s: screenshot capture FAILED:`, error);
        }
    }
}
