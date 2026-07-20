import * as React from 'react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { DisposableCollection, MessageService } from '@theia/core';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ExtensionRegistryService, InstalledExtension } from './extension-registry-service';
import { ExtensionPermissionDialog } from './extension-permission-dialog';
import { ExtensionPermissionId } from '../common/extension-manifest';
import { ExtensionBridgeRequestLimiter } from '../common/extension-bridge-limits';
import {
    checkExtensionMethodPermission,
    createExtensionErrorResponse,
    createExtensionResponse,
    ExtensionBridgeError,
    EXTENSION_REQUEST_TYPE,
    isExtensionRequestMessage
} from '../common/extension-bridge-protocol';

export const EXTENSION_SANDBOX_CSP_CONTENT =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";

export function injectExtensionSandboxCsp(html: string): string {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const meta = document.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', EXTENSION_SANDBOX_CSP_CONTENT);
    document.head.insertBefore(meta, document.head.firstChild);
    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '';
    return `${doctype}${document.documentElement.outerHTML}`;
}

@injectable()
export class ExtensionHostWidget extends ReactWidget {

    static readonly FACTORY_ID = 'arschat-extensions:host';

    @inject(ExtensionRegistryService)
    protected readonly registry!: ExtensionRegistryService;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    protected readonly iframeRef = React.createRef<HTMLIFrameElement>();
    protected extensionName = '';
    protected extension: InstalledExtension | undefined;
    protected blobUrl: string | undefined;
    protected loadError = '';
    protected iframeInitialLoadSeen = false;
    protected loadingExtension = false;
    protected readonly toDispose = new DisposableCollection();
    protected readonly requestLimiter = new ExtensionBridgeRequestLimiter();

    setExtensionName(name: string): void {
        this.extensionName = name;
        this.id = `${ExtensionHostWidget.FACTORY_ID}:${name}`;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-puzzle-piece';
        this.toDispose.push(this.registry.onDidChange(() => this.handleRegistryChange()));
        this.loadExtension().catch(e => {
            this.loadError = e instanceof Error ? e.message : String(e);
            this.update();
        });
    }

    override dispose(): void {
        this.toDispose.dispose();
        this.revokeBlobUrl();
        window.removeEventListener('message', this.handleMessage);
        super.dispose();
    }

    protected async loadExtension(): Promise<void> {
        if (this.loadingExtension) {
            return;
        }
        this.loadingExtension = true;
        try {
            await this.registry.ready();
            if (this.isDisposed) {
                return;
            }
            let extension = this.registry.getExtension(this.extensionName);
            if (!extension) {
                throw new Error(`Extension not installed: ${this.extensionName}`);
            }
            if (extension.source.kind === 'local') {
                const updated = await this.registry.update(
                    extension.name,
                    request => this.confirmPermissions(request.manifest.displayName, request.newPermissions, 'update'),
                    { notifyWhenUnchanged: false }
                );
                if (!updated) {
                    this.extension = extension;
                    this.title.label = extension.displayName;
                    this.title.caption = extension.displayName;
                    this.loadError = '追加権限が承認されなかったため、ローカル拡張を読み込みませんでした。';
                    this.revokeBlobUrl();
                    this.update();
                    return;
                }
                extension = updated;
            }
            this.extension = extension;
            this.title.label = extension.displayName;
            this.title.caption = extension.displayName;
            if (!extension.enabled) {
                this.disableView();
                return;
            }
            this.loadError = '';
            this.revokeBlobUrl();
            const html = await this.registry.getInstalledHtml(extension.name);
            if (this.isDisposed) {
                return;
            }
            this.iframeInitialLoadSeen = false;
            this.blobUrl = URL.createObjectURL(new Blob([injectExtensionSandboxCsp(html)], { type: 'text/html' }));
            window.removeEventListener('message', this.handleMessage);
            window.addEventListener('message', this.handleMessage);
            this.update();
        } finally {
            this.loadingExtension = false;
        }
    }

    protected handleRegistryChange(): void {
        const latest = this.registry.getExtension(this.extensionName);
        if (!latest) {
            this.close();
            return;
        }
        this.extension = latest;
        this.title.label = latest.displayName;
        this.title.caption = latest.displayName;
        if (!latest.enabled) {
            this.disableView();
            return;
        }
        if (!this.loadingExtension) {
            this.loadExtension().catch(e => {
                this.loadError = e instanceof Error ? e.message : String(e);
                this.update();
            });
        } else {
            this.loadError = '';
            this.update();
        }
    }

    protected disableView(): void {
        this.loadError = 'Extension is disabled.';
        this.revokeBlobUrl();
        this.update();
    }

    protected async confirmPermissions(
        displayName: string,
        permissions: readonly ExtensionPermissionId[],
        mode: 'update'
    ): Promise<boolean> {
        const result = await new ExtensionPermissionDialog({
            extensionDisplayName: displayName,
            permissions,
            mode
        }).open();
        return result === true;
    }

    protected readonly handleMessage = (event: MessageEvent): void => {
        const iframeWindow = this.iframeRef.current?.contentWindow;
        if (event.source !== iframeWindow || !isExtensionRequestMessage(event.data)) {
            return;
        }
        const message = event.data;
        if (message.type !== EXTENSION_REQUEST_TYPE || message.extId !== this.extensionName) {
            return;
        }
        this.requestLimiter.run(() => this.dispatchRequest(message.requestId, message.method, message.params))
            .then(result => this.postResponse(createExtensionResponse(this.extensionName, message.requestId, result)))
            .catch(e => {
                this.postResponse(createExtensionErrorResponse(this.extensionName, message.requestId, this.toBridgeError(e)));
            });
    };

    protected async dispatchRequest(requestId: string, method: string, params: unknown): Promise<unknown> {
        const ext = this.registry.getExtension(this.extensionName);
        if (!ext || !ext.enabled) {
            throw { code: 'INTERNAL', message: 'Extension is not available' };
        }
        const gate = checkExtensionMethodPermission(method, ext.grantedPermissions);
        if (!gate.ok) {
            throw gate.error;
        }
        switch (gate.method) {
            case 'storage.get':
                return this.registry.getStorage(ext.name, readStringParam(params, 'key'));
            case 'storage.set': {
                const key = readStringParam(params, 'key');
                if (!key) {
                    throw new Error('storage.set requires params.key');
                }
                await this.registry.setStorage(ext.name, key, readParam(params, 'value'));
                return { ok: true };
            }
            case 'notification.show': {
                const text = readStringParam(params, 'message') ?? readStringParam(params, 'text') ?? '';
                this.messages.info(text);
                return { ok: true };
            }
            case 'chat.send': {
                const text = readStringParam(params, 'text') ?? readStringParam(params, 'message');
                if (!text) {
                    throw new Error('chat.send requires params.text');
                }
                const session = this.chatService.getActiveSession() ?? this.chatService.createSession(undefined, { focus: false });
                const invocation = await this.chatService.sendRequest(session.id, { text });
                if (invocation) {
                    await invocation.responseCompleted;
                }
                return { sessionId: session.id };
            }
            case 'chat.read': {
                const session = this.chatService.getActiveSession();
                return session
                    ? {
                        sessionId: session.id,
                        title: session.title ?? '',
                        messages: session.model.getRequests().flatMap(req => {
                            const userText = req.request.displayText ?? req.request.text ?? '';
                            const assistantText = req.response.response.asString();
                            return [
                                { role: 'user', text: userText },
                                ...(assistantText ? [{ role: 'assistant' as const, text: assistantText }] : [])
                            ];
                        })
                    }
                    : { sessionId: undefined, messages: [] };
            }
        }
        throw { code: 'UNKNOWN_METHOD', message: `Unknown extension method: ${method}` };
    }

    protected toBridgeError(error: unknown): ExtensionBridgeError {
        return error && typeof error === 'object' && 'code' in error && 'message' in error
            ? error as ExtensionBridgeError
            : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
    }

    protected postResponse(message: unknown): void {
        this.iframeRef.current?.contentWindow?.postMessage(message, '*');
    }

    protected readonly handleIframeLoad = (): void => {
        if (!this.blobUrl || this.loadError) {
            return;
        }
        if (!this.iframeInitialLoadSeen) {
            this.iframeInitialLoadSeen = true;
            return;
        }
        // A sandboxed iframe that self-navigates loads a fresh document, dropping the injected CSP meta.
        this.loadError = 'Extension iframe navigation was blocked.';
        this.revokeBlobUrl();
        this.update();
    };

    protected revokeBlobUrl(): void {
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl);
            this.blobUrl = undefined;
        }
    }

    render(): React.ReactElement {
        if (this.loadError) {
            return <div className='arschat-extension-host-error'>{this.loadError}</div>;
        }
        if (!this.blobUrl) {
            return <div className='arschat-extension-host-loading'>Loading...</div>;
        }
        return (
            <div className='arschat-extension-host-root'>
                <iframe
                    ref={this.iframeRef}
                    src={this.blobUrl}
                    sandbox='allow-scripts'
                    title={this.extension?.displayName ?? this.extensionName}
                    onLoad={this.handleIframeLoad}
                />
            </div>
        );
    }
}

function readStringParam(params: unknown, key: string): string | undefined {
    const value = readParam(params, key);
    return typeof value === 'string' ? value : undefined;
}

function readParam(params: unknown, key: string): unknown {
    return params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
}
