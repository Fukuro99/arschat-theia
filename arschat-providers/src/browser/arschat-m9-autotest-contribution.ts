import { PreferenceScope, PreferenceService } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AnthropicFrontendApplicationContribution } from '@theia/ai-anthropic/lib/browser/anthropic-frontend-application-contribution';
import { API_KEY_PREF } from '@theia/ai-anthropic/lib/common/anthropic-preferences';
import { ArschatAnthropicFrontendContribution } from './arschat-secret-frontend-contributions';
import { ArschatSecretStore } from './arschat-secret-store';
import { ArschatSecretMigration } from './arschat-secret-migration';
import { OPENAI_CUSTOM_ENDPOINTS_PREF } from './arschat-provider-preferences';
import { ArschatKeychainStatusService } from '../common/arschat-keychain-status-service';

@injectable()
export class ArschatM9AutotestContribution implements FrontendApplicationContribution {
    @inject(EnvVariablesServer)
    protected readonly env!: EnvVariablesServer;
    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ArschatSecretMigration)
    protected readonly migration!: ArschatSecretMigration;
    @inject(ArschatKeychainStatusService)
    protected readonly keychainStatus!: ArschatKeychainStatusService;
    @inject(AnthropicFrontendApplicationContribution)
    protected readonly anthropic!: ArschatAnthropicFrontendContribution;

    async onStart(): Promise<void> {
        try {
            if ((await this.env.getValue('ARSCHAT_M9_AUTOTEST'))?.value !== '1') { return; }
        } catch { return; }
        await this.run();
    }

    protected async run(): Promise<void> {
        let pass = 0;
        let fail = 0;
        let skip = 0;
        const check = (name: string, ok: boolean): void => {
            if (ok) { pass++; } else { fail++; }
            console.log(`[M9][autotest] ${name}: ${ok ? 'PASS' : 'FAIL'}`);
        };
        let roundtripOwned = false;
        let migrationOwned = false;
        const entries = (): any[] => this.preferences.inspectInScope<any>(OPENAI_CUSTOM_ENDPOINTS_PREF, PreferenceScope.User) ?? [];
        let originallyUndefined = false;
        let persistent = false;
        try {
            persistent = await this.keychainStatus.isPersistent();
            console.log(`[M9][autotest] isPersistent: ${persistent}`);
            await this.migration.ready();
            await this.secrets.ready();
            // Never clobber credentials/preferences from an interrupted or unrelated run.
            if (this.secrets.get('autotest:m9') !== undefined || this.secrets.get('custom:m9-autotest') !== undefined
                || entries().some(entry => entry.id === 'm9-autotest')) { throw new Error('reserved accounts occupied'); }
            if (persistent) {
                roundtripOwned = true;
                await this.secrets.set('autotest:m9', 'sk-m9-autotest-dummy');
                const matched = this.secrets.get('autotest:m9') === 'sk-m9-autotest-dummy';
                await this.secrets.delete('autotest:m9');
                check('roundtrip', matched && this.secrets.get('autotest:m9') === undefined);
            } else {
                skip++;
                console.log('[M9][autotest] roundtrip: SKIP (OS credential store unavailable)');
            }

            originallyUndefined = this.preferences.inspectInScope(OPENAI_CUSTOM_ENDPOINTS_PREF, PreferenceScope.User) === undefined;
            migrationOwned = true;
            await this.preferences.set(OPENAI_CUSTOM_ENDPOINTS_PREF, [...entries(), {
                id: 'm9-autotest', model: 'x', url: 'http://localhost:1/v1', apiKey: 'sk-m9-autotest-dummy'
            }], PreferenceScope.User);
            await this.migration.migrate();
            const entry = entries().find(item => item.id === 'm9-autotest');
            check(persistent ? 'migration (immediate cleanup)' : 'migration (plaintext retained)', persistent
                ? this.secrets.get('custom:m9-autotest') === 'sk-m9-autotest-dummy' && !!entry && entry.apiKey === undefined
                : this.secrets.get('custom:m9-autotest') === undefined && entry?.apiKey === 'sk-m9-autotest-dummy');

            await this.anthropic.onStart();
            if (this.secrets.get('anthropic') === undefined && !this.preferences.get(API_KEY_PREF)) {
                check('injection (undefined; see arschat-secrets startup log)', this.anthropic.apiKeyInitialized);
            } else {
                skip++;
                console.log('[M9][autotest] injection: SKIP (Anthropic credential configured; retained)');
            }
        } catch {
            check('execution', false); // Do not expose backend exception text.
        } finally {
            try {
                if (migrationOwned) {
                    const remaining = entries().filter(entry => entry.id !== 'm9-autotest');
                    await this.preferences.set(OPENAI_CUSTOM_ENDPOINTS_PREF,
                        originallyUndefined && !remaining.length ? undefined : remaining, PreferenceScope.User);
                    if (persistent) { await this.secrets.delete('custom:m9-autotest'); }
                }
            } catch { check('migration cleanup', false); }
            try {
                if (roundtripOwned) { await this.secrets.delete('autotest:m9'); }
            } catch { check('roundtrip cleanup', false); }
            console.log(`[M9][autotest] SUMMARY ${pass} PASS / ${fail} FAIL / ${skip} SKIP`);
        }
    }
}
