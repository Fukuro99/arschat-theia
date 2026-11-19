import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { LanguageModel, LanguageModelResponse, LanguageModelStreamResponsePart, UserRequest } from '@theia/ai-core';
import { CLAUDE_LOGIN_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED, CLI_IMAGE_NOTICE, CLI_SETTINGS, CliAgentCheck, CliAgentKind, CliAgentService, CliAgentSettings, isCliAgent, normalizeCliSettings } from '../common/cli-agents';
import { cliTranscript, CliAgentDecoder, CliAgentOutputError } from './cli-agent-protocol';
import { destroyCliPipes, killCliTree, spawnCli } from './cli-agent-process';
import { cliEnvironment } from './cli-agent-env';
import { CliStreamRedactor } from './cli-agent-redactor';

type ClaudeAuth = 'subscription' | 'logged-out' | 'other-auth';

export function cliArguments(kind: CliAgentKind, s: CliAgentSettings): string[] {
    if (kind === 'codex-cli') {
        return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', s.codexSandbox,
            ...(s.codexModel ? ['-m', s.codexModel] : []), '-'];
    }
    if (kind === 'opencode-cli') {
        return ['run', '--format', 'json', '--thinking', '--agent', s.opencodeAgent,
            ...(s.opencodeModel ? ['-m', s.opencodeModel] : [])];
    }
    // Installed Claude 2.1.273 calls the ordinary permission mode "manual".
    return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', s.claudePermissionMode === 'default' ? 'manual' : s.claudePermissionMode,
        ...(s.claudeModel ? ['--model', s.claudeModel] : [])];
}

@injectable()
export class CliAgentServiceImpl implements CliAgentService {
    @inject(EnvVariablesServer) protected readonly envServer!: EnvVariablesServer;

    protected async workingDirectory(s: CliAgentSettings): Promise<string> {
        if (s.workingDirectory) { return s.workingDirectory; }
        try {
            const cwd = path.join(FileUri.fsPath(await this.envServer.getConfigDirUri()), 'arschat', 'cli-agents');
            await fs.mkdir(cwd, { recursive: true });
            return cwd;
        } catch { throw new Error('CLI の作業ディレクトリを準備できませんでした。'); }
    }

    protected claudeAuth(command: string, cwd: string): Promise<ClaudeAuth | undefined> {
        return new Promise(resolve => {
            try {
                const child = spawnCli(command, ['auth', 'status'], cliEnvironment('claude-code-cli', process.env), cwd);
                const pid = child.pid;
                let settled = false, bytes = 0;
                const chunks: Buffer[] = [];
                const finish = (auth?: ClaudeAuth): void => {
                    if (settled) { return; }
                    settled = true; clearTimeout(timer);
                    if (auth === undefined) { killCliTree(child, pid); }
                    destroyCliPipes(child);
                    chunks.length = 0;
                    resolve(auth);
                };
                const timer = setTimeout(() => finish(), 10000);
                child.stdout?.on('data', (chunk: Buffer) => {
                    if (settled) { return; }
                    bytes += chunk.length;
                    if (bytes > 64 * 1024) { finish(); return; }
                    chunks.push(chunk);
                });
                child.stdout?.on('error', () => finish());
                child.stderr?.on('error', () => finish());
                // Auth status can contain account details; never log either output stream.
                child.stderr?.resume();
                child.stdin?.on('error', () => finish());
                child.on('error', () => finish());
                // Wait for close so all stdout has arrived. Exit code 1 also means logged out.
                child.on('close', (_code, signal) => {
                    if (settled) { return; }
                    if (signal) { finish(); return; }
                    try {
                        const status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (status?.loggedIn === false) { finish('logged-out'); }
                        else if (status?.loggedIn === true) {
                            finish(status.authMethod === 'claude.ai' || status.authMethod === 'oauth_token' ? 'subscription' : 'other-auth');
                        } else { finish(); }
                    } catch { finish(); }
                });
                try { child.stdin?.end(); } catch { finish(); }
            } catch { resolve(undefined); }
        });
    }

    async check(kind: CliAgentKind, raw: CliAgentSettings): Promise<CliAgentCheck> {
        if (!isCliAgent(kind)) { return { available: false, message: '不明な CLI プロバイダです。' }; }
        const s = normalizeCliSettings(raw);
        if (kind === 'claude-code-cli') {
            const auth = await this.claudeAuth(s.claudeCommand, await this.workingDirectory(s));
            if (auth === 'subscription') { return { available: true, loggedIn: true }; }
            if (auth === 'logged-out') { return { available: false, loggedIn: false, message: CLAUDE_LOGIN_REQUIRED }; }
            if (auth === 'other-auth') { return { available: false, loggedIn: true, message: CLAUDE_SUBSCRIPTION_REQUIRED }; }
            return { available: false, message: 'CLI が見つからないか起動できません。インストール: npm i -g @anthropic-ai/claude-code' };
        }
        const available = await new Promise<boolean>(resolve => {
            try {
                const versionEnv = cliEnvironment(kind, process.env);
                const child = spawnCli(kind === 'codex-cli' ? s.codexCommand : s.opencodeCommand, ['--version'], versionEnv);
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
        return { available, message: available ? undefined
            : `CLI が見つからないか起動できません。インストール: npm i -g ${kind === 'opencode-cli' ? 'opencode-ai' : '@openai/codex'}` };
    }

    async listModels(kind: CliAgentKind, raw: CliAgentSettings): Promise<string[]> {
        if (kind !== 'opencode-cli') { return []; }
        const s = normalizeCliSettings(raw);
        try {
            const cwd = await this.workingDirectory(s);
            return await new Promise<string[]>(resolve => {
                const child = spawnCli(s.opencodeCommand, ['models'], cliEnvironment(kind, process.env), cwd);
                const pid = child.pid;
                let settled = false, bytes = 0;
                const chunks: Buffer[] = [];
                const finish = (models?: string[]): void => {
                    if (settled) { return; }
                    settled = true; clearTimeout(timer);
                    if (models === undefined) { killCliTree(child, pid); }
                    destroyCliPipes(child);
                    chunks.length = 0;
                    resolve(models ?? []);
                };
                const timer = setTimeout(() => finish(), 20000);
                child.stdout?.on('data', (chunk: Buffer) => {
                    if (settled) { return; }
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) { finish(); return; }
                    chunks.push(chunk);
                });
                child.stdout?.on('error', () => finish());
                child.stderr?.on('error', () => finish());
                child.stderr?.resume();
                child.stdin?.on('error', () => finish());
                child.on('error', () => finish());
                child.on('exit', (code, signal) => { if (code !== 0 || signal) { finish(); } });
                child.on('close', (code, signal) => {
                    if (settled) { return; }
                    if (code !== 0 || signal) { finish(); return; }
                    finish(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
                        .map(line => line.trim()).filter(line => /^[^\s/]+\/\S.*$/.test(line)));
                });
                try { child.stdin?.end(); } catch { finish(); }
            });
        } catch { return []; }
    }

    async request(kind: CliAgentKind, request: UserRequest, token?: CancellationToken): Promise<LanguageModelResponse> {
        token ??= request.cancellationToken;
        if (token?.isCancellationRequested) { return { text: '' }; }
        const s = normalizeCliSettings(request.settings?.[CLI_SETTINGS]);
        const env = cliEnvironment(kind, process.env);
        const cwd = await this.workingDirectory(s);
        if (token?.isCancellationRequested) { return { text: '' }; }
        if (kind === 'claude-code-cli') {
            const auth = await this.claudeAuth(s.claudeCommand, cwd);
            if (token?.isCancellationRequested) { return { text: '' }; }
            if (auth === 'logged-out') { return { text: CLAUDE_LOGIN_REQUIRED }; }
            if (auth === 'other-auth') { return { text: CLAUDE_SUBSCRIPTION_REQUIRED }; }
            if (auth === undefined) { throw new Error('CLI を起動できませんでした。実行ファイルと作業ディレクトリを確認してください。'); }
        }
        if (token?.isCancellationRequested) { return { text: '' }; }
        let child;
        try { child = spawnCli(kind === 'codex-cli' ? s.codexCommand : kind === 'opencode-cli' ? s.opencodeCommand : s.claudeCommand,
            cliArguments(kind, s), env, cwd); }
        catch { throw new Error('CLI を起動できませんでした。実行ファイルと作業ディレクトリを確認してください。'); }
        const processChild = child;
        const pid = child.pid;
        const decoder = new CliAgentDecoder(kind);
        const queue: LanguageModelStreamResponsePart[] = [];
        const secrets: string[] = [];
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
            decoder.close();
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
        this.name = this.vendor = id === 'codex-cli' ? 'Codex (CLI)' : id === 'opencode-cli' ? 'OpenCode (CLI)' : 'Claude Code (CLI)';
    }
    request(request: UserRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        return this.service.request(this.id, request, cancellationToken);
    }
}
