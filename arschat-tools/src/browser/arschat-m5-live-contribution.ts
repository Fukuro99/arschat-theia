// *****************************************************************************
// ArsChat M5 LIVE verification (PHASE1_DESIGN.md §9 M5, task e-10).
//
// The live counterpart to the e-7 offline autotest
// (arschat-m5-autotest-contribution.ts). Where e-7 drives the six tools with a
// MOCK LanguageModel, THIS contribution drives them with a REAL LLM (LM Studio on
// the LAN, OpenAI-compatible), so the whole tool-calling path — the provider
// adapter deciding to emit tool_calls, calling the confirmation-wrapped handler,
// and the approval gate — is exercised end to end against a real model.
//
// Enabled only when ARSCHAT_M5_LIVE=1 (read from the BACKEND env via
// EnvVariablesServer, because the renderer's process.env is shimmed empty — same
// as the M2/M3/M4/e-7 autotests). Completely no-op otherwise.
//
// ---- What "live" changes vs e-7 -------------------------------------------
//   * NO mock model. On start we (a) point the chosen custom OpenAI endpoint
//     (default `lmstudio`, selected via ARSCHAT_M5_LIVE_PROVIDER) at the LAN URL +
//     real model (overridable via ARSCHAT_M5_LIVE_URL / ARSCHAT_M5_LIVE_MODEL),
//     which re-registers that endpoint's LanguageModel (openai-frontend-application-
//     contribution reacts to the preference change), then (b) point the ArsChat
//     agent at it directly (see pointAgentAtProvider for why we skip setActive).
//   * We send REAL natural-language prompts through ChatService and let the model
//     itself decide to call tools. We assert on the ASSISTANT'S REPLY TEXT
//     (response.response.asString()), not on a mock's captured result.
//   * Approval is still driven programmatically: we watch onInteractionNeeded (+ a
//     content poll fallback, same as e-7) and call content.confirm()/deny() —
//     that mirrors the widget's allow/deny buttons without a human in the loop.
//
// ---- Scenarios (require the live model to actually call tools) -------------
//   L1 read      : seed a temp file with a known passphrase, ask the model to read
//                  it and tell us the passphrase → the reply must contain it.
//   L2 write ok  : ask to write "hello-live" to a unique path → confirmation state
//                  is reached (file NOT yet on disk) → confirm() → file appears.
//   L3 write deny: ask to write to another path → deny() → file must NOT exist and
//                  the reply should acknowledge the refusal.
//   L4 always-allow (measurement, not pass/fail): after L2, set write_file to
//                  ALWAYS_ALLOW the exact way the widget's onToolAllow('forever')
//                  does — setConfirmationMode('write_file', ALWAYS_ALLOW) WITHOUT
//                  passing the ToolRequest — then ask to write again and OBSERVE
//                  whether a confirmation is still requested. Logged as an empirical
//                  result either way (this is the point Phase-1 review left open).
//   L5 run_cmd   : ask to run `echo live-test` → confirmation → confirm() →
//                  exit 0 + stdout reflected in the reply.
//
// Isolation: everything the run touches (the seeded files, the preference writes)
// resolves under Theia's config dir; launch with THEIA_CONFIG_DIR pointed at a
// temp dir (see BUILD_NOTES e-10) so the normal ~/.theia config is never touched.
// As belt-and-suspenders we ALSO snapshot the two preferences we mutate
// (customOpenAiModels + toolConfirmation) and restore them at the end, and we
// never write to C:\Users\...\AppData\Roaming\ArsChat (the old app's data).
//
// All logs use the [M5-LIVE] prefix; a SUMMARY line closes the run.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ILogger, PreferenceService, URI } from '@theia/core';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ToolCallChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ToolConfirmationManager } from '@theia/ai-chat/lib/browser/chat-tool-preference-bindings';
import { ToolConfirmationMode } from '@theia/ai-chat/lib/common/chat-tool-preferences';
import { AISettingsService, LanguageModelRegistry, LanguageModelRequirement } from '@theia/ai-core';
import { ARSCHAT_CHAT_AGENT_ID, ARSCHAT_CHAT_PURPOSE } from 'arschat-providers/lib/browser/provider-switch-service';
import {
    ArschatProviderKind,
    LMSTUDIO_ID,
    OPENAI_CUSTOM_ENDPOINTS_PREF,
    PROVIDERS
} from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { WRITE_FILE_TOOL_ID } from '../common/tool-ids';

/** Theia's tool-confirmation preference key (mirrors chat-tool-preferences). */
const TOOL_CONFIRMATION_PREF = 'ai-features.chat.toolConfirmation';

/** Defaults for the LAN LM Studio (overridable via env: ARSCHAT_M5_LIVE_PROVIDER / _URL / _MODEL). Confirmed reachable + tool-calling in e-10. */
const DEFAULT_LIVE_URL = 'http://192.168.1.149:1234/v1';
const DEFAULT_LIVE_MODEL = 'qwen/qwen3.6-35b-a3b';

/** Reasoning model: a single round-trip can take tens of seconds. Be generous. */
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000;
/** Retries per scenario to absorb LLM non-determinism (a run where it just chats and skips the tool). */
const MAX_ATTEMPTS = 3;

interface CustomOpenAiEntry {
    id?: string;
    model?: string;
    url?: string;
    apiKey?: string | boolean;
    enableStreaming?: boolean;
    developerMessageSettings?: string;
    [k: string]: unknown;
}

@injectable()
export class ArschatM5LiveContribution implements FrontendApplicationContribution {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    @inject(AISettingsService)
    protected readonly settingsService!: AISettingsService;

    @inject(LanguageModelRegistry)
    protected readonly languageModelRegistry!: LanguageModelRegistry;

    @inject(ChatService)
    protected readonly chatService!: ChatService;

    @inject(ChatAgentService)
    protected readonly chatAgentService!: ChatAgentService;

    @inject(ToolConfirmationManager)
    protected readonly toolConfirmationManager!: ToolConfirmationManager;

    @inject(ArschatFileToolsService)
    protected readonly fileTools!: ArschatFileToolsService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    /** Snapshots restored at the end so we do not leave the config dirty even without THEIA_CONFIG_DIR. */
    protected savedCustomEndpoints: CustomOpenAiEntry[] | undefined;
    protected savedToolConfirmation: Record<string, string> | undefined;

    protected log(message: string): void {
        console.log(message);
        this.logger.info(message);
    }

    async onStart(): Promise<void> {
        const enabled = await this.getBackendEnv('ARSCHAT_M5_LIVE');
        if (enabled !== '1') {
            return;
        }
        // Let the workbench + agents + tool registration + provider seeding settle
        // before we repoint the endpoint and start driving.
        setTimeout(() => this.run().catch(err =>
            this.log(`[M5-LIVE] fatal error ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)), 15000);
    }

    protected async getBackendEnv(key: string): Promise<string | undefined> {
        try {
            return (await this.envServer.getValue(key))?.value;
        } catch {
            return undefined;
        }
    }

    protected async run(): Promise<void> {
        this.log('[M5-LIVE] enabled (frontend) — real LLM tool verification');
        const providerKind = (await this.getBackendEnv('ARSCHAT_M5_LIVE_PROVIDER')) || LMSTUDIO_ID;
        if (!PROVIDERS.some(p => p.kind === providerKind && !!p.fixedModelId)) {
            this.log(`[M5-LIVE] SETUP FAILED: ARSCHAT_M5_LIVE_PROVIDER='${providerKind}' is not a custom-endpoint provider kind`);
            this.log('[M5-LIVE] SUMMARY: 0 PASS / 5 FAIL (setup failed) — L4 not measured');
            return;
        }
        const provider = providerKind as ArschatProviderKind;
        const url = (await this.getBackendEnv('ARSCHAT_M5_LIVE_URL')) || DEFAULT_LIVE_URL;
        const model = (await this.getBackendEnv('ARSCHAT_M5_LIVE_MODEL')) || DEFAULT_LIVE_MODEL;

        try {
            await this.pointAgentAtProvider(provider, url, model);
        } catch (e) {
            this.log(`[M5-LIVE] SETUP FAILED (could not point agent at '${provider}'): ${e instanceof Error ? e.message : String(e)}`);
            this.log('[M5-LIVE] SUMMARY: 0 PASS / 5 FAIL (setup failed) — L4 not measured');
            return;
        }

        let pass = 0;
        let fail = 0;
        const tally = (ok: boolean) => { if (ok) { pass++; } else { fail++; } };

        try {
            tally(await this.withRetry('L1', () => this.scenarioL1Read()));
            tally(await this.withRetry('L2', () => this.scenarioL2WriteAllow()));
            tally(await this.withRetry('L3', () => this.scenarioL3WriteDeny()));
            // L4 is a measurement — it never counts toward PASS/FAIL, only the log matters.
            await this.scenarioL4AlwaysAllow();
            tally(await this.withRetry('L5', () => this.scenarioL5RunCommand()));
        } finally {
            await this.restorePreferences();
        }

        this.log(`[M5-LIVE] SUMMARY: ${pass} PASS / ${fail} FAIL (of ${pass + fail} pass/fail scenarios; L4 = measurement, see its log line)`);
        this.log('[M5-LIVE] done');
    }

    // ------------------------------------------------------------- provider setup

    /**
     * Repoint the chosen custom OpenAI endpoint (default `lmstudio`, selected via
     * ARSCHAT_M5_LIVE_PROVIDER) at the LAN URL + real model (re-registering that
     * endpoint's LanguageModel), then point the ArsChat agent at it. Snapshots the
     * endpoint preference for restoration.
     *
     * NOTE: we do NOT go through ProviderSwitchService.setActive here, because that
     * writes the `arschat.provider.*` preferences at the (default) Workspace scope,
     * which throws "Unable to write to Workspace Settings" in a headless run with no
     * folder open. Instead we drive the agent's model requirement directly via
     * AISettingsService + the live agent instance field — the exact belt-and-
     * suspenders path ProviderSwitchService documents and the e-7 autotest uses.
     * All preference writes here use PreferenceScope.User (never Workspace).
     */
    protected async pointAgentAtProvider(provider: ArschatProviderKind, url: string, model: string): Promise<void> {
        await this.preferenceService.ready;
        const existing = this.preferenceService.get<CustomOpenAiEntry[]>(OPENAI_CUSTOM_ENDPOINTS_PREF, []) ?? [];
        this.savedCustomEndpoints = JSON.parse(JSON.stringify(existing));

        const updated = existing.map(e => e.id === provider
            ? { ...e, url, model, enableStreaming: true }
            : e);
        if (!updated.some(e => e.id === provider)) {
            updated.push({ id: provider, model, url, enableStreaming: true, developerMessageSettings: 'system' });
        }
        await this.preferenceService.set(OPENAI_CUSTOM_ENDPOINTS_PREF, updated, PreferenceScope.User);
        this.log(`[M5-LIVE] provider='${provider}' endpoint set: url='${url}' model='${model}'`);

        // Give @theia/ai-openai's onPreferenceChanged a moment to re-register the model.
        await this.delay(1500);
        const models = await this.languageModelRegistry.getLanguageModels();
        const lm = models.find(m => m.id === provider);
        this.log(`[M5-LIVE] LanguageModel '${provider}' registered=${!!lm} (total models=${models.length})`);

        // Point the ArsChat agent at the endpoint's model (both paths, per §10 analysis).
        const requirement: LanguageModelRequirement = { purpose: ARSCHAT_CHAT_PURPOSE, identifier: provider };
        await this.settingsService.updateAgentSettings(ARSCHAT_CHAT_AGENT_ID, { languageModelRequirements: [requirement] });
        const agent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID) as
            { languageModelRequirements?: LanguageModelRequirement[] } | undefined;
        if (agent) {
            agent.languageModelRequirements = [requirement];
        }
        this.log(`[M5-LIVE] ArsChat agent pointed at LanguageModel id='${provider}'`);
        await this.delay(500);
    }

    // -------------------------------------------------------------------- L1 read

    protected async scenarioL1Read(): Promise<boolean> {
        const stamp = Date.now();
        const passphrase = `PURPLE-OTTER-${stamp}`;
        const uri = await this.scratchUri(`m5-live-read-${stamp}.txt`);
        const filePath = uri.path.fsPath();
        await this.fileTools.writeFile(filePath, `合言葉は ${passphrase} です。\nこの行の下は無関係な内容。\n`);

        const prompt = `ローカルのファイル "${filePath}" を read_file ツールで読んで、その中に書かれている合言葉を教えてください。`;
        const reply = await this.driveChat(prompt);
        const ok = reply.toUpperCase().includes(passphrase.toUpperCase());
        this.log(`[M5-LIVE] L1 read: passphraseInReply=${ok} passphrase='${passphrase}' `
            + `replyLen=${reply.length} -> ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) {
            this.log(`[M5-LIVE] L1 reply excerpt: ${this.excerpt(reply)}`);
        }
        await this.deleteQuietly(uri);
        return ok;
    }

    // -------------------------------------------------------------- L2 write allow

    protected async scenarioL2WriteAllow(): Promise<boolean> {
        const stamp = Date.now();
        const uri = await this.scratchUri(`m5-live-write-allow-${stamp}.txt`);
        const filePath = uri.path.fsPath();
        const preExists = await this.fileExists(uri);

        let confirmationSeen = false;
        let fileExistedAtConfirmTime = false;
        const prompt = `ファイル "${filePath}" に、内容として「hello-live」とだけ write_file ツールで書き込んでください。`;

        const reply = await this.driveChat(prompt, {
            decision: 'confirm',
            onConfirmAbout: async () => {
                confirmationSeen = true;
                fileExistedAtConfirmTime = await this.fileExists(uri);
            }
        });

        await this.delay(400);
        const exists = await this.fileExists(uri);
        const content = exists ? await this.readRaw(uri) : '';
        const contentOk = content.includes('hello-live');
        const ok = !preExists && confirmationSeen && !fileExistedAtConfirmTime && exists && contentOk;
        this.log(`[M5-LIVE] L2 write allow: confirmationRequested=${confirmationSeen} `
            + `notWrittenBeforeConfirm=${!fileExistedAtConfirmTime} fileWrittenAfterConfirm=${exists && contentOk} `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) {
            this.log(`[M5-LIVE] L2 reply excerpt: ${this.excerpt(reply)}`);
        }
        await this.deleteQuietly(uri);
        return ok;
    }

    // --------------------------------------------------------------- L3 write deny

    protected async scenarioL3WriteDeny(): Promise<boolean> {
        const stamp = Date.now();
        const uri = await this.scratchUri(`m5-live-write-deny-${stamp}.txt`);
        const filePath = uri.path.fsPath();
        const preExists = await this.fileExists(uri);

        let confirmationSeen = false;
        const prompt = `ファイル "${filePath}" に「must-not-exist」という内容を write_file ツールで書き込んでください。`;

        const reply = await this.driveChat(prompt, {
            decision: 'deny',
            onConfirmAbout: async () => { confirmationSeen = true; }
        });

        await this.delay(300);
        const exists = await this.fileExists(uri);
        // The model should acknowledge the write was refused/failed (loose match — the
        // wording is the model's, so we look for common refusal/failure signals).
        const lowered = reply.toLowerCase();
        const acknowledgesRefusal = /(拒否|却下|できません|されませんでした|失敗|denied|refus|reject|not.*(written|created)|could ?n.t|was.*not)/i.test(lowered)
            || /denied/.test(lowered);
        const ok = !preExists && confirmationSeen && !exists && acknowledgesRefusal;
        this.log(`[M5-LIVE] L3 write deny: confirmationRequested=${confirmationSeen} fileNotWritten=${!exists} `
            + `replyAcknowledgesRefusal=${acknowledgesRefusal} -> ${ok ? 'PASS' : 'FAIL'}`);
        this.log(`[M5-LIVE] L3 reply excerpt: ${this.excerpt(reply)}`);
        if (exists) {
            await this.deleteQuietly(uri);
        }
        return ok;
    }

    // --------------------------------------------------------- L4 always-allow probe

    /**
     * The key open measurement. After L2 proved write_file confirms once, set it to
     * ALWAYS_ALLOW exactly as the widget does — setConfirmationMode(id, ALWAYS_ALLOW)
     * with NO ToolRequest arg — then write again and OBSERVE whether a confirmation
     * is still requested. Neither outcome is a FAIL; we record the measured truth.
     */
    protected async scenarioL4AlwaysAllow(): Promise<void> {
        // Snapshot the toolConfirmation pref so restorePreferences() can undo this.
        if (this.savedToolConfirmation === undefined) {
            this.savedToolConfirmation = { ...(this.preferenceService.get<Record<string, string>>(TOOL_CONFIRMATION_PREF, {}) ?? {}) };
        }

        // EXACTLY the widget's onToolAllow('forever') call: no ToolRequest passed.
        this.toolConfirmationManager.setConfirmationMode(WRITE_FILE_TOOL_ID, ToolConfirmationMode.ALWAYS_ALLOW);
        const storedPref = this.preferenceService.get<Record<string, string>>(TOOL_CONFIRMATION_PREF, {}) ?? {};
        const storedMode = storedPref[WRITE_FILE_TOOL_ID];
        this.log(`[M5-LIVE] L4 setConfirmationMode('write_file', ALWAYS_ALLOW) done — `
            + `stored toolConfirmation['write_file']=${storedMode === undefined ? '<absent — key was deleted>' : `'${storedMode}'`}`);

        const stamp = Date.now();
        const uri = await this.scratchUri(`m5-live-write-forever-${stamp}.txt`);
        const filePath = uri.path.fsPath();

        let confirmationRequested = false;
        const prompt = `もう一度、ファイル "${filePath}" に「hello-live-2」という内容を write_file ツールで書き込んでください。`;

        // We DO auto-confirm if asked (so the round-trip completes), but the
        // measurement is WHETHER we were asked at all.
        const reply = await this.driveChat(prompt, {
            decision: 'confirm',
            onConfirmAbout: async () => { confirmationRequested = true; }
        });
        await this.delay(400);
        const exists = await this.fileExists(uri);

        const verdict = confirmationRequested
            ? 'RE-CONFIRMED (the "常に許可/forever" button does NOT suppress confirmation for write_file)'
            : 'RAN WITHOUT CONFIRMATION (the "常に許可/forever" button DID suppress confirmation)';
        this.log(`[M5-LIVE] L4 always-allow MEASUREMENT: confirmationRequestedAgain=${confirmationRequested} `
            + `fileWritten=${exists} -> ${verdict}`);
        if (!exists && !confirmationRequested) {
            this.log(`[M5-LIVE] L4 note: file not written and no confirmation seen — model may not have called the tool. Reply excerpt: ${this.excerpt(reply)}`);
        }
        await this.deleteQuietly(uri);
    }

    // ------------------------------------------------------------- L5 run_command

    protected async scenarioL5RunCommand(): Promise<boolean> {
        const marker = 'live-test';
        let confirmationSeen = false;
        const prompt = `run_command ツールで「echo ${marker}」というコマンドを実行して、その出力を教えてください。`;

        const reply = await this.driveChat(prompt, {
            decision: 'confirm',
            onConfirmAbout: async () => { confirmationSeen = true; }
        });
        const gotStdout = reply.includes(marker);
        const ok = confirmationSeen && gotStdout;
        this.log(`[M5-LIVE] L5 run_command: confirmationRequested=${confirmationSeen} stdoutMarkerInReply=${gotStdout} `
            + `-> ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) {
            this.log(`[M5-LIVE] L5 reply excerpt: ${this.excerpt(reply)}`);
        }
        return ok;
    }

    // -------------------------------------------------------------------- driver

    /**
     * Send one real prompt through ChatService to the ArsChat agent (LM Studio),
     * driving any tool confirmation per `opts.decision`. Returns the assistant's
     * accumulated reply text (response.response.asString()).
     */
    protected async driveChat(
        text: string,
        opts?: {
            decision?: 'confirm' | 'deny';
            /** Invoked the first time a tool call needs interaction, BEFORE we confirm/deny. */
            onConfirmAbout?: () => Promise<void> | void;
        }
    ): Promise<string> {
        const chatAgent = this.chatAgentService.getAgent(ARSCHAT_CHAT_AGENT_ID);
        const session = this.chatService.createSession(undefined, { focus: false }, chatAgent);
        const invocation = await this.chatService.sendRequest(session.id, { text });
        if (!invocation) {
            this.log('[M5-LIVE] driveChat: sendRequest returned undefined');
            return '';
        }

        const decision = opts?.decision;
        const acted = new Set<string>();
        const response = await invocation.responseCreated;

        const handleContent = async (content: ToolCallChatResponseContent): Promise<void> => {
            const key = content.id ?? content.name ?? '<unknown>';
            if (content.finished || acted.has(key)) {
                return;
            }
            if (!decision) {
                return;
            }
            acted.add(key);
            if (opts?.onConfirmAbout) {
                await opts.onConfirmAbout();
            }
            if (decision === 'confirm') {
                content.confirm();
            } else {
                content.deny('M5-LIVE programmatic denial');
            }
        };

        const sub = response.onInteractionNeeded(c => {
            if (ToolCallChatResponseContent.is(c)) {
                void handleContent(c);
            }
        });
        // Poll fallback (onInteractionNeeded fires once; catch late-subscribe cases).
        const poll = setInterval(() => {
            for (const c of response.response.content) {
                if (ToolCallChatResponseContent.is(c) && !c.finished) {
                    void handleContent(c);
                }
            }
        }, 200);

        try {
            await this.withTimeout(invocation.responseCompleted, SCENARIO_TIMEOUT_MS, 'responseCompleted');
        } catch (e) {
            this.log(`[M5-LIVE] driveChat timeout/err: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            sub.dispose();
            clearInterval(poll);
        }

        try {
            return response.response.asString();
        } catch {
            return '';
        }
    }

    /** Run a scenario up to MAX_ATTEMPTS times to absorb LLM non-determinism. */
    protected async withRetry(label: string, fn: () => Promise<boolean>): Promise<boolean> {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let ok = false;
            try {
                ok = await fn();
            } catch (e) {
                this.log(`[M5-LIVE] ${label} attempt ${attempt} threw: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (ok) {
                if (attempt > 1) {
                    this.log(`[M5-LIVE] ${label} passed on attempt ${attempt}/${MAX_ATTEMPTS}`);
                }
                return true;
            }
            if (attempt < MAX_ATTEMPTS) {
                this.log(`[M5-LIVE] ${label} attempt ${attempt}/${MAX_ATTEMPTS} did not pass, retrying`);
                await this.delay(1000);
            }
        }
        this.log(`[M5-LIVE] ${label} FAILED after ${MAX_ATTEMPTS} attempts`);
        return false;
    }

    // -------------------------------------------------------------------- restore

    protected async restorePreferences(): Promise<void> {
        try {
            if (this.savedCustomEndpoints !== undefined) {
                await this.preferenceService.set(OPENAI_CUSTOM_ENDPOINTS_PREF, this.savedCustomEndpoints, PreferenceScope.User);
            }
            if (this.savedToolConfirmation !== undefined) {
                await this.preferenceService.set(TOOL_CONFIRMATION_PREF, this.savedToolConfirmation, PreferenceScope.User);
            }
            this.log('[M5-LIVE] restored preferences (customOpenAiModels + toolConfirmation) to pre-run values');
        } catch (e) {
            this.log(`[M5-LIVE] restore preferences WARN: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // -------------------------------------------------------------------- helpers

    protected async scratchUri(name: string): Promise<URI> {
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir).resolve(`arschat/m5-live/${name}`);
    }

    protected async fileExists(uri: URI): Promise<boolean> {
        try {
            return await this.fileService.exists(uri);
        } catch {
            return false;
        }
    }

    protected async readRaw(uri: URI): Promise<string> {
        try {
            return (await this.fileService.read(uri)).value;
        } catch {
            return '';
        }
    }

    protected async deleteQuietly(uri: URI): Promise<void> {
        try {
            await this.fileService.delete(uri, { recursive: false, useTrash: false });
        } catch {
            /* best-effort */
        }
    }

    protected excerpt(s: string): string {
        const oneLine = s.replace(/\s+/g, ' ').trim();
        return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    protected withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
        return Promise.race([
            p,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
        ]);
    }
}
