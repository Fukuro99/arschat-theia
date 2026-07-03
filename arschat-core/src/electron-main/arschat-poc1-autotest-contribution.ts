// *****************************************************************************
// ArsChat PoC-1 verification helper.
//
// This app currently runs in a GUI-less verification environment, so manual
// clicking/hotkey-pressing is not possible. This contribution provides an
// opt-in automatic check gated by ARSCHAT_POC1_AUTOTEST=1:
//
//   t+3s  : programmatically trigger the widget window creation (1-3) and
//           log whether it was created successfully, without relying on the
//           OS actually delivering the global hotkey.
//   t+10s : close all Theia BrowserWindows to verify the app stays alive
//           in tray-resident mode (1-1).
//   t+13s : log a final PASS if the electron-main process is still running.
//
// Disabled by default (flag-gated) - set the env var only for the PoC-1 run,
// per the task's "add temporary verification code, then remove/flag it" note.
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { BrowserWindow } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ArschatTrayContribution } from './arschat-tray-contribution';

const AUTOTEST_ENV_VAR = 'ARSCHAT_POC1_AUTOTEST';

@injectable()
export class ArschatPoc1AutotestContribution implements ElectronMainApplicationContribution {

    @inject(ArschatTrayContribution)
    protected readonly trayContribution: ArschatTrayContribution;

    onStart(): void {
        if (process.env[AUTOTEST_ENV_VAR] !== '1') {
            return;
        }

        console.log('[PoC-1][autotest] enabled');

        setTimeout(() => {
            console.log('[PoC-1][autotest] t+3s: programmatically opening widget window (simulating hotkey)');
            this.trayContribution.toggleWidgetWindow();
            const alive = this.trayContribution.isWidgetWindowAlive();
            console.log(`[PoC-1][autotest] t+3s: widget window alive === ${alive} -> ${alive ? 'PASS' : 'FAIL'}`);
        }, 3000);

        setTimeout(() => {
            const windows = BrowserWindow.getAllWindows();
            console.log(`[PoC-1][autotest] t+10s: closing ${windows.length} window(s) total (main Theia window(s) + widget)`);
            for (const win of windows) {
                win.close();
            }

            setTimeout(() => {
                console.log('[PoC-1][autotest] t+13s: process still alive after closing all windows -> PASS (tray-resident behavior confirmed)');
            }, 3000);
        }, 10000);
    }
}
