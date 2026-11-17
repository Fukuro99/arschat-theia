import { DisposableCollection } from '@theia/core';
import { inject, injectable } from '@theia/core/shared/inversify';
import { PREFERENCE_NAME_MAX_RETRIES } from '@theia/ai-core/lib/common/ai-core-preferences';
import { AnthropicFrontendApplicationContribution } from '@theia/ai-anthropic/lib/browser/anthropic-frontend-application-contribution';
import { OpenAiFrontendApplicationContribution } from '@theia/ai-openai/lib/browser/openai-frontend-application-contribution';
import { AnthropicModelDescription } from '@theia/ai-anthropic/lib/common';
import { OpenAiModelDescription } from '@theia/ai-openai/lib/common';
import * as AnthropicPrefs from '@theia/ai-anthropic/lib/common/anthropic-preferences';
import * as OpenAiPrefs from '@theia/ai-openai/lib/common/openai-preferences';
import { ArschatSecretStore } from './arschat-secret-store';
import { ArschatSecretMigration, customSecretAccount } from './arschat-secret-migration';

// Theia 1.71 binds each class toSelf + a FrontendApplicationContribution toService alias.
// Only rebind those class tokens. Do not call super.onStart: it installs plaintext-key listeners.

@injectable()
export class ArschatAnthropicFrontendContribution extends AnthropicFrontendApplicationContribution {
    apiKeyInitialized = false;
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ArschatSecretMigration)
    protected readonly migration!: ArschatSecretMigration;
    private readonly subscriptions = new DisposableCollection();
    private startup?: Promise<void>;

    override onStart(): Promise<void> {
        return this.startup ?? (this.startup = this.start());
    }

    private async start(): Promise<void> {
        await this.preferenceService.ready;
        await Promise.all([
            // Keep listeners alive after a read failure so a later successful preload reinjects keys.
            this.secrets.ready().catch(() => undefined),
            this.migration.ready()
        ]);
        try {
            await this.applyApiKey();
            this.apiKeyInitialized = true;
            this.manager.setProxyUrl(this.preferenceService.get<string>('http.proxy', undefined));
            this.handleModelChanges(this.preferenceService.get<string[]>(AnthropicPrefs.MODELS_PREF, []));
            this.handleCustomModelChanges(this.preferenceService.get<Partial<AnthropicModelDescription>[]>(AnthropicPrefs.CUSTOM_ENDPOINTS_PREF, []));
            this.subscriptions.push(this.preferenceService.onPreferenceChanged(event => {
                if (event.preferenceName === AnthropicPrefs.API_KEY_PREF) {
                    void this.refresh();
                } else if (event.preferenceName === AnthropicPrefs.MODELS_PREF) {
                    this.handleModelChanges(this.preferenceService.get<string[]>(AnthropicPrefs.MODELS_PREF, []));
                } else if (event.preferenceName === AnthropicPrefs.CUSTOM_ENDPOINTS_PREF) {
                    this.handleCustomModelChanges(this.preferenceService.get<Partial<AnthropicModelDescription>[]>(AnthropicPrefs.CUSTOM_ENDPOINTS_PREF, []));
                } else if (event.preferenceName === 'http.proxy') {
                    this.manager.setProxyUrl(this.preferenceService.get<string>('http.proxy', undefined));
                    this.updateAllModels();
                }
            }));
            this.subscriptions.push(this.aiCorePreferences.onPreferenceChanged(event => {
                if (event.preferenceName === PREFERENCE_NAME_MAX_RETRIES) { this.updateAllModels(); }
            }));
            this.subscriptions.push(this.secrets.onDidChange(account => {
                if (account === 'anthropic' || account.startsWith('custom:')) { void this.refresh(); }
            }));
            console.info('[arschat-secrets] anthropic key injection initialized');
        } catch {
            console.warn('[arschat-secrets] anthropic key injection failed');
        }
    }

    private async applyApiKey(): Promise<void> {
        // undefined deliberately preserves the backend's environment-variable fallback.
        await this.manager.setApiKey(this.secrets.get('anthropic')
            ?? (this.preferenceService.get<string>(AnthropicPrefs.API_KEY_PREF, undefined) || undefined));
    }

    private async refresh(): Promise<void> {
        try {
            await this.applyApiKey();
            // Re-register ALL custom models: comparing old/new via the same cache misses secret changes.
            this.updateAllModels();
        } catch {
            console.warn('[arschat-secrets] anthropic model refresh failed');
        }
    }

    protected override createCustomModelDescriptionsFromPreferences(
        preferences: Partial<AnthropicModelDescription>[]
    ): AnthropicModelDescription[] {
        return super.createCustomModelDescriptionsFromPreferences(preferences.map(pref => {
            const account = customSecretAccount(pref);
            return pref.apiKey === undefined && account && this.secrets.get(account) !== undefined
                ? { ...pref, apiKey: this.secrets.get(account) }
                : pref;
        }));
    }

    onStop(): void { this.subscriptions.dispose(); }
}

@injectable()
export class ArschatOpenAiFrontendContribution extends OpenAiFrontendApplicationContribution {
    @inject(ArschatSecretStore)
    protected readonly secrets!: ArschatSecretStore;
    @inject(ArschatSecretMigration)
    protected readonly migration!: ArschatSecretMigration;
    private readonly subscriptions = new DisposableCollection();
    private startup?: Promise<void>;

    override onStart(): Promise<void> {
        return this.startup ?? (this.startup = this.start());
    }

    private async start(): Promise<void> {
        await this.preferenceService.ready;
        await Promise.all([
            // Keep listeners alive after a read failure so a later successful preload reinjects keys.
            this.secrets.ready().catch(() => undefined),
            this.migration.ready()
        ]);
        try {
            await this.applyApiKey();
            this.manager.setProxyUrl(this.preferenceService.get<string>('http.proxy', undefined));
            this.handleModelChanges(this.preferenceService.get<string[]>(OpenAiPrefs.MODELS_PREF, []));
            this.handleCustomModelChanges(this.preferenceService.get<Partial<OpenAiModelDescription>[]>(OpenAiPrefs.CUSTOM_ENDPOINTS_PREF, []));
            this.subscriptions.push(this.preferenceService.onPreferenceChanged(event => {
                if (event.preferenceName === OpenAiPrefs.API_KEY_PREF) {
                    void this.refresh();
                } else if (event.preferenceName === OpenAiPrefs.MODELS_PREF) {
                    this.handleModelChanges(this.preferenceService.get<string[]>(OpenAiPrefs.MODELS_PREF, []));
                } else if (event.preferenceName === OpenAiPrefs.CUSTOM_ENDPOINTS_PREF) {
                    this.handleCustomModelChanges(this.preferenceService.get<Partial<OpenAiModelDescription>[]>(OpenAiPrefs.CUSTOM_ENDPOINTS_PREF, []));
                } else if (event.preferenceName === 'http.proxy') {
                    this.manager.setProxyUrl(this.preferenceService.get<string>('http.proxy', undefined));
                    this.updateAllModels();
                } else if (event.preferenceName === OpenAiPrefs.USE_RESPONSE_API_PREF) {
                    this.updateAllModels();
                }
            }));
            this.subscriptions.push(this.aiCorePreferences.onPreferenceChanged(event => {
                if (event.preferenceName === PREFERENCE_NAME_MAX_RETRIES) { this.updateAllModels(); }
            }));
            this.subscriptions.push(this.secrets.onDidChange(account => {
                if (account === 'openai' || account.startsWith('custom:')) { void this.refresh(); }
            }));
            console.info('[arschat-secrets] openai key injection initialized');
        } catch {
            console.warn('[arschat-secrets] openai key injection failed');
        }
    }

    private async applyApiKey(): Promise<void> {
        // undefined deliberately preserves the backend's environment-variable fallback.
        await this.manager.setApiKey(this.secrets.get('openai')
            ?? (this.preferenceService.get<string>(OpenAiPrefs.API_KEY_PREF, undefined) || undefined));
    }

    private async refresh(): Promise<void> {
        try {
            await this.applyApiKey();
            // Re-register ALL custom models: comparing old/new via the same cache misses secret changes.
            this.updateAllModels();
        } catch {
            console.warn('[arschat-secrets] openai model refresh failed');
        }
    }

    protected override createCustomModelDescriptionsFromPreferences(
        preferences: Partial<OpenAiModelDescription>[]
    ): OpenAiModelDescription[] {
        return super.createCustomModelDescriptionsFromPreferences(preferences.map(pref => {
            const account = customSecretAccount(pref);
            return pref.apiKey === undefined && account && this.secrets.get(account) !== undefined
                ? { ...pref, apiKey: this.secrets.get(account) }
                : pref;
        }));
    }

    onStop(): void { this.subscriptions.dispose(); }
}

