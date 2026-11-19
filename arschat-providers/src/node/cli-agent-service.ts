import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from '@theia/core';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { LanguageModel, LanguageModelResponse, LanguageModelStreamResponsePart, UserRequest } from '@theia/ai-core';
import { CLAUDE_KEY_REQUIRED, CLI_IMAGE_NOTICE, CLI_SETTINGS, CliAgentCheck, CliAgentKind, CliAgentService, CliAgentSettings, isCliAgent, normalizeCliSettings } from '../common/cli-agents';
import { cliTranscript, CliAgentDecoder, CliAgentOutputError } from './cli-agent-protocol';
import { destroyCliPipes, killCliTree, spawnCli } from './cli-agent-process';
import { cliEnvironment } from './cli-agent-env';
import { CliStreamRedactor } from './cli-agent-redactor';

export function cliArguments(kind: CliAgentKind, s: CliAgentSettings): string[] {
    if (kind === 'codex-cli') {
        return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', s.codexSandbox,
            ...(s.codexModel ? ['-m', s.codexModel] : []), '-'];
    }
    // Installed Claude 2.1.273 calls the ordinary permission mode "manual".
    // Bare mode explicitly prevents subscription/keychain authentication fallback.
    return ['--bare', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', s.claudePermissionMode === 'default' ? 'manual' : s.claudePermissionMode,
        ...(s.claudeModel ? ['--model', s.claudeModel] : [])];
}

@injectable()
export class CliAgentServiceImpl implements CliAgentService {
    @inject(KeyStoreService) protected readonly keys!: KeyStoreService;
    @inject(EnvVariablesServer) protected readonly envServer!: EnvVariablesServer;

    protected async apiKey(): Promise<string | undefined> {
        try {
            const key = await this.keys.getPassword('arschat', 'anthropic');
            if (key?.trim()) { return key; }
        } catch { /* The vault may be unavailable; never expose its error or secret. */ }
        return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
    }

    async check(kind: CliAgentKind, raw: CliAgentSettings): Promise<CliAgentCheck> {
        if (!isCliAgent(kind)) { return { available: false, message: '不明な CLI プロバイダです。' }; }
        const s = normalizeCliSettings(raw);
        const keyAvailable = kind === 'claude-code-cli' ? !!await this.apiKey() : undefined;
        // No Claude process at all without an API key, including --version.
        if (keyAvailable === false) { return { available: false, keyAvailable, message: CLAUDE_KEY_REQUIRED }; }
        const available = await new Promise<boolean>(resolve => {
            try {
                const versionEnv = cliEnvironment(kind, process.env);
                const child = spawnCli(kind === 'codex-cli' ? s.codexCommand : s.claudeCommand, ['--version'], versionEnv);
                const pid = child.pid;
                let settled = false;
                const finish = (ok: boolean): void => {
                    if (settled) { return; }
                    settled = true; clearTimeout(timer);
                    if (!ok) { killCliTree(child, pid); }
                    destroyCliPipes(child);
                    resolve(ok);
                };
                const timer = setTimeout(() => finish(false), 5000);
                child.stdout?.on('error', () => finish(false)); child.stderr?.on('error', () => finish(false));
                child.stdout?.resume(); child.stderr?.resume(); child.stdin?.on('error', () => finish(false));
                child.on('error', () => finish(false)); child.on('close', code => finish(code === 0));
                child.on('exit', (code, signal) => finish(code === 0 && !signal));
                try { child.stdin?.end(); } catch { finish(false); }
            } catch { resolve(false); }
        });
        return { available, keyAvailable, message: available ? undefined
            : `CLI が見つからないか起動できません。インストール: npm i -g ${kind === 'codex-cli' ? '@openai/codex' : '@anthropic-ai/claude-code'}` };
    }

    async request(kind: CliAgentKind, request: UserRequest, token?: CancellationToken): Promise<LanguageModelResponse> {
        token ??= request.cancellationToken;
        if (token?.isCancellationRequested) { return { text: '' }; }
        const s = normalizeCliSettings(request.settings?.[CLI_SETTINGS]);
        const env = cliEnvironment(kind, process.env);
        if (kind === 'claude-code-cli') {
            const key = await this.apiKey();
            if (!key) { return { text: CLAUDE_KEY_REQUIRED }; }
            env.ANTHROPIC_API_KEY = key;
        }
        let cwd = s.workingDirectory;
        try {
            if (!cwd) {
                cwd = path.join(FileUri.fsPath(await this.envServer.getConfigDirUri()), 'arschat', 'cli-agents');
                await fs.mkdir(cwd, { recursive: true });
            }
        } catch { throw new Error('CLI の作業ディレクトリを準備できませんでした。'); }
        if (token?.isCancellationRequested) { return { text: '' }; }
        let child;
        try { child = spawnCli(kind === 'codex-cli' ? s.codexCommand : s.claudeCommand, cliArguments(kind, s), env, cwd); }
        catch { throw new Error('CLI を起動できませんでした。実行ファイルと作業ディレクトリを確認してください。'); }
        const processChild = child;
        const pid = child.pid;
        const decoder = new CliAgentDecoder(kind);
        const queue: LanguageModelStreamResponsePart[] = [];
        const secrets = [env.ANTHROPIC_API_KEY].filter((v): v is string => !!v);
        const textRedactor = new CliStreamRedactor(secrets), thoughtRedactor = new CliStreamRedactor(secrets);
        const enqueue = (part: LanguageModelStreamResponsePart): void => {
            if ('content' in part) {
                const content = textRedactor.push(part.content);
                if (content) { queue.push({ content }); }
            } else if ('thought' in part) {
                const thought = thoughtRedactor.push(part.thought);
                if (thought) { queue.push({ thought, signature: '' }); }
            } else { queue.push(part); }
        };
        if (request.messages.some(m => m.type === 'image')) { queue.push({ content: `${CLI_IMAGE_NOTICE}\n\n` }); }
        let pending = '', ended = false, failure: Error | undefined;
        const waiters: (() => void)[] = [];
        const wake = (): void => { for (const resolve of waiters.splice(0)) { resolve(); } };
        let subscription: { dispose(): void } | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, kill = false, flush = false): void => {
            if (ended) { return; }
            ended = true; failure = error;
            if (timer) { clearTimeout(timer); }
            subscription?.dispose();
            if (kill) { killCliTree(processChild, pid); }
            destroyCliPipes(processChild);
            if (flush) {
                const content = textRedactor.push('', true), thought = thoughtRedactor.push('', true);
                if (content) { queue.push({ content }); }
                if (thought) { queue.push({ thought, signature: '' }); }
            }
            wake();
        };
        const line = (value: string): void => {
            if (ended) { return; }
            try {
                for (const part of decoder.decode(value)) {
                    enqueue(part);
                }
                wake();
                if (decoder.done) { finish(undefined, true, true); }
            } catch (error) {
                finish(error instanceof CliAgentOutputError ? error
                    : new Error('CLI がエラーを返しました。認証・接続・利用枠を確認してください。'), true);
            }
        };
        processChild.stdout?.setEncoding('utf8');
        processChild.stdout?.on('error', () => finish(new Error('CLI の出力を読み取れませんでした。'), true));
        processChild.stderr?.on('error', () => finish(new Error('CLI の出力を読み取れませんでした。'), true));
        processChild.stdout?.on('data', (chunk: string) => {
            if (ended) { return; }
            pending += chunk;
            let end: number;
            while (!ended && (end = pending.indexOf('\n')) >= 0) {
                const next = pending.slice(0, end); pending = pending.slice(end + 1); line(next);
            }
            if (pending.length > 8 * 1024 * 1024) { finish(new Error('CLI の出力行が長すぎます。'), true); }
        });
        // Drain, but never log stderr: it can contain credentials or echoed prompts.
        processChild.stderr?.resume();
        processChild.on('error', () => finish(new Error('CLI を起動できませんでした。'), true));
        processChild.stdin?.on('error', () => finish(new Error('CLI に入力を送信できませんでした。'), true));
        processChild.on('exit', (code, signal) => {
            // Do not wait for close: descendants may still be holding stdout/stderr open.
            if (code !== 0 || signal) { finish(new Error('CLI が正常な完了通知なしで終了しました。'), true); }
        });
        processChild.on('close', (code, signal) => {
            if (code !== 0 || signal) { finish(new Error('CLI が正常な完了通知なしで終了しました。'), true); return; }
            if (pending) { line(pending); pending = ''; }
            finish(decoder.done ? undefined : new Error('CLI が正常な完了通知なしで終了しました。'), !decoder.done, decoder.done);
        });
        timer = setTimeout(() => finish(new Error('CLI のリクエストがタイムアウトしました。'), true), s.timeoutMinutes * 60000);
        subscription = token?.onCancellationRequested(() => finish(undefined, true));
        if (token?.isCancellationRequested) { finish(undefined, true); }
        if (!ended) {
            try { processChild.stdin?.end(cliTranscript(request.messages), 'utf8'); }
            catch { finish(new Error('CLI に入力を送信できませんでした。'), true); }
        }
        let returned = false;
        const stream: AsyncIterableIterator<LanguageModelStreamResponsePart> = {
            [Symbol.asyncIterator]() { return this; },
            async next() {
                while (true) {
                    if (returned) { return { done: true, value: undefined }; }
                    if (queue.length) { return { done: false, value: queue.shift()! }; }
                    if (ended) { if (failure) { throw failure; } return { done: true, value: undefined }; }
                    await new Promise<void>(resolve => { waiters.push(resolve); });
                }
            },
            async return() {
                returned = true; queue.length = 0;
                finish(undefined, true); wake();
                return { done: true, value: undefined };
            }
        };
        return { stream };
    }
}

export class CliAgentLanguageModel implements LanguageModel {
    readonly status = { status: 'ready' as const };
    readonly name: string;
    readonly vendor: string;
    constructor(readonly id: CliAgentKind, private readonly service: CliAgentServiceImpl) {
        this.name = this.vendor = id === 'codex-cli' ? 'Codex (CLI)' : 'Claude Code (CLI)';
    }
    request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        return this.service.request(this.id, request, cancellationToken);
    }
}
