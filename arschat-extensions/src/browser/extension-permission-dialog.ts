import { AbstractDialog, DialogProps } from '@theia/core/lib/browser/dialogs';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ExtensionPermissionId, PERMISSION_DEFINITIONS } from '../common/extension-manifest';

export interface ExtensionPermissionDialogProps extends Partial<DialogProps> {
    readonly extensionDisplayName: string;
    readonly permissions: readonly ExtensionPermissionId[];
    readonly mode?: 'install' | 'update';
}

export class ExtensionPermissionDialog extends AbstractDialog<boolean> {

    protected approved = true;

    constructor(protected readonly permissionProps: ExtensionPermissionDialogProps) {
        super({
            title: permissionProps.title ?? (permissionProps.mode === 'update' ? '拡張の追加権限を確認' : '拡張の権限を確認'),
            maxWidth: permissionProps.maxWidth ?? 520,
            wordWrap: permissionProps.wordWrap
        });

        this.contentNode.appendChild(this.createContentNode());
        this.appendCloseButton('キャンセル');
        this.appendAcceptButton(permissionProps.mode === 'update' ? '追加権限を承認' : '承認して設置');
    }

    get value(): boolean {
        return this.approved;
    }

    protected override onCloseRequest(msg: Message): void {
        super.onCloseRequest(msg);
        this.approved = false;
        this.accept();
    }

    protected override handleEscape(event: KeyboardEvent): boolean | void {
        event.preventDefault();
        this.close();
        return true;
    }

    protected createContentNode(): HTMLElement {
        const root = this.node.ownerDocument.createElement('div');
        root.className = 'arschat-extension-permission-dialog';

        const summary = this.node.ownerDocument.createElement('p');
        summary.className = 'arschat-extension-permission-summary';
        summary.textContent = this.permissionProps.mode === 'update'
            ? `${this.permissionProps.extensionDisplayName} が追加で次の権限を要求しています。`
            : `${this.permissionProps.extensionDisplayName} が次の権限を要求しています。`;
        root.appendChild(summary);

        const list = this.node.ownerDocument.createElement('ul');
        list.className = 'arschat-extension-permission-list';
        for (const permission of this.permissionProps.permissions) {
            const item = this.node.ownerDocument.createElement('li');
            const id = this.node.ownerDocument.createElement('code');
            id.textContent = permission;
            const label = this.node.ownerDocument.createElement('span');
            label.textContent = permissionDescription(permission);
            item.appendChild(id);
            item.appendChild(label);
            list.appendChild(item);
        }
        root.appendChild(list);

        if (this.permissionProps.permissions.length === 0) {
            const none = this.node.ownerDocument.createElement('div');
            none.className = 'arschat-extension-permission-empty';
            none.textContent = '追加で要求されている権限はありません。';
            root.appendChild(none);
        }

        const note = this.node.ownerDocument.createElement('p');
        note.className = 'arschat-extension-permission-note';
        note.textContent = '承認した権限だけが拡張 API の実行時ゲートで許可されます。';
        root.appendChild(note);

        return root;
    }
}

function permissionDescription(permission: ExtensionPermissionId): string {
    return PERMISSION_DEFINITIONS.find(def => def.id === permission)?.label ?? permission;
}
