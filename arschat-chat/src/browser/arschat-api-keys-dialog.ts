import { AbstractDialog } from '@theia/core/lib/browser/dialogs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ArschatSecretStore } from 'arschat-providers/lib/browser/arschat-secret-store';
import { ArschatKeychainUnavailableError, ArschatSecretSettings } from 'arschat-providers/lib/browser/arschat-secret-settings';
import { customEndpointProviders } from 'arschat-providers/lib/browser/arschat-provider-preferences';

@injectable()
export class ArschatApiKeysDialogService {
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ArschatSecretSettings)
    protected readonly settings!: ArschatSecretSettings;

    async open(): Promise<void> {
        const dialog = new ArschatApiKeysDialog(this.secrets, this.settings);
        try { await dialog.open(); } finally { dialog.dispose(); }
    }
}

/** Native uncontrolled password fields; saved secrets are never copied into the DOM. */
export class ArschatApiKeysDialog extends AbstractDialog<void> {
    get value(): void { return undefined; }

    constructor(secrets: ArschatSecretStore, settings: ArschatSecretSettings) {
        super({ title: 'API キー' });
        this.node.classList.add('arschat-api-keys-dialog');
        const notice = document.createElement('p');
        notice.textContent = '保存したキーは再表示しません。変更するときは新しいキーを入力してください。';
        this.contentNode.appendChild(notice);
        const error = document.createElement('p');
        error.setAttribute('role', 'alert');
        this.contentNode.appendChild(error);
        const rows = [
            { account: 'anthropic', label: 'Anthropic' },
            { account: 'openai', label: 'OpenAI' },
            ...customEndpointProviders().map(provider => ({ account: `custom:${provider.fixedModelId}`, label: provider.label }))
        ];
        const refreshers: Array<() => void> = [];
        const buttons: HTMLButtonElement[] = [];
        for (const { account, label } of rows) {
            const row = document.createElement('div');
            row.className = 'arschat-api-key-row';
            const name = document.createElement('label');
            name.textContent = label;
            const input = document.createElement('input');
            input.id = `arschat-secret-${account}`;
            input.type = 'password';
            input.className = 'theia-input';
            input.autocomplete = 'new-password';
            input.setAttribute('aria-label', `${label} API キー`);
            name.htmlFor = input.id;
            const status = document.createElement('span');
            status.setAttribute('aria-live', 'polite');
            const refresh = (): void => { status.textContent = secrets.get(account) !== undefined ? '保存済み' : '未設定'; };
            refreshers.push(refresh);
            refresh();
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'theia-button';
            save.textContent = '保存';
            save.setAttribute('aria-label', `${label} のキーを保存`);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'theia-button secondary';
            remove.textContent = '削除';
            remove.setAttribute('aria-label', `${label} のキーを削除`);
            save.disabled = remove.disabled = true;
            buttons.push(save, remove);
            const edit = async (deleting: boolean): Promise<void> => {
                if (!deleting && !input.value.trim()) {
                    error.textContent = '保存する API キーを入力してください。';
                    return;
                }
                save.disabled = remove.disabled = true;
                error.textContent = '';
                try {
                    if (deleting) { await settings.delete(account); }
                    else { await settings.save(account, input.value.trim()); }
                    input.value = '';
                } catch (cause) {
                    error.textContent = cause instanceof ArschatKeychainUnavailableError
                        ? 'OS の資格情報マネージャーが使えないため保存できません'
                        : 'API キーまたは設定の更新に失敗しました。再試行してください。';
                } finally {
                    refresh();
                    save.disabled = remove.disabled = false;
                }
            };
            save.onclick = () => { void edit(false); };
            remove.onclick = () => { void edit(true); };
            row.append(name, status, input, save, remove);
            this.contentNode.appendChild(row);
        }
        this.toDispose.push(secrets.onDidChange(() => refreshers.forEach(refresh => refresh())));
        void secrets.ready().then(() => {
            refreshers.forEach(refresh => refresh());
        }).catch(() => {
            error.textContent = 'API キーの読み込みに失敗しました。操作時に再試行します。';
        }).finally(() => buttons.forEach(button => { button.disabled = false; }));
        this.appendCloseButton('閉じる');
    }

    // The default dialog Enter action would close the entire editor without saving.
    protected override handleEnter(): boolean { return false; }
}
