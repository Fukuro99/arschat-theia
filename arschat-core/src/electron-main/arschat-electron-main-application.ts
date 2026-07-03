// *****************************************************************************
// ArsChat PoC-1 (1-1): keep the app alive after all BrowserWindows are closed.
//
// Theia's stock `ElectronMainApplication#onWindowAllClosed` always calls
// `requestStop()` (-> `app.quit()`) once every BrowserWindow is closed
// (see node_modules/@theia/core/lib/electron-main/electron-main-application.js).
// There is no preference/option to opt out of this from contribution code —
// the only extension point is subclassing `ElectronMainApplication` and
// rebinding it in an electron-main DI module. This file is exactly that
// subclass; the rebind itself happens in `arschat-electron-main-module.ts`.
//
// No Theia source under node_modules is modified.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { Event as ElectronEvent } from '@theia/core/electron-shared/electron';

@injectable()
export class ArschatElectronMainApplication extends ElectronMainApplication {

    /**
     * When true, closing all windows must NOT quit the app (tray-resident mode).
     * Set by `ArschatTrayContribution` once the tray has been created successfully.
     * If tray creation fails, this stays false and Theia's default
     * "quit on window-all-closed" behavior is preserved (fail safe).
     */
    public keepAliveInTray = false;

    protected override onWindowAllClosed(event: ElectronEvent): void {
        if (this.keepAliveInTray) {
            console.log('[PoC-1] onWindowAllClosed suppressed (tray-resident mode) - app stays alive');
            event.preventDefault();
            return;
        }
        super.onWindowAllClosed(event);
    }
}
