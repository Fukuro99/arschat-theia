import { PreferenceScope, PreferenceService } from '@theia/core';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ArschatSecretMigration, CUSTOM_SECRET_PREFERENCES, GLOBAL_SECRET_PREFERENCES, customSecretAccount } from './arschat-secret-migration';
import { ArschatSecretStore } from './arschat-secret-store';
import { ArschatKeychainStatusService } from '../common/arschat-keychain-status-service';

export class ArschatKeychainUnavailableError extends Error {
    constructor() { super('OS の資格情報マネージャーが使えないため保存できません'); }
}

/** Only verified persistent saves may replace legacy plaintext preferences. */
@injectable()
export class ArschatSecretSettings {
    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ArschatSecretMigration)
    protected readonly migration!: ArschatSecretMigration;
    @inject(ArschatKeychainStatusService)
    protected readonly keychainStatus!: ArschatKeychainStatusService;
    private pending: Promise<unknown> = Promise.resolve();

    save(account: string, value: string): Promise<void> {
        return this.edit(account, value);
    }

    delete(account: string): Promise<void> {
        return this.edit(account);
    }

    private edit(account: string, value?: string): Promise<void> {
        const next = this.pending.then(async () => {
            if (value !== undefined && !await this.keychainStatus.isPersistent()) {
                throw new ArschatKeychainUnavailableError();
            }
            await this.migration.ready();
            if (value !== undefined) {
                await this.secrets.set(account, value);
            }
            for (const scope of [PreferenceScope.Workspace, PreferenceScope.User]) {
                for (const [name, globalAccount] of GLOBAL_SECRET_PREFERENCES) {
                    if (account === globalAccount && typeof this.preferences.inspectInScope(name, scope) === 'string') {
                        await this.preferences.set(name, undefined, scope);
                    }
                }
                for (const name of CUSTOM_SECRET_PREFERENCES) {
                    const entries = this.preferences.inspectInScope<any>(name, scope);
                    if (!Array.isArray(entries)) { continue; }
                    let changed = false;
                    const updated = entries.map(entry => {
                        if (customSecretAccount(entry) !== account || entry.apiKey === undefined) { return entry; }
                        // Automatic migration and deletion leave the public Unsloth seed/global flag alone.
                        // Explicit save switches this endpoint to the user's per-endpoint credential.
                        if (value === undefined && (entry.apiKey === 'sk-unsloth-local' || entry.apiKey === true)) { return entry; }
                        changed = true;
                        const { apiKey, ...rest } = entry;
                        return rest;
                    });
                    if (changed) { await this.preferences.set(name, updated, scope); }
                }
            }
            if (value === undefined) {
                await this.secrets.delete(account);
            }
        }).catch(error => {
            if (error instanceof ArschatKeychainUnavailableError) { throw error; }
            throw new Error('API キーまたは設定の更新に失敗しました。再試行してください。');
        });
        this.pending = next.catch(() => undefined);
        return next;
    }
}
