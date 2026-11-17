import { Emitter } from '@theia/core/lib/common/event';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import { inject, injectable } from '@theia/core/shared/inversify';

export const ARSCHAT_SECRET_SERVICE = 'arschat';

/** Frontend cache only; persistence and read-back always go through the backend RPC. */
@injectable()
export class ArschatSecretStore {
    @inject(KeyStoreService)
    protected readonly keyStore!: KeyStoreService;

    protected cache = new Map<string, string>();
    protected loading?: Promise<void>;
    protected readonly changed = new Emitter<string>();
    readonly onDidChange = this.changed.event;
    private writes: Promise<unknown> = Promise.resolve();

    ready(): Promise<void> {
        if (!this.loading) {
            this.loading = this.preload().catch(() => {
                this.loading = undefined; // Allow a later UI operation to retry.
                throw new Error('API キーの読み込みに失敗しました。');
            });
        }
        return this.loading;
    }

    private async preload(): Promise<void> {
        const cache = new Map<string, string>();
        for (const account of await this.keyStore.keys(ARSCHAT_SECRET_SERVICE)) {
            // findCredentials may return keytar's Windows chunk encoding. getPassword reassembles it.
            const value = await this.keyStore.getPassword(ARSCHAT_SECRET_SERVICE, account);
            if (value !== undefined) {
                cache.set(account, value);
            }
        }
        const previous = this.cache;
        this.cache = cache;
        for (const account of new Set([...previous.keys(), ...cache.keys()])) {
            if (previous.get(account) !== cache.get(account)) {
                this.changed.fire(account);
            }
        }
    }

    get(account: string): string | undefined {
        return this.cache.get(account);
    }

    /** Confirm an existing credential without overwriting it from a stale frontend cache. */
    verify(account: string): Promise<void> {
        return this.enqueue(async () => {
            await this.ready();
            const value = this.cache.get(account);
            if (value === undefined || await this.keyStore.getPassword(ARSCHAT_SECRET_SERVICE, account) !== value) {
                throw new Error('read-back mismatch');
            }
        }, 'API キーの照合に失敗しました。');
    }

    set(account: string, value: string): Promise<void> {
        return this.enqueue(async () => {
            await this.ready();
            await this.keyStore.setPassword(ARSCHAT_SECRET_SERVICE, account, value);
            if (await this.keyStore.getPassword(ARSCHAT_SECRET_SERVICE, account) !== value) {
                throw new Error('read-back mismatch');
            }
            this.cache.set(account, value);
            this.changed.fire(account);
        }, 'API キーの保存・照合に失敗しました。');
    }

    delete(account: string): Promise<void> {
        return this.enqueue(async () => {
            await this.ready();
            await this.keyStore.deletePassword(ARSCHAT_SECRET_SERVICE, account);
            if (await this.keyStore.getPassword(ARSCHAT_SECRET_SERVICE, account) !== undefined) {
                throw new Error('delete failed');
            }
            this.cache.delete(account);
            this.changed.fire(account);
        }, 'API キーの削除に失敗しました。');
    }

    private enqueue(operation: () => Promise<void>, message: string): Promise<void> {
        const result = this.writes.then(operation).catch(() => {
            // Backend exceptions can contain credentials. Never forward their text to UI/logs.
            throw new Error(message);
        });
        this.writes = result.catch(() => undefined);
        return result;
    }
}
