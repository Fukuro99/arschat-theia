import * as React from 'react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { DisposableCollection } from '@theia/core';
import { ExtensionHostWidget } from './extension-host-widget';
import { ExtensionPermissionApprovalRequest, ExtensionRegistryService, InstalledExtension } from './extension-registry-service';
import { ExtensionPermissionId, permissionLabel } from '../common/extension-manifest';
import { ExtensionFetchService } from '../common/extension-fetch-protocol';
import { ExtensionPermissionDialog } from './extension-permission-dialog';

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

    @inject(ExtensionFetchService)
    protected readonly fetchService!: ExtensionFetchService;

    protected extensions: InstalledExtension[] = [];
    protected localPath = '';
    protected githubUrl = '';
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
            const data = await this.registry.readLocalExtensionData(path);
            const approved = await this.confirmPermissions(data.manifest.displayName, data.manifest.permissions, 'install');
            if (approved) {
                await this.registry.installFromData(
                    data.manifestText,
                    data.html,
                    { kind: 'local', path },
                    data.manifest.permissions
                );
                this.localPath = '';
            }
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.busy = false;
            await this.refresh();
        }
    }

    protected async installGitHub(): Promise<void> {
        const url = this.githubUrl.trim();
        if (!url || this.busy) {
            return;
        }
        this.busy = true;
        this.error = '';
        this.update();
        try {
            const data = await this.fetchService.fetchFromGitHub({ url });
            const approved = await this.confirmPermissions(data.manifest.displayName, data.manifest.permissions, 'install');
            if (approved) {
                await this.registry.installFromData(
                    data.manifestText,
                    data.html,
                    { kind: 'github', url },
                    data.manifest.permissions
                );
                this.githubUrl = '';
            }
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

    protected async updateExtension(name: string): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        this.error = '';
        this.update();
        try {
            await this.registry.update(name, request => this.confirmUpdatePermissions(request));
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.busy = false;
            await this.refresh();
        }
    }

    protected async uninstall(name: string, displayName: string): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: 'ArsChat 拡張を削除',
            msg: `${displayName} を削除しますか？`
        }).open();
        if (confirmed) {
            await this.registry.uninstall(name);
        }
    }

    protected confirmUpdatePermissions(request: ExtensionPermissionApprovalRequest): Promise<boolean> {
        return this.confirmPermissions(request.manifest.displayName, request.newPermissions, 'update');
    }

    protected async confirmPermissions(
        displayName: string,
        permissions: readonly ExtensionPermissionId[],
        mode: 'install' | 'update'
    ): Promise<boolean> {
        const result = await new ExtensionPermissionDialog({
            extensionDisplayName: displayName,
            permissions,
            mode
        }).open();
        return result === true;
    }

    render(): React.ReactElement {
        return (
            <div className='arschat-extension-manager-root'>
                <div className='arschat-extension-install'>
                    <input
                        className='theia-input arschat-extension-source-input'
                        value={this.githubUrl}
                        placeholder='https://github.com/owner/repo'
                        onChange={e => { this.githubUrl = e.target.value; this.update(); }}
                    />
                    <button
                        className='theia-button arschat-extension-install-button'
                        disabled={this.busy || !this.githubUrl.trim()}
                        onClick={() => this.installGitHub()}
                    >GitHub から設置</button>
                </div>
                <div className='arschat-extension-install'>
                    <input
                        className='theia-input arschat-extension-source-input'
                        value={this.localPath}
                        placeholder='ローカル拡張フォルダーまたは arschat-extension.json'
                        onChange={e => { this.localPath = e.target.value; this.update(); }}
                    />
                    <button
                        className='theia-button arschat-extension-install-button'
                        disabled={this.busy || !this.localPath.trim()}
                        onClick={() => this.installLocal()}
                    >ローカル設置</button>
                </div>
                {this.error && <div className='arschat-extension-error'>{this.error}</div>}
                <div className='arschat-extension-list'>
                    {this.extensions.length === 0 && (
                        <div className='arschat-extension-empty'>設置済みの拡張はありません。</div>
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
                            ? '承認済み権限なし'
                            : ext.grantedPermissions.map(permissionLabel).join(', ')}
                    </div>
                </div>
                <div className='arschat-extension-actions'>
                    <button
                        className='theia-button secondary'
                        disabled={this.busy || !ext.enabled}
                        onClick={() => this.openExtension(ext.name)}
                    >開く</button>
                    <label className='arschat-extension-enabled-toggle'>
                        <input
                            type='checkbox'
                            checked={ext.enabled}
                            disabled={this.busy}
                            onChange={e => this.setEnabled(ext.name, e.currentTarget.checked)}
                        />
                        <span>{ext.enabled ? '有効' : '無効'}</span>
                    </label>
                    <button
                        className='theia-button secondary'
                        disabled={this.busy || ext.source.kind === 'autotest'}
                        onClick={() => this.updateExtension(ext.name)}
                    >更新</button>
                    <button
                        className='theia-button secondary'
                        disabled={this.busy}
                        onClick={() => this.uninstall(ext.name, ext.displayName)}
                    >削除</button>
                </div>
            </div>
        );
    }
}
