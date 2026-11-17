import { ILogger, PreferenceScope, PreferenceService } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ArschatKeychainStatusService } from '../common/arschat-keychain-status-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { API_KEY_PREF as ANTHROPIC_KEY, CUSTOM_ENDPOINTS_PREF as ANTHROPIC_CUSTOM } from '@theia/ai-anthropic/lib/common/anthropic-preferences';
import { API_KEY_PREF as OPENAI_KEY, CUSTOM_ENDPOINTS_PREF as OPENAI_CUSTOM } from '@theia/ai-openai/lib/common/openai-preferences';
import { ArschatSecretStore } from './arschat-secret-store';

export const GLOBAL_SECRET_PREFERENCES = [[ANTHROPIC_KEY, 'anthropic'], [OPENAI_KEY, 'openai']] as const;
export const CUSTOM_SECRET_PREFERENCES = [OPENAI_CUSTOM, ANTHROPIC_CUSTOM];

type Endpoint = { id?: string; model?: string; apiKey?: string | boolean; [key: string]: unknown };

export function customSecretAccount(endpoint: { id?: string; model?: string }): string | undefined {
    const id = endpoint.id || endpoint.model; // Same fallback as Theia's model descriptions.
    return typeof id === 'string' && id ? `custom:${id}` : undefined;
}

@injectable()
export class ArschatSecretMigration implements FrontendApplicationContribution {
    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ILogger)
    protected readonly logger!: ILogger;
    @inject(ArschatKeychainStatusService)
    protected readonly keychainStatus!: ArschatKeychainStatusService;

    private startup?: Promise<void>;
    private pending: Promise<void> = Promise.resolve();
    private warnedUnavailable = false;

    onStart(): void {
        // Theia awaits contributions serially; preferences need later contributions to start.
        void this.ready().catch(() => {
            this.logger.warn('[arschat-secrets] migration startup failed; plaintext preferences retained');
        });
    }

    ready(): Promise<void> {
        return this.startup ?? (this.startup = this.migrate());
    }

    /** Also used by the opt-in autotest. Runs serially and is safe to repeat. */
    migrate(): Promise<void> {
        this.pending = this.pending.then(() => this.run()).catch(() => {
            this.logger.warn('[arschat-secrets] migration failed; plaintext preferences retained');
        });
        return this.pending;
    }

    private async preserve(account: string, value: string): Promise<boolean> {
        try {
            // Preserve an existing vault value (or the first, active workspace value).
            // In both cases verify through the backend before removing any plaintext.
            if (this.secrets.get(account) === undefined) {
                await this.secrets.set(account, value);
            } else {
                await this.secrets.verify(account);
            }
            return true;
        } catch {
            this.logger.warn('[arschat-secrets] credential verification failed; preference retained');
            return false;
        }
    }

    private async run(): Promise<void> {
        // Reading existing credentials must not depend on permission to persist new ones.
        await this.secrets.ready();
        await this.preferences.ready;
        if (!await this.keychainStatus.isPersistent()) {
            if (!this.warnedUnavailable) {
                this.warnedUnavailable = true;
                this.logger.warn('[arschat-secrets] OS credential store unavailable; plaintext preferences retained');
            }
            return;
        }
        // One account cannot represent two scope values. Preserve the active workspace first.
        for (const scope of [PreferenceScope.Workspace, PreferenceScope.User]) {
            for (const [name, account] of GLOBAL_SECRET_PREFERENCES) {
                const value = this.preferences.inspectInScope<string>(name, scope);
                if (typeof value === 'string' && value && await this.preserve(account, value)) {
                    if (this.preferences.inspectInScope<string>(name, scope) === value) {
                        await this.clearPreference(name, undefined, scope);
                    }
                }
            }
            for (const name of CUSTOM_SECRET_PREFERENCES) {
                const entries = this.preferences.inspectInScope<any>(name, scope) as Endpoint[] | undefined;
                if (!Array.isArray(entries)) { continue; }
                const migrated = new Map<string, string>();
                for (const entry of entries) {
                    const account = customSecretAccount(entry);
                    const value = entry.apiKey;
                    if (account && typeof value === 'string' && value && value !== 'sk-unsloth-local'
                        && await this.preserve(account, value)) {
                        migrated.set(account, value);
                    }
                }
                // Re-read after the RPCs so unrelated endpoint edits/seeding aren't overwritten.
                const current = this.preferences.inspectInScope<any>(name, scope) as Endpoint[] | undefined;
                if (!Array.isArray(current)) { continue; }
                let changed = false;
                const next = current.map(entry => {
                    const account = customSecretAccount(entry);
                    if (account && migrated.has(account) && migrated.get(account) === entry.apiKey) {
                        const { apiKey, ...rest } = entry;
                        changed = true;
                        return rest;
                    }
                    return entry;
                });
                if (changed) { await this.clearPreference(name, next, scope); }
            }
        }
    }

    private async clearPreference(name: string, value: unknown, scope: PreferenceScope): Promise<boolean> {
        try {
            await this.preferences.set(name, value, scope);
            return true;
        } catch {
            this.logger.warn('[arschat-secrets] preference cleanup failed; credential remains in store');
            return false;
        }
    }
}
