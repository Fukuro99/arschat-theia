// *****************************************************************************
// ArsChat PoC-2 verification helper.
//
// Like PoC-1's autotest contribution, this app runs in a GUI-less
// verification environment, so we cannot visually confirm the chat-first
// layout / IDE dilution / branding by hand. This contribution provides an
// opt-in screenshot capture gated by ARSCHAT_POC2_AUTOTEST=1:
//
//   t+15s: capture the (first/main) BrowserWindow's page via
//          `webContents.capturePage()` and save it as a PNG to
//          `<repo-root>/poc-artifacts/poc2-main-window.png`, then log the
//          absolute path. 15s gives the frontend layout time to settle
//          (widget activation, preference application, menu filtering)
//          before the screenshot is taken.
//
// Disabled by default (flag-gated) - no effect on a normal
// `npm run start:electron`.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC2_AUTOTEST';

// arschat-core/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');
const ARTIFACT_PATH = path.join(ARTIFACT_DIR, 'poc2-main-window.png');

@injectable()
export class ArschatPoc2AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }

        console.log('[PoC-2][autotest] enabled');

        setTimeout(() => {
            this.captureMainWindow();
        }, 15000);
    }

    protected async captureMainWindow(): Promise<void> {
        try {
            const windows = BrowserWindow.getAllWindows();
            console.log(`[PoC-2][autotest] t+15s: ${windows.length} window(s) open, capturing the first one`);
            const target = windows[0];
            if (!target) {
                console.error('[PoC-2][autotest] no window available to capture -> FAIL');
                return;
            }

            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

            const image = await target.webContents.capturePage();
            fs.writeFileSync(ARTIFACT_PATH, image.toPNG());
            console.log(`[PoC-2][autotest] screenshot saved -> ${ARTIFACT_PATH} -> PASS`);
        } catch (error) {
            console.error('[PoC-2][autotest] screenshot capture FAILED:', error);
        }
    }
}
