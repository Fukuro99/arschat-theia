// *****************************************************************************
// ArsChat M3 screenshot helper (PHASE1_DESIGN.md §9 M3 task "検証").
//
// GUI-less verification counterpart to the frontend M3 autotest. Under
// ARSCHAT_M3_AUTOTEST=1 it captures the main window twice, late enough that the
// frontend autotest (t+14s + streaming + persistence + a triggered history-panel
// reveal) has produced a rendered conversation and an open history panel:
//   - poc-artifacts/m3-chat-ui.png     - the chat area showing the streamed
//     Markdown answer with a highlighted code block and the <think> block;
//   - poc-artifacts/m3-history-panel.png - the left history panel listing the
//     persisted session.
//
// Reuses the M2 capture strategy (retry until the PNG is large enough to be the
// painted shell, not the loading overlay). Disabled by default - no effect on a
// normal start.
// *****************************************************************************

import * as fs from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';

const AUTOTEST_ENV_VAR = 'ARSCHAT_M3_AUTOTEST';

// arschat-branding/lib/electron-main/<this file> -> repo root is 3 levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'poc-artifacts');

@injectable()
export class ArschatM3AutotestContribution implements ElectronMainApplicationContribution {

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }
        console.log('[M3][autotest] electron-main screenshot helper enabled');
        // Chat UI first (after the round-trip has rendered), then the history panel.
        setTimeout(() => this.capture('m3-chat-ui.png', 0), 30000);
        setTimeout(() => this.capture('m3-history-panel.png', 0), 42000);
    }

    protected async capture(fileName: string, attempt: number): Promise<void> {
        const maxAttempts = 12;
        const minRealUiBytes = 30000; // loading overlay is ~6KB; painted shell is ~90KB+.
        const artifactPath = path.join(ARTIFACT_DIR, fileName);
        try {
            const windows = BrowserWindow.getAllWindows();
            const target = windows[0];
            if (!target) {
                console.error(`[M3][autotest] no window available to capture ${fileName} -> FAIL`);
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
            console.log(`[M3][autotest] screenshot saved (${png.length}B) -> ${artifactPath} -> ${png.length >= minRealUiBytes ? 'PASS' : 'SAVED (still small)'}`);
        } catch (error) {
            if (attempt + 1 < maxAttempts) {
                console.warn(`[M3][autotest] capture ${fileName} attempt ${attempt + 1} not ready (${error instanceof Error ? error.message : String(error)}), retrying in 4s`);
                setTimeout(() => this.capture(fileName, attempt + 1), 4000);
            } else {
                console.error(`[M3][autotest] screenshot capture ${fileName} FAILED after retries:`, error);
            }
        }
    }
}
