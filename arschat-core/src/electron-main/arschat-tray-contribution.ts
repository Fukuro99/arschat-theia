// *****************************************************************************
// ArsChat PoC-1: electron-main customization spike.
//
//   1-1 System tray:      Tray icon + context menu (show/hide, quit). Closing
//                         all windows must NOT quit the app while the tray
//                         is alive (see arschat-electron-main-application.ts
//                         for the `onWindowAllClosed` override this relies on).
//   1-2 Global shortcut:  CommandOrControl+Shift+Space toggles main window
//                         visibility, registered via Electron's globalShortcut.
//   1-3 Widget window:    A frameless, always-on-top, ~360x480 second
//                         BrowserWindow loaded from an inline data: URL.
//
// Implemented purely as an `ElectronMainApplicationContribution` bound from
// an electron-main DI module (see arschat-electron-main-module.ts). No Theia
// source under node_modules is modified; the `ElectronMainApplication`
// subclass used here is also bound via DI rebind, not by editing Theia.
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    app,
    Tray,
    Menu,
    globalShortcut,
    BrowserWindow,
    nativeImage
} from '@theia/core/electron-shared/electron';
import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ArschatElectronMainApplication } from './arschat-electron-main-application';
import { TRAY_ICON_PNG_BASE64 } from './arschat-tray-icon';

const GLOBAL_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';
const WIDGET_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+W';

const WIDGET_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>ArsChat Widget PoC</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: rgba(30, 30, 30, 0.92);
    color: #f0f0f0;
    font-family: sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: drag;
    border: 1px solid #2d8cf0;
    box-sizing: border-box;
    border-radius: 8px;
    overflow: hidden;
  }
  h1 { font-size: 16px; text-align: center; padding: 0 16px; }
</style>
</head>
<body>
  <h1>ArsChat Widget PoC</h1>
</body>
</html>
`;

@injectable()
export class ArschatTrayContribution implements ElectronMainApplicationContribution {

    @inject(ElectronMainApplication)
    protected readonly application: ArschatElectronMainApplication;

    protected tray: Tray | undefined;
    protected widgetWindow: BrowserWindow | undefined;

    public isWidgetWindowAlive(): boolean {
        return !!this.widgetWindow && !this.widgetWindow.isDestroyed();
    }

    onStart(application: ElectronMainApplication): void {
        this.setupTray(application);
        this.setupGlobalShortcut(application);
        this.setupWidgetShortcut();
    }

    onStop(): void {
        if (this.tray) {
            this.tray.destroy();
            this.tray = undefined;
        }
        const toggleUnregistered = this.tryUnregister(GLOBAL_TOGGLE_SHORTCUT);
        const widgetUnregistered = this.tryUnregister(WIDGET_TOGGLE_SHORTCUT);
        console.log(`[PoC-1] onStop: shortcuts unregistered (toggle=${toggleUnregistered}, widget=${widgetUnregistered})`);
    }

    // ------------------------------------------------------------------
    // 1-1 System tray
    // ------------------------------------------------------------------

    protected setupTray(application: ElectronMainApplication): void {
        try {
            const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
            this.tray = new Tray(icon);
            this.tray.setToolTip('ArsChat (PoC)');

            const menu = Menu.buildFromTemplate([
                {
                    label: '表示/非表示',
                    click: () => this.toggleMainWindow(application)
                },
                { type: 'separator' },
                {
                    label: '終了',
                    click: () => {
                        console.log('[PoC-1] tray "quit" clicked - forcing app.quit()');
                        this.application.keepAliveInTray = false;
                        app.quit();
                    }
                }
            ]);
            this.tray.setContextMenu(menu);
            this.tray.on('click', () => this.toggleMainWindow(application));

            // Only now do we allow window-all-closed to be suppressed: if tray
            // creation had thrown, we want the default Theia quit behavior
            // (fail-safe - no windows and no tray would otherwise be an
            // unkillable zombie process).
            this.application.keepAliveInTray = true;

            console.log('[PoC-1] tray created successfully - app will stay resident after all windows are closed');
        } catch (error) {
            console.error('[PoC-1] tray creation FAILED:', error);
        }
    }

    protected toggleMainWindow(application: ElectronMainApplication): void {
        const windows = BrowserWindow.getAllWindows().filter(w => w !== this.widgetWindow);
        if (windows.length === 0) {
            console.log('[PoC-1] tray toggle: no main window open, opening a new default window');
            application.openDefaultWindow();
            return;
        }
        for (const win of windows) {
            if (win.isVisible()) {
                win.hide();
            } else {
                win.show();
                win.focus();
            }
        }
    }

    // ------------------------------------------------------------------
    // 1-2 Global shortcut
    // ------------------------------------------------------------------

    protected setupGlobalShortcut(application: ElectronMainApplication): void {
        const ok = globalShortcut.register(GLOBAL_TOGGLE_SHORTCUT, () => {
            console.log(`[PoC-1] global shortcut ${GLOBAL_TOGGLE_SHORTCUT} triggered`);
            this.toggleMainWindow(application);
        });
        console.log(`[PoC-1] globalShortcut.register('${GLOBAL_TOGGLE_SHORTCUT}') === ${ok}`);
        if (!ok) {
            console.error(`[PoC-1] globalShortcut registration FAILED for ${GLOBAL_TOGGLE_SHORTCUT} (likely OS-level conflict)`);
        }
    }

    // ------------------------------------------------------------------
    // 1-3 Widget window
    // ------------------------------------------------------------------

    protected setupWidgetShortcut(): void {
        const ok = globalShortcut.register(WIDGET_TOGGLE_SHORTCUT, () => {
            console.log(`[PoC-1] widget shortcut ${WIDGET_TOGGLE_SHORTCUT} triggered`);
            this.toggleWidgetWindow();
        });
        console.log(`[PoC-1] globalShortcut.register('${WIDGET_TOGGLE_SHORTCUT}') === ${ok}`);
    }

    public toggleWidgetWindow(): void {
        if (this.widgetWindow && !this.widgetWindow.isDestroyed()) {
            if (this.widgetWindow.isVisible()) {
                this.widgetWindow.hide();
            } else {
                this.widgetWindow.show();
            }
            return;
        }
        this.createWidgetWindow();
    }

    protected createWidgetWindow(): void {
        try {
            this.widgetWindow = new BrowserWindow({
                width: 360,
                height: 480,
                frame: false,
                alwaysOnTop: true,
                resizable: false,
                skipTaskbar: true,
                show: false,
                webPreferences: {
                    // PoC widget only loads static inline HTML - no app-integration needed.
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });
            this.widgetWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(WIDGET_HTML)}`);
            this.widgetWindow.once('ready-to-show', () => {
                this.widgetWindow?.show();
            });
            this.widgetWindow.on('closed', () => {
                console.log('[PoC-1] widget window closed (main Theia windows unaffected)');
                this.widgetWindow = undefined;
            });
            console.log('[PoC-1] widget window created successfully (360x480, frameless, always-on-top)');
        } catch (error) {
            console.error('[PoC-1] widget window creation FAILED:', error);
        }
    }

    protected tryUnregister(accelerator: string): boolean {
        try {
            globalShortcut.unregister(accelerator);
            return true;
        } catch (error) {
            console.error(`[PoC-1] failed to unregister ${accelerator}:`, error);
            return false;
        }
    }
}
