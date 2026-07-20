import * as React from 'react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { DisposableCollection } from '@theia/core';
import { ExtensionHostWidget } from './extension-host-widget';
import { ExtensionRegistryService, InstalledExtension } from './extension-registry-service';
import { permissionLabel } from '../common/extension-manifest';

@injectable()
export class ExtensionManagerWidget extends ReactWidget {

    static readonly ID = 'arschat-extensions:manager';
    static readonly LABEL = 'ArsChat Extensions';

    @inject(ExtensionRegistryService)
    protected readonly registry!: ExtensionRegistryService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    protected extensions: InstalledExtension[] = [];
    protected localPath = '';
    protected error = '';
    protected busy = false;

    protected readonly toDispose = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.id = ExtensionManagerWidget.ID;
        this.title.label = ExtensionManagerWidget.LABEL;
        this.title.caption = ExtensionManagerWidget.LABEL;
        this.title.iconClass = 'fa fa-puzzle-piece';
        this.title.closable = true;
        this.addClass('arschat-extension-manager-widget');
        this.toDispose.push(this.registry.onDidChange(() => this.refresh()));
        this.refresh();
    }

    override dispose(): void {
        this.toDispose.dispose();
        super.dispose();
    }

    protected async refresh(): Promise<void> {
        await this.registry.ready();
        this.extensions = this.registry.getExtensions();
        this.update();
    }

    protected async installLocal(): Promise<void> {
        const path = this.localPath.trim();
        if (!path || this.busy) {
            return;
        }
        this.busy = true;
        this.error = '';
        this.update();
        try {
            const manifest = await this.registry.readLocalManifest(path);
            // TODO(ms-14 Phase 2): replace this explicit temporary grant with the permission approval dialog.
            await this.registry.installFromLocalPath(path, manifest.permissions);
            this.localPath = '';
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.busy = false;
            await this.refresh();
        }
    }

    protected async openExtension(name: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<ExtensionHostWidget>(
            ExtensionHostWidget.FACTORY_ID,
            { name }
        );
        if (!this.shell.getWidgets('main').some(existing => existing.id === widget.id)) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);
    }

    protected async setEnabled(name: string, enabled: boolean): Promise<void> {
        await this.registry.setEnabled(name, enabled);
    }

    protected async uninstall(name: string, displayName: string): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: 'Uninstall ArsChat Extension',
            msg: `Uninstall ${displayName}?`
        }).open();
        if (confirmed) {
            await this.registry.uninstall(name);
        }
    }

    render(): React.ReactElement {
        return (
            <div className='arschat-extension-manager-root'>
                <div className='arschat-extension-install'>
                    <input
                        className='theia-input arschat-extension-local-path'
                        value={this.localPath}
                        placeholder='Local extension folder or arschat-extension.json'
                        onChange={e => { this.localPath = e.target.value; this.update(); }}
                    />
                    <button
                        className='theia-button arschat-extension-install-button'
                        disabled={this.busy || !this.localPath.trim()}
                        onClick={() => this.installLocal()}
                    >Install</button>
                </div>
                {this.error && <div className='arschat-extension-error'>{this.error}</div>}
                <div className='arschat-extension-list'>
                    {this.extensions.length === 0 && (
                        <div className='arschat-extension-empty'>No extensions installed.</div>
                    )}
                    {this.extensions.map(ext => this.renderExtension(ext))}
                </div>
            </div>
        );
    }

    protected renderExtension(ext: InstalledExtension): React.ReactElement {
        return (
            <div key={ext.name} className={`arschat-extension-item ${ext.enabled ? 'enabled' : 'disabled'}`}>
                <div className='arschat-extension-item-main'>
                    <div className='arschat-extension-title-row'>
                        <span className='arschat-extension-name'>{ext.displayName}</span>
                        <span className='arschat-extension-version'>{ext.version}</span>
                    </div>
                    <div className='arschat-extension-id'>{ext.name}</div>
                    {ext.description && <div className='arschat-extension-description'>{ext.description}</div>}
                    <div className='arschat-extension-permissions'>
                        {ext.grantedPermissions.length === 0
                            ? 'No permissions granted'
                            : ext.grantedPermissions.map(permissionLabel).join(', ')}
                    </div>
                </div>
                <div className='arschat-extension-actions'>
                    <button
                        className='theia-button secondary'
                        disabled={!ext.enabled}
                        onClick={() => this.openExtension(ext.name)}
                    >Open</button>
                    <button
                        className='theia-button secondary'
                        onClick={() => this.setEnabled(ext.name, !ext.enabled)}
                    >{ext.enabled ? 'Disable' : 'Enable'}</button>
                    <button
                        className='theia-button secondary'
                        onClick={() => this.uninstall(ext.name, ext.displayName)}
                    >Uninstall</button>
                </div>
            </div>
        );
    }
}
