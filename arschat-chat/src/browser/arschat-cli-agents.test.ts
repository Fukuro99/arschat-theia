/** @jest-environment node */
import 'reflect-metadata';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { promises as fs, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CancellationTokenSource, PreferenceScope } from '@theia/core';
import { LanguageModelResponse, LanguageModelStreamResponsePart, UserRequest } from '@theia/ai-core';
import { CliAgentServiceImpl, cliArguments } from 'arschat-providers/lib/node/cli-agent-service';
import { CliAgentDecoder, cliTranscript } from 'arschat-providers/lib/node/cli-agent-protocol';
import { cliExecutable, killCliTree, spawnCli } from 'arschat-providers/lib/node/cli-agent-process';
import { cliEnvironment } from 'arschat-providers/lib/node/cli-agent-env';
import { CliStreamRedactor } from 'arschat-providers/lib/node/cli-agent-redactor';
import { CLAUDE_LOGIN_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED, CLI_DEFAULTS, CLI_IMAGE_NOTICE, CLI_SETTINGS, normalizeCliSettings } from 'arschat-providers/lib/common/cli-agents';
import { PROVIDERS, customEndpointProviders } from 'arschat-providers/lib/browser/arschat-provider-preferences';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { CliAgentAutotestContribution } from 'arschat-providers/lib/browser/cli-agent-autotest-contribution';
import { cliAgentPreferenceSchema } from 'arschat-providers/lib/browser/cli-agent-preferences';

const mockedSpawn = spawn as jest.Mock;
class FakeChild extends EventEmitter {
    pid = 987654;
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = Object.assign(new EventEmitter(), { end: jest.fn(), destroy: jest.fn() });
    kill = jest.fn();
    json(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n'); }
}
function request(settings = {}): UserRequest {
    return { sessionId: 's', requestId: 'r', messages: [{ type: 'text', actor: 'user', text: '日本語 " & echo secret' }],
        settings: { [CLI_SETTINGS]: { ...CLI_DEFAULTS, codexCommand: process.execPath, claudeCommand: process.execPath,
            opencodeCommand: process.execPath, workingDirectory: process.cwd(), ...settings } } };
}
async function collect(response: LanguageModelResponse): Promise<LanguageModelStreamResponsePart[]> {
    if (!('stream' in response)) { return [{ content: 'text' in response ? response.text : response.content }]; }
    const parts: LanguageModelStreamResponsePart[] = [];
    for await (const part of response.stream) { parts.push(part); }
    return parts;
}
describe('CLI backend (synthetic child_process.spawn only)', () => {
    let service: CliAgentServiceImpl;
    let child: FakeChild;
    let getPassword: jest.Mock;
    let savedEnv: NodeJS.ProcessEnv;
    beforeEach(() => {
        jest.useFakeTimers();
        savedEnv = process.env;
        process.env = { ...savedEnv };
        delete process.env.ANTHROPIC_API_KEY;
        child = new FakeChild();
        mockedSpawn.mockReset().mockImplementation((command: string, args: string[]) => {
            if (/taskkill\.exe$/i.test(command)) { return new FakeChild(); }
            if (args[0] === 'auth') {
                const auth = new FakeChild();
                void Promise.resolve().then(() => { auth.json({ loggedIn: true, authMethod: 'claude.ai' }); auth.emit('close', 0); });
                return auth;
            }
            return child;
        });
        jest.spyOn(process, 'kill').mockImplementation(() => true);
        getPassword = jest.fn(async () => 'vault-key');
        service = new CliAgentServiceImpl();
        Object.assign(service, { keys: { getPassword }, envServer: { getConfigDirUri: jest.fn() } });
    });
    afterEach(() => {
        process.env = savedEnv; jest.useRealTimers(); jest.restoreAllMocks();
        expect(getPassword).not.toHaveBeenCalled();
    });

    const opencodeFixtures = [
        { name: 'PONG', text: 'PONG', events: [
            { type: 'step_start', part: { type: 'step-start' } },
            { type: 'text', part: { id: 'pong', type: 'text', text: 'PONG' } },
            { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }
        ] },
        { name: 'tool followed by text', text: '確認します\n\n東京', events: [
            { type: 'step_start', part: { type: 'step-start' } },
            { type: 'text', part: { id: 'before', type: 'text', text: '確認します' } },
            { type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'completed', title: 'ls' } } },
            { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } },
            { type: 'step_start', part: { type: 'step-start' } },
            { type: 'text', part: { id: 'after', type: 'text', text: '東京' } },
            { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }
        ] },
        { name: 'plan permission rejection', text: '', events: [
            { type: 'step_start', part: { type: 'step-start' } },
            { type: 'tool_use', part: { type: 'tool', tool: 'write', state: { status: 'error', error: 'The user rejected permission' } } },
            { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } }
        ] }
    ];
    it.each(opencodeFixtures)('waits for close without killing OpenCode: $name', async fixture => {
        const output = collect(await service.request('opencode-cli', request()));
        const decoder = new CliAgentDecoder('opencode-cli');
        for (const event of fixture.events) {
            decoder.decode(JSON.stringify(event));
            child.json(event);
            expect(decoder.done).toBe(false);
            expect(mockedSpawn).toHaveBeenCalledTimes(1);
            expect(process.kill).not.toHaveBeenCalled();
            expect(child.stdout.destroyed).toBe(false);
        }
        child.emit('exit', 0, null);
        expect(child.stdout.destroyed).toBe(false);
        child.emit('close', 0, null);
        decoder.close();
        expect(decoder.done).toBe(true);
        expect((await output).map(p => 'content' in p ? p.content : '').join('')).toBe(fixture.text);
        expect(mockedSpawn).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        expect(child.stdin.destroy).toHaveBeenCalled();
    });
    it('decodes the final OpenCode line without a newline on close', async () => {
        const output = collect(await service.request('opencode-cli', request()));
        child.json({ type: 'text', part: { id: 'a', text: 'PONG' } });
        child.stdout.write('{"type":"step_finish","part":{"reason":"stop"}}');
        child.emit('close', 0, null);
        expect(await output).toEqual([{ content: 'PONG' }]);
    });
    it.each(['missing-step', 'error', 'broken-json', 'nonzero', 'signal'])('rejects OpenCode failure: %s', async failure => {
        const output = collect(await service.request('opencode-cli', request()));
        if (failure !== 'missing-step') { child.json({ type: 'step_finish' }); }
        if (failure === 'error') { child.json({ type: 'error', error: { data: { message: 'private-secret' } } }); }
        if (failure === 'broken-json') { child.stdout.write('broken-json\n'); }
        child.emit('close', failure === 'nonzero' ? 1 : 0, failure === 'signal' ? 'SIGTERM' : null);
        await expect(output).rejects.toThrow(failure === 'error'
            ? 'OpenCode がエラーを返しました。モデル名・接続先・認証を確認してください。'
            : failure === 'broken-json' ? 'CLI の出力を解釈できませんでした' : 'CLI が正常な完了通知なしで終了しました。');
        expect(child.stdout.destroyed).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });
    const modelSettings = { ...CLI_DEFAULTS, opencodeCommand: process.execPath, workingDirectory: process.cwd() };
    it('lists trimmed OpenCode models and drops noise, using the resolved cwd and filtered environment', async () => {
        const result = service.listModels('opencode-cli', modelSettings);
        await Promise.resolve();
        const bytes = Buffer.from('  edgexpert/qwen3.8-flash-next\r\n\nnoise\nprovider/\n/invalid\nbad provider/model\n 日本語/モデル \n');
        child.stdout.write(bytes.subarray(0, bytes.length - 4));
        child.stdout.write(bytes.subarray(bytes.length - 4));
        child.stderr.write('secret');
        child.emit('close', 0, null);
        expect(await result).toEqual(['edgexpert/qwen3.8-flash-next', '日本語/モデル']);
        expect(mockedSpawn.mock.calls[0]).toEqual([process.execPath, ['models'], expect.objectContaining({
            cwd: process.cwd(), env: cliEnvironment('opencode-cli', process.env)
        })]);
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stdin.destroy).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
    it.each(['timeout', 'spawn-error', 'throw', 'overflow', 'exit', 'signal', 'stdout-error', 'stdin-error', 'stderr-error'])(
        'returns no models and cleans up on %s', async failure => {
            if (failure === 'throw') { mockedSpawn.mockImplementationOnce(() => { throw new Error('private'); }); }
            const result = service.listModels('opencode-cli', modelSettings);
            await Promise.resolve();
            if (failure === 'timeout') { jest.advanceTimersByTime(20000); }
            if (failure === 'spawn-error') { child.emit('error', new Error('private')); }
            if (failure === 'overflow') { child.stdout.write(Buffer.alloc(1024 * 1024 + 1)); }
            if (failure === 'exit') { child.emit('exit', 1, null); }
            if (failure === 'signal') { child.emit('close', 0, 'SIGTERM'); }
            if (failure === 'stdout-error') { child.stdout.emit('error', new Error('private')); }
            if (failure === 'stdin-error') { child.stdin.emit('error', new Error('private')); }
            if (failure === 'stderr-error') { child.stderr.emit('error', new Error('private')); }
            expect(await result).toEqual([]);
            if (failure !== 'throw') {
                expect(child.stdout.destroyed).toBe(true);
                expect(child.stdin.destroy).toHaveBeenCalled();
            }
            expect(jest.getTimerCount()).toBe(0);
        });
    it('does not spawn model discovery for Codex or Claude', async () => {
        expect(await service.listModels('codex-cli', CLI_DEFAULTS)).toEqual([]);
        expect(await service.listModels('claude-code-cli', CLI_DEFAULTS)).toEqual([]);
        expect(mockedSpawn).not.toHaveBeenCalled();
    });
    it('resolves the shared default working directory for OpenCode model discovery', async () => {
        const cwd = jest.spyOn(service as any, 'workingDirectory').mockResolvedValue(process.cwd());
        const result = service.listModels('opencode-cli', { ...modelSettings, workingDirectory: '' });
        await Promise.resolve();
        child.emit('close', 0, null);
        expect(await result).toEqual([]);
        expect(cwd).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: '' }));
        expect(mockedSpawn.mock.calls[0][2].cwd).toBe(process.cwd());
    });
    it.each([0, 1])('checks OpenCode with --version (exit %s)', async code => {
        const result = service.check('opencode-cli', modelSettings);
        child.emit('close', code, null);
        expect(await result).toEqual({ available: code === 0, message: code === 0 ? undefined
            : 'CLI が見つからないか起動できません。インストール: npm i -g opencode-ai' });
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['--version']);
    });

    it('streams codex text, thinking and operation names while excluding command output and patches', async () => {
        const output = collect(await service.request('codex-cli', request()));
        child.json({ type: 'item.completed', item: { type: 'reasoning', text: '考え' } });
        child.json({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'PRIVATE OUTPUT' } });
        child.json({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts', diff: 'PRIVATE PATCH' }] } });
        child.stdout.write('{"type":"item.completed","item":{"type":"agent_');
        child.stdout.write('message","text":"東京"}}\n');
        child.json({ type: 'turn.completed' });
        expect(await output).toEqual([{ thought: '考え', signature: '' }, { content: '\nCodex が実行した操作: ls\n' },
            { content: '\nCodex が実行した操作: a.ts\n' }, { content: '東京' }]);
        const [, args, options] = mockedSpawn.mock.calls[0];
        expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-']);
        expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: process.cwd() });
        expect(child.stdin.end).toHaveBeenCalledWith('ユーザー: 日本語 " & echo secret', 'utf8');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('streams Claude partial messages once and handles thinking', async () => {
        const output = collect(await service.request('claude-code-cli', request()));
        child.json({ type: 'system' });
        child.json({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '考え' } } });
        child.json({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'PONG' } } });
        child.json({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '考え' }, { type: 'text', text: 'PONG' }] } });
        child.json({ type: 'user' });
        child.json({ type: 'result', is_error: false, result: 'PONG' });
        expect(await output).toEqual([{ thought: '考え', signature: '' }, { content: 'PONG' }]);
    });

    it.each(['codex-cli', 'claude-code-cli'] as const)('stops %s immediately on a broken JSON line', async kind => {
        const response = await service.request(kind, request());
        if (!('stream' in response)) { throw new Error('Expected a stream'); }
        const iterator = response.stream[Symbol.asyncIterator]();
        const assertion = expect(iterator.next()).rejects.toThrow('CLI の出力を解釈できませんでした');
        // A later valid snapshot/completion in the same chunk must never recover this request.
        const completion = kind === 'codex-cli' ? { type: 'turn.completed' } : { type: 'result', result: 'recovered' };
        child.stdout.write(' \r\n\n{broken vault-key}\n' + JSON.stringify(completion) + '\n');
        expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        if (process.platform === 'win32') {
            expect(mockedSpawn.mock.calls[kind === 'claude-code-cli' ? 2 : 1][1]).toEqual(['/T', '/F', '/PID', '987654']);
        } else { expect(process.kill).toHaveBeenCalledWith(-987654, 'SIGKILL'); }
        expect(jest.getTimerCount()).toBe(0);
        await assertion;
    });

    it.each(['codex-cli', 'claude-code-cli'] as const)('rejects a broken final line without a newline for %s', async kind => {
        const output = collect(await service.request(kind, request()));
        const assertion = expect(output).rejects.toThrow('CLI の出力を解釈できませんでした');
        child.stdout.write('{broken');
        expect(child.stdout.destroyed).toBe(false);
        child.emit('close', 0);
        await assertion;
        expect(child.stdout.destroyed).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('stops Claude when its complete text cannot extend the accumulated deltas', async () => {
        const output = collect(await service.request('claude-code-cli', request()));
        const assertion = expect(output).rejects.toThrow('CLI がエラー');
        child.json({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'helworld' } } });
        child.json({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } });
        await assertion;
        expect(child.stdout.destroyed).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });

    it.each([false, true])('completes Claude text/tool/text blocks without losing or repeating text (new message: %s)', async newMessage => {
        const output = collect(await service.request('claude-code-cli', request()));
        const event = (value: unknown): void => child.json({ type: 'stream_event', event: value });
        const assistant = (id: string, content: unknown): void => child.json({ type: 'assistant', message: { id, content: [content] } });
        event({ type: 'message_start', message: { id: 'a' } });
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '調べます。' } });
        assistant('a', { type: 'text', text: '調べます。' });
        event({ type: 'content_block_stop', index: 0 });
        event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool', name: 'Read', input: {} } });
        event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"README.md"}' } });
        assistant('a', { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'README.md' } });
        event({ type: 'content_block_stop', index: 1 });
        if (newMessage) {
            event({ type: 'message_stop' });
            child.json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'file contents' }] } });
            event({ type: 'message_start', message: { id: 'b' } });
        }
        const index = newMessage ? 0 : 2;
        event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: '回答' } });
        assistant(newMessage ? 'b' : 'a', { type: 'text', text: '回答です。' });
        event({ type: 'content_block_stop', index });
        event({ type: 'message_stop' });
        expect(child.stdout.destroyed).toBe(false);
        expect(mockedSpawn).toHaveBeenCalledTimes(2);
        child.json({ type: 'result', result: '回答です。' });
        expect(await output).toEqual([{ content: '調べます。' }, { content: '回答' }, { content: 'です。' }]);
        expect(jest.getTimerCount()).toBe(0);
    });

    it.each(['error', 'turn.failed'])('rejects codex %s without leaking the raw error', async type => {
        const output = collect(await service.request('codex-cli', request()));
        const assertion = expect(output).rejects.toThrow('CLI がエラー');
        child.json({ type, message: 'private-key', error: { message: 'private-key' } });
        await assertion;
    });
    it('rejects Claude result is_error without returning sensitive result text', async () => {
        const output = collect(await service.request('claude-code-cli', request()));
        const assertion = expect(output).rejects.toThrow('CLI がエラー');
        child.json({ type: 'result', is_error: true, result: 'vault-key' });
        await assertion;
    });
    it('checks saved login before prompting, ignores all API keys and tokens, and drains stderr without logging', async () => {
        process.env.ANTHROPIC_API_KEY = 'env-key';
        process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
        process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const output = collect(await service.request('claude-code-cli', request()));
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['auth', 'status']);
        const [command, args, options] = mockedSpawn.mock.calls[1];
        expect(getPassword).not.toHaveBeenCalled();
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(options.env.CLAUDE_CONFIG_DIR).toBe('/custom/claude');
        expect(mockedSpawn.mock.calls[0][2].env).toEqual(options.env);
        expect(JSON.stringify([command, args, child.stdin.end.mock.calls])).not.toContain('vault-key');
        expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan']);
        child.stderr.write('vault-key auth-token oauth-token');
        child.json({ type: 'result', result: 'PONG' });
        await output;
        expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
        expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('auth-token');
    });
    it('returns login instructions without prompting when auth status is false (exit 1)', async () => {
        mockedSpawn.mockReturnValueOnce(child);
        const result = service.request('claude-code-cli', request());
        await Promise.resolve();
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['auth', 'status']);
        child.json({ loggedIn: false }); child.emit('exit', 1); child.emit('close', 1);
        expect(await result).toEqual({ text: CLAUDE_LOGIN_REQUIRED });
        expect(mockedSpawn).toHaveBeenCalledTimes(1);
        expect(getPassword).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
    describe.each(['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party', 'unknown', undefined, null, 42])
    ('Claude authMethod=%s', authMethod => {
        it.each([true, false])('checks and gates prompting with loggedIn=%s', async loggedIn => {
            const subscription = loggedIn && (authMethod === 'claude.ai' || authMethod === 'oauth_token');
            const message = loggedIn ? CLAUDE_SUBSCRIPTION_REQUIRED : CLAUDE_LOGIN_REQUIRED;
            const authChildren: FakeChild[] = [];
            mockedSpawn.mockImplementation((command: string, args: string[]) => {
                if (/taskkill\.exe$/i.test(command)) { return new FakeChild(); }
                if (args[0] === 'auth') {
                    const auth = new FakeChild();
                    authChildren.push(auth);
                    void Promise.resolve().then(() => {
                        auth.json({ loggedIn, authMethod, email: 'private@example.test' });
                        auth.emit('close', loggedIn ? 0 : 1);
                    });
                    return auth;
                }
                return child;
            });
            const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
            const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const settings = { ...CLI_DEFAULTS, claudeCommand: process.execPath, workingDirectory: process.cwd() };
            expect(await service.check('claude-code-cli', settings)).toEqual(subscription
                ? { available: true, loggedIn: true } : { available: false, loggedIn, message });
            const response = await service.request('claude-code-cli', request());
            expect(mockedSpawn.mock.calls.map(call => call[1][0])).toEqual(subscription ? ['auth', 'auth', '-p'] : ['auth', 'auth']);
            if (subscription) {
                child.json({ type: 'result', result: 'PONG' });
                expect(await collect(response)).toEqual([{ content: 'PONG' }]);
            } else { expect(response).toEqual({ text: message }); }
            for (const auth of authChildren) {
                expect(auth.stdout.destroyed).toBe(true); expect(auth.stderr.destroyed).toBe(true);
            }
            expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    it.each([false, true])('uses the same cwd for check, request auth and prompting (default: %s)', async useDefault => {
        const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
        const configUri = FileUri.create(path.join(process.cwd(), 'config')).toString();
        const getConfigDirUri = jest.fn(async () => configUri);
        Object.assign(service, { envServer: { getConfigDirUri } });
        const workingDirectory = useDefault ? '' : path.join(process.cwd(), 'project');
        const cwd = useDefault ? path.join(FileUri.fsPath(configUri), 'arschat', 'cli-agents') : workingDirectory;
        const settings = { ...CLI_DEFAULTS, claudeCommand: process.execPath, workingDirectory };
        expect(await service.check('claude-code-cli', settings)).toEqual({ available: true, loggedIn: true });
        const response = await service.request('claude-code-cli', request({ workingDirectory }));
        expect(mockedSpawn.mock.calls.map(call => [call[1][0], call[2].cwd])).toEqual([
            ['auth', cwd], ['auth', cwd], ['-p', cwd]
        ]);
        if (useDefault) {
            expect(getConfigDirUri).toHaveBeenCalledTimes(2);
            expect(mkdir).toHaveBeenCalledTimes(2);
            expect(mkdir).toHaveBeenCalledWith(cwd, { recursive: true });
            expect(mkdir.mock.invocationCallOrder[0]).toBeLessThan(mockedSpawn.mock.invocationCallOrder[0]);
            expect(mkdir.mock.invocationCallOrder[1]).toBeLessThan(mockedSpawn.mock.invocationCallOrder[1]);
        } else {
            expect(getConfigDirUri).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
        }
        child.json({ type: 'result', result: 'PONG' }); await collect(response);
        expect(jest.getTimerCount()).toBe(0);
    });

    describe.each(['check', 'request'] as const)('%s working directory preparation', operation => {
        it.each(['config', 'mkdir'])('preserves the sanitized error on %s failure without spawning', async failure => {
            jest.spyOn(fs, 'mkdir').mockRejectedValue(new Error('private path'));
            Object.assign(service, { envServer: { getConfigDirUri: async () => {
                if (failure === 'config') { throw new Error('private path'); }
                return FileUri.create(process.cwd()).toString();
            } } });
            const result = operation === 'check' ? service.check('claude-code-cli', CLI_DEFAULTS)
                : service.request('claude-code-cli', request({ workingDirectory: '' }));
            await expect(result).rejects.toThrow('CLI の作業ディレクトリを準備できませんでした。');
            expect(mockedSpawn).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });
    });
    it.each([true, false])('preflights Claude using loggedIn=%s without exposing account details', async loggedIn => {
        mockedSpawn.mockReturnValueOnce(child);
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const check = service.check('claude-code-cli', { ...CLI_DEFAULTS, claudeCommand: process.execPath, workingDirectory: process.cwd() });
        await Promise.resolve();
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['auth', 'status']);
        const payload = Buffer.from(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: 'private@example.test', organization: '秘密の組織' }));
        child.stdout.write(payload.subarray(0, payload.length - 5));
        child.emit('exit', loggedIn ? 0 : 1);
        child.stdout.write(payload.subarray(payload.length - 5));
        child.stderr.write('private@example.test'); child.emit('close', loggedIn ? 0 : 1);
        expect(await check).toEqual(loggedIn ? { available: true, loggedIn: true }
            : { available: false, loggedIn: false, message: CLAUDE_LOGIN_REQUIRED });
        expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
        expect(getPassword).not.toHaveBeenCalled();
        expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });
    it.each(['non-json', 'missing', 'string', 'null', 'timeout', 'error', 'throw', 'stdout', 'stderr', 'stdin', 'oversized'])
    ('reports unavailable Claude for auth status %s and cleans up without leaking output', async failure => {
        mockedSpawn.mockImplementationOnce(() => {
            if (failure === 'throw') { throw new Error('private@example.test'); }
            return child;
        });
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const check = service.check('claude-code-cli', { ...CLI_DEFAULTS, claudeCommand: process.execPath, workingDirectory: process.cwd() });
        await Promise.resolve();
        if (failure === 'timeout') { child.emit('exit', 0); jest.advanceTimersByTime(10000); }
        else if (failure === 'error') { child.emit('error', new Error('private@example.test')); }
        else if (failure === 'stdout' || failure === 'stderr' || failure === 'stdin') {
            (child[failure] as EventEmitter).emit('error', new Error('private@example.test'));
        } else if (failure === 'oversized') { child.stdout.write(Buffer.alloc(64 * 1024 + 1, 'a')); }
        else if (failure !== 'throw') {
            child.stdout.write(failure === 'non-json' ? 'private@example.test'
                : failure === 'null' ? 'null' : JSON.stringify({ email: 'private@example.test', loggedIn: failure === 'string' ? 'true' : undefined }));
            child.emit('close', 0);
        }
        expect(await check).toEqual({ available: false, message: 'CLI が見つからないか起動できません。インストール: npm i -g @anthropic-ai/claude-code' });
        expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
        expect(getPassword).not.toHaveBeenCalled();
        if (failure !== 'throw') {
            expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
            expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
            if (process.platform === 'win32') { expect(mockedSpawn.mock.calls[1][1]).toEqual(['/T', '/F', '/PID', '987654']); }
            else { expect(process.kill).toHaveBeenCalledWith(-987654, 'SIGKILL'); }
        }
        expect(jest.getTimerCount()).toBe(0);
    });
    it.each([0, 1])('bounds auth stdout in bytes at 64KB (extra bytes: %s)', async extra => {
        mockedSpawn.mockReturnValueOnce(child);
        const check = service.check('claude-code-cli', { ...CLI_DEFAULTS, claudeCommand: process.execPath, workingDirectory: process.cwd() });
        await Promise.resolve();
        const payload = Buffer.from(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', organization: '組織' }));
        child.stdout.write(payload);
        child.stdout.write(Buffer.alloc(64 * 1024 - payload.length + extra, ' '));
        child.emit('close', 0);
        expect(await check).toMatchObject(extra ? { available: false, message: expect.stringContaining('インストール') }
            : { available: true, loggedIn: true });
        expect(jest.getTimerCount()).toBe(0);
    });
    it('rejects an unavailable auth status before prompting with a sanitized error', async () => {
        mockedSpawn.mockReturnValueOnce(child);
        const result = service.request('claude-code-cli', request());
        const assertion = expect(result).rejects.toThrow('CLI を起動できませんでした。実行ファイルと作業ディレクトリを確認してください。');
        await Promise.resolve();
        child.stdout.write('private@example.test'); child.emit('close', 0);
        await assertion;
        expect(mockedSpawn.mock.calls.some(call => call[1].includes('-p'))).toBe(false);
    });
    it.each([true, false, undefined])('does not prompt after cancellation while auth status resolves to %s', async loggedIn => {
        mockedSpawn.mockReturnValueOnce(child);
        const token = new CancellationTokenSource();
        const result = service.request('claude-code-cli', request(), token.token);
        await Promise.resolve();
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['auth', 'status']);
        token.cancel(); child.json({ loggedIn, authMethod: 'claude.ai' }); child.emit('close', 0);
        expect(await result).toEqual({ text: '' });
        expect(mockedSpawn.mock.calls.some(call => call[1].includes('-p'))).toBe(false);
        expect(jest.getTimerCount()).toBe(0); token.dispose();
    });
    it('preflights with --version and reports missing CLI installation', async () => {
        const check = service.check('codex-cli', { ...CLI_DEFAULTS, codexCommand: process.execPath });
        expect(mockedSpawn.mock.calls[0][1]).toEqual(['--version']);
        child.emit('error', new Error('private error'));
        expect(await check).toMatchObject({ available: false, message: expect.stringContaining('npm i -g @openai/codex') });
        expect(jest.getTimerCount()).toBe(0);
    });
    it('preflight success and timeout both clean timers', async () => {
        const check = service.check('codex-cli', { ...CLI_DEFAULTS, codexCommand: process.execPath });
        child.emit('close', 0);
        expect(await check).toMatchObject({ available: true });
        const timeout = service.check('codex-cli', { ...CLI_DEFAULTS, codexCommand: process.execPath });
        jest.advanceTimersByTime(5000);
        expect(await timeout).toMatchObject({ available: false });
        expect(jest.getTimerCount()).toBe(0);
    });
    it('cancels and kills the child tree, including Windows taskkill', async () => {
        const token = new CancellationTokenSource();
        const output = collect(await service.request('codex-cli', request(), token.token));
        token.cancel();
        await jest.advanceTimersByTimeAsync(0);
        expect(await output).toEqual([]);
        if (process.platform === 'win32') {
            expect(mockedSpawn).toHaveBeenCalledWith(path.win32.join((process.env.SystemRoot || process.env.SYSTEMROOT)!, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], expect.objectContaining({ windowsHide: true, shell: false }));
        } else { expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL'); }
        expect(jest.getTimerCount()).toBe(0);
        token.dispose();
    });
    it.each(['codex-cli', 'claude-code-cli'] as const)('does not spawn %s for a pre-cancelled request', async kind => {
        const token = new CancellationTokenSource(); token.cancel();
        expect(await service.request(kind, request(), token.token)).toEqual({ text: '' });
        expect(mockedSpawn).not.toHaveBeenCalled(); token.dispose();
    });
    it('times out and releases the stream', async () => {
        const output = collect(await service.request('codex-cli', request({ timeoutMinutes: 0.01 })));
        const assertion = expect(output).rejects.toThrow('タイムアウト');
        jest.advanceTimersByTime(600);
        await assertion; expect(jest.getTimerCount()).toBe(0);
    });
    it.each(['spawn', 'stdin', 'exit'])('sanitizes %s errors', async source => {
        const output = collect(await service.request('codex-cli', request()));
        const assertion = expect(output).rejects.not.toThrow('sensitive');
        if (source === 'spawn') { child.emit('error', new Error('sensitive')); }
        if (source === 'stdin') { child.stdin.emit('error', new Error('sensitive')); }
        if (source === 'exit') { child.emit('close', 1); }
        await assertion;
    });
    it('flushes the final JSONL line without a newline', async () => {
        const output = collect(await service.request('codex-cli', request()));
        child.stdout.write('{"type":"turn.completed"}'); child.emit('close', 0);
        expect(await output).toEqual([]);
    });
    it('adds a visible image notice and does not pass image data', async () => {
        const r = request(); r.messages.push({ actor: 'user', type: 'image', image: { base64data: 'IMAGE_DATA', mimeType: 'image/png' } });
        const output = collect(await service.request('codex-cli', r));
        child.json({ type: 'turn.completed' });
        expect(await output).toEqual([{ content: `${CLI_IMAGE_NOTICE}\n\n` }]);
        expect(child.stdin.end.mock.calls[0][0]).not.toContain('IMAGE_DATA');
    });
    it('uses and creates the config fallback directory only when no directory was supplied', async () => {
        const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
        const configUri = FileUri.create(process.cwd()).toString();
        Object.assign(service, { envServer: { getConfigDirUri: async () => configUri } });
        const output = collect(await service.request('codex-cli', request({ workingDirectory: '' })));
        const cwd = path.join(FileUri.fsPath(configUri), 'arschat', 'cli-agents');
        expect(mkdir).toHaveBeenCalledWith(cwd, { recursive: true });
        expect(mockedSpawn.mock.calls[0][2].cwd).toBe(cwd);
        child.json({ type: 'turn.completed' }); await output;
    });
    it('kills an abandoned stream and cleans its timer', async () => {
        const response = await service.request('codex-cli', request());
        if (!('stream' in response)) { throw new Error('Expected stream'); }
        const iterator = response.stream[Symbol.asyncIterator]();
        child.json({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } });
        expect(await iterator.next()).toMatchObject({ value: { content: 'partial' } });
        await iterator.return?.();
        expect(jest.getTimerCount()).toBe(0);
        if (process.platform === 'win32') { expect(mockedSpawn.mock.calls.some(call => /taskkill\.exe$/i.test(call[0]))).toBe(true); }
    });
    it('redacts secrets split at every boundary without reading credentials', () => {
        const key = 'FAKE-REVIEW-KEY';
        for (let split = 1; split < key.length; split++) {
            const redactor = new CliStreamRedactor([key]);
            const text = redactor.push('before ' + key.slice(0, split))
                + redactor.push(key.slice(split) + ' after ', true);
            expect(text).toBe('before [REDACTED] after ');
        }
        expect(getPassword).not.toHaveBeenCalled();
    });

    it.each(['close', 'exit', 'error'])('kills the recorded PID and destroys pipes on abnormal %s without waiting for close', async event => {
        const output = collect(await service.request('codex-cli', request()));
        const assertion = expect(output).rejects.toThrow('CLI');
        child.pid = 0; // Cleanup must use the PID captured immediately after spawn.
        if (event === 'error') { child.emit(event, new Error('secret')); }
        else { child.emit(event, 1, null); }
        await assertion;
        expect(child.stdin.destroy).toHaveBeenCalled();
        expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
        if (process.platform === 'win32') {
            expect(mockedSpawn.mock.calls[1][1]).toEqual(['/T', '/F', '/PID', '987654']);
        } else { expect(process.kill).toHaveBeenCalledWith(-987654, 'SIGKILL'); }
        expect(jest.getTimerCount()).toBe(0);
    });

    it.each([false, true])('return immediately cancels before consumption or while next is pending (pending: %s)', async pending => {
        const response = await service.request('codex-cli', request());
        if (!('stream' in response)) { throw new Error('Expected stream'); }
        const iterator = response.stream[Symbol.asyncIterator]();
        const waiting = pending ? [iterator.next(), iterator.next()] : [];
        expect(await iterator.return!()).toEqual({ done: true, value: undefined });
        for (const next of waiting) { expect(await next).toEqual({ done: true, value: undefined }); }
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
        expect(child.stdin.destroy).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(mockedSpawn.mock.calls.length > 1 || (process.kill as jest.Mock).mock.calls.length > 0).toBe(true);
    });

    it.each(['exit', 'close', 'error'])('preflight also cleans abnormal %s', async event => {
        const check = service.check('codex-cli', { ...CLI_DEFAULTS, codexCommand: process.execPath });
        if (event === 'error') { child.emit(event, new Error('secret')); } else { child.emit(event, 1, null); }
        expect(await check).toMatchObject({ available: false });
        expect(child.stdout.destroyed).toBe(true); expect(child.stdin.destroy).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    it.each(['codex-cli', 'claude-code-cli'] as const)('passes only the allowlisted env to %s for request and preflight', async kind => {
        Object.assign(process.env, { OPENAI_API_KEY: 'openai-secret', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: secret',
            CLAUDE_CODE_USE_MANTLE: '1', AWS_ACCESS_KEY_ID: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'secret', NODE_OPTIONS: '--require evil' });
        const response = await service.request(kind, request());
        expect(mockedSpawn.mock.calls[0][2].env).toEqual(cliEnvironment(kind, process.env));
        if ('stream' in response) { await response.stream[Symbol.asyncIterator]().return!(); }
        const offset = mockedSpawn.mock.calls.length;
        const check = service.check(kind, { ...CLI_DEFAULTS, codexCommand: process.execPath, claudeCommand: process.execPath, workingDirectory: process.cwd() });
        await Promise.resolve(); await Promise.resolve();
        expect(mockedSpawn.mock.calls[offset][2].env).toEqual(cliEnvironment(kind, process.env));
        child.emit('close', 0); await check;
    });
});

it('pins the complete environment allowlist and rejects arbitrary provider/runtime injection variables', () => {
    const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
        'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
        'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
        'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS',
        'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_MONETARY', 'LC_TIME',
        'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION', 'TERM', 'COLORTERM',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'https_proxy'];
    const rejected = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
        'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
        'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'NODE_PATH',
        'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GITHUB_TOKEN', 'RANDOM_SECRET', 'LC_SECRET', 'PROCESSOR_SECRET'];
    const source = Object.fromEntries([...allowed, ...rejected, 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(name => [name, name + '-value']));
    const expected = Object.fromEntries(allowed.map(name => [name, name + '-value']));
    expect(cliEnvironment('claude-code-cli', source)).toEqual({ ...expected, CLAUDE_CONFIG_DIR: 'CLAUDE_CONFIG_DIR-value' });
    expect(cliEnvironment('codex-cli', source)).toEqual({ ...expected, CODEX_HOME: 'CODEX_HOME-value' });
    expect(source.ANTHROPIC_API_KEY).toBe('ANTHROPIC_API_KEY-value');
});

it('holds secret prefixes, handles mismatches, overlapping secrets, and flushes a safe final suffix', () => {
    const redactor = new CliStreamRedactor(['abc', 'abcdef']);
    expect(redactor.push('safe ab')).toBe('safe ');
    expect(redactor.push('c')).toBe('');
    expect(redactor.push('def abc! ab')).toBe('[REDACTED] [REDACTED]! ');
    expect(redactor.push('x ab')).toBe('abx ');
    expect(redactor.push('', true)).toBe('ab');
});

describe('Claude complete-message reconciliation', () => {
    const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
    const assistant = (id: string, text: string) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
    const start = (id: string) => JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    it('keeps identical text blocks at distinct indices and reconciles thinking independently', () => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        const parts: LanguageModelStreamResponsePart[] = [];
        const decode = (value: unknown): void => { parts.push(...decoder.decode(JSON.stringify(value))); };
        decoder.decode(start('a'));
        for (const [index, type, value] of [[0, 'text', '同じ本文'], [1, 'thinking', '考え'], [2, 'text', '同じ本文']] as const) {
            const field = type === 'thinking' ? 'thinking' : 'text';
            decode({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type, [field]: '' } } });
            decode({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: `${type}_delta`, [field]: value.slice(0, 1) } } });
            decode({ type: 'assistant', message: { id: 'a', content: [{ type, [field]: value }] } });
            decode({ type: 'stream_event', event: { type: 'content_block_stop', index } });
        }
        decode({ type: 'result', result: '同じ本文' });
        expect(parts).toEqual([{ content: '同' }, { content: 'じ本文' }, { thought: '考', signature: '' },
            { thought: 'え', signature: '' }, { content: '同' }, { content: 'じ本文' }]);
        expect(decoder.done).toBe(true);
    });
    it.each(['assistant', 'result'])('appends only the missing suffix from %s', snapshot => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        expect(decoder.decode(delta('hello'))).toEqual([{ content: 'hello' }]);
        expect(decoder.decode(snapshot === 'assistant' ? assistant('a', 'hello world') : '{"type":"result","result":"hello world"}'))
            .toEqual([{ content: ' world' }]);
        if (snapshot === 'assistant') { expect(decoder.decode('{"type":"result","result":"hello world"}')).toEqual([]); }
        expect(decoder.done).toBe(true);
    });
    it('reconciles each message independently and never repeats snapshots or the final result', () => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        decoder.decode(start('a')); decoder.decode(delta('first'));
        expect(decoder.decode(assistant('a', 'first'))).toEqual([]);
        decoder.decode(start('b')); decoder.decode(delta('se'));
        expect(decoder.decode(assistant('b', 'second'))).toEqual([{ content: 'cond' }]);
        expect(decoder.decode(assistant('b', 'second'))).toEqual([]);
        expect(decoder.decode('{"type":"result","result":"second"}')).toEqual([]);
    });
    it('restores missing thinking from the complete assistant message', () => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        decoder.decode('{"type":"stream_event","event":{"delta":{"type":"thinking_delta","thinking":"think"}}}');
        expect(decoder.decode('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"thinking"},{"type":"text","text":"answer"}]}}'))
            .toEqual([{ thought: 'ing', signature: '' }, { content: 'answer' }]);
        expect(decoder.decode('{"type":"result","result":"answer"}')).toEqual([]);
    });
    it.each(['assistant', 'result'])('rejects irrecoverable missing middle content in %s', snapshot => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        decoder.decode(delta('hel')); decoder.decode(delta('world'));
        expect(() => decoder.decode(snapshot === 'assistant' ? assistant('a', 'hello world') : '{"type":"result","result":"hello world"}')).toThrow('一致');
        expect(decoder.done).toBe(false);
    });
    it('rejects a text-only result when the thinking stream cannot be verified', () => {
        const decoder = new CliAgentDecoder('claude-code-cli');
        decoder.decode('{"type":"stream_event","event":{"delta":{"type":"thinking_delta","thinking":"partial"}}}');
        expect(() => decoder.decode('{"type":"result","result":"answer"}')).toThrow('完全版');
    });
});

it('formats system, multiple turns, tools and image notices in conversation order', () => {
    expect(cliTranscript([
        { actor: 'system', type: 'text', text: 'system' }, { actor: 'user', type: 'text', text: 'one' },
        { actor: 'ai', type: 'text', text: 'two' }, { actor: 'user', type: 'image', image: { url: 'private-url' } },
        { actor: 'user', type: 'text', text: 'three' }
    ])).toBe(`システム: system\n\nユーザー: one\n\nアシスタント: two\n\nユーザー: [${CLI_IMAGE_NOTICE}]\n\nユーザー: three`);
});
it('falls back from unapproved modes and passes only approved CLI arguments', () => {
    const s = normalizeCliSettings({ codexSandbox: 'unknown', claudePermissionMode: 'manual', timeoutMinutes: NaN });
    expect(s).toEqual(CLI_DEFAULTS);
    expect(cliArguments('claude-code-cli', normalizeCliSettings({ claudePermissionMode: 'default' }))).toContain('manual');
    expect(cliArguments('codex-cli', normalizeCliSettings({ codexSandbox: 'workspace-write', codexModel: 'model' })))
        .toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-m', 'model', '-']);
});
it('defines permission options with safe defaults', () => {
    expect(cliAgentPreferenceSchema.properties['arschat.cliAgents.codex.sandbox']).toMatchObject({
        default: 'read-only', enum: ['read-only', 'workspace-write', 'danger-full-access']
    });
    expect(cliAgentPreferenceSchema.properties['arschat.cliAgents.claudeCode.permissionMode']).toMatchObject({
        default: 'plan', enum: ['plan', 'acceptEdits', 'default', 'bypassPermissions']
    });
    expect(normalizeCliSettings(undefined)).toEqual(CLI_DEFAULTS);
});
it.each(['read-only', 'workspace-write', 'danger-full-access'])('accepts Codex sandbox %s at the backend boundary', codexSandbox => {
    const settings = normalizeCliSettings({ codexSandbox });
    expect(settings.codexSandbox).toBe(codexSandbox);
    const args = cliArguments('codex-cli', settings);
    expect(args[args.indexOf('-s') + 1]).toBe(codexSandbox);
});
it.each(['plan', 'acceptEdits', 'default', 'bypassPermissions'])('accepts Claude permission %s at the backend boundary', claudePermissionMode => {
    const settings = normalizeCliSettings({ claudePermissionMode });
    expect(settings.claudePermissionMode).toBe(claudePermissionMode);
    const args = cliArguments('claude-code-cli', settings);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe(claudePermissionMode === 'default' ? 'manual' : claudePermissionMode);
});
it.each(['unknown', '', null, 0, {}, '--dangerously-bypass-approvals-and-sandbox'])('falls back to safe modes for invalid value %j', value => {
    expect(normalizeCliSettings({ codexSandbox: value, claudePermissionMode: value })).toEqual(CLI_DEFAULTS);
});
it('ignores blank lines and unknown JSON events, supports result-only Claude responses', () => {
    const decoder = new CliAgentDecoder('claude-code-cli');
    for (const line of ['', '  \r', 'null', '12', '{}', '{"type":"system"}']) { expect(decoder.decode(line)).toEqual([]); }
    expect(decoder.decode('{"type":"result","result":"PONG"}')).toEqual([{ content: 'PONG' }]);
    expect(decoder.done).toBe(true);
});
it('keeps the full provider ordering and excludes CLI from custom endpoint seeding', async () => {
    expect(PROVIDERS.map(p => p.kind)).toEqual(['anthropic', 'openai', 'lmstudio', 'ollama', 'vllm', 'llamacpp', 'unsloth', 'openai-compatible', 'codex-cli', 'claude-code-cli', 'opencode-cli']);
    expect(customEndpointProviders().some(p => p.group === 'cli')).toBe(false);
    const prefs = new Map();
    const service: any = new ProviderSwitchService();
    Object.assign(service, { preferenceService: { get: (k: string, d: unknown) => prefs.get(k) ?? d, set: async (k: string, v: unknown) => prefs.set(k, v) },
        logger: { info: jest.fn(), warn: jest.fn() } });
    expect(await service.setActive('codex-cli', 'custom-model')).toEqual({ provider: 'codex-cli', model: 'codex-cli', modelId: 'codex-cli' });
    expect([...prefs.keys()]).not.toContain('ai-features.openAiCustom.customOpenAiModels');
});
it('leaves non-Windows executable resolution to spawn', () => {
    expect(cliExecutable('/usr/bin/codex', 'linux')).toEqual({ command: '/usr/bin/codex', prefix: [] });
});
it('resolves Windows npm JS and native shims without invoking cmd or interpolating arguments', () => {
    if (process.platform !== 'win32') { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'arschat-cli-shim-'));
    const files = ['codex.cmd', 'codex.js', 'claude.cmd', 'claude.exe'];
    try {
        writeFileSync(path.join(dir, 'codex.cmd'), '"%_prog%" "%dp0%\\codex.js" %*');
        writeFileSync(path.join(dir, 'codex.js'), '');
        writeFileSync(path.join(dir, 'claude.cmd'), '"%dp0%\\claude.exe" %*');
        writeFileSync(path.join(dir, 'claude.exe'), '');
        expect(cliExecutable(path.join(dir, 'codex.cmd'))).toEqual({ command: process.execPath, prefix: [path.join(dir, 'codex.js')] });
        expect(cliExecutable(path.join(dir, 'claude.cmd'))).toEqual({ command: path.join(dir, 'claude.exe'), prefix: [] });
        expect(cliExecutable('claude', 'win32', { PATH: dir })).toEqual({ command: path.join(dir, 'claude.exe'), prefix: [] });
        writeFileSync(path.join(dir, 'codex.cmd'), 'echo unsupported');
        expect(() => cliExecutable(path.join(dir, 'codex.cmd'))).toThrow('Unsupported CLI shim');
    } finally {
        for (const file of files) { unlinkSync(path.join(dir, file)); }
        rmdirSync(dir);
    }
});
it.each([CLAUDE_LOGIN_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED])('autotest is opt-in and accepts Claude guidance: %s', async message => {
    const c: any = new CliAgentAutotestContribution();
    Object.assign(c, { envServer: { getValue: async () => undefined } });
    c.run = jest.fn(); await c.onStart(); expect(c.run).not.toHaveBeenCalled();
    delete c.run;
    Object.assign(c, {
        preferences: { ready: Promise.resolve(), get: (_k: string, d: unknown) => d },
        switchService: { getActiveProvider: () => 'openai', getActiveModel: () => 'saved', setActive: jest.fn(async (kind: string) => ({ modelId: kind })) },
        cliService: { check: async () => ({ available: false, loggedIn: message === CLAUDE_SUBSCRIPTION_REQUIRED, message }) },
        roundTrip: jest.fn().mockResolvedValueOnce('PONG').mockResolvedValueOnce('東京').mockResolvedValueOnce(message), log: jest.fn()
    });
    await c.run();
    expect(c.log).toHaveBeenCalledWith('claude-pong-or-login-required: PASS');
    expect(c.log).toHaveBeenCalledWith('opencode: SKIP');
    expect(c.log).toHaveBeenLastCalledWith('SUMMARY 3 PASS / 0 FAIL');
    expect(c.switchService.setActive).toHaveBeenLastCalledWith('openai', 'saved');
});

describe('OpenCode settings and protocol', () => {
    it.each(['plan', 'build'] as const)('passes the %s agent with optional model', opencodeAgent => {
        for (const opencodeModel of ['', 'edgexpert/qwen3.8-flash-next']) {
            expect(cliArguments('opencode-cli', normalizeCliSettings({ opencodeAgent, opencodeModel })))
                .toEqual(['run', '--format', 'json', '--thinking', '--agent', opencodeAgent,
                    ...(opencodeModel ? ['-m', opencodeModel] : [])]);
        }
    });
    it.each(['invalid', '', null, 0, {}])('defaults invalid agent %j to plan', opencodeAgent => {
        expect(normalizeCliSettings({ opencodeAgent })).toEqual(CLI_DEFAULTS);
    });
    it('normalizes command/model preferences and defines safe permission defaults', () => {
        expect(normalizeCliSettings({ opencodeCommand: ' ', opencodeModel: ' provider/model ' }))
            .toMatchObject({ opencodeCommand: 'opencode', opencodeModel: 'provider/model' });
        expect(cliAgentPreferenceSchema.properties['arschat.cliAgents.opencode.agent'])
            .toMatchObject({ default: 'plan', enum: ['plan', 'build'], markdownDescription: expect.stringContaining('警告') });
    });
    it('only passes the six OpenCode configuration paths to OpenCode, never API credentials', () => {
        const names = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
        const paths = Object.fromEntries(names.map(n => [n, 'path']));
        const source = { ...paths, OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', OPENCODE_CONFIG_CONTENT: 'secret' };
        expect(cliEnvironment('opencode-cli', source)).toEqual(paths);
        expect(cliEnvironment('codex-cli', source)).toEqual({});
        expect(cliEnvironment('claude-code-cli', source)).toEqual({});
    });
    it('deduplicates and extends text/reasoning snapshots independently and separates parts', () => {
        const decoder = new CliAgentDecoder('opencode-cli');
        const decode = (type: string, id: string, text: string) => decoder.decode(JSON.stringify({ type, part: { type, id, text } }));
        expect(decode('text', 'a', 'PO')).toEqual([{ content: 'PO' }]);
        expect(decode('text', 'a', 'PO')).toEqual([]);
        expect(decode('text', 'a', 'PONG')).toEqual([{ content: 'NG' }]);
        expect(decode('text', 'a', 'changed')).toEqual([]);
        expect(decode('text', 'a', 'PONG!')).toEqual([{ content: '!' }]);
        expect(decode('text', 'b', '東京')).toEqual([{ content: '\n\n東京' }]);
        expect(decode('reasoning', 'a', '考')).toEqual([{ thought: '考', signature: '' }]);
        expect(decode('reasoning', 'a', '考え')).toEqual([{ thought: 'え', signature: '' }]);
        expect(decode('reasoning', 'a', '考え')).toEqual([]);
        expect(decode('reasoning', 'a', '変更')).toEqual([]);
        expect(decode('reasoning', 'b', '次')).toEqual([{ thought: '\n\n次', signature: '' }]);
        expect(decode('tool_use', 'tool', 'private output')).toEqual([]);
        expect(decode('unknown', 'c', 'ignored')).toEqual([]);
        expect(decoder.decode('{"type":"reasoning","part":{"type":"text","id":"c","text":"ignored"}}')).toEqual([]);
    });
});

it.each([false, true])('runs all three opt-in OpenCode autotests and restores preferences even on failure (%s)', failed => {
    const c: any = new CliAgentAutotestContribution();
    const initial = new Map<string, unknown>([['arschat.cliAgents.opencode.model', 'saved/model']]);
    const prefs = new Map(initial);
    const set = jest.fn(async (key: string, value: unknown) => {
        if (value === undefined) { prefs.delete(key); } else { prefs.set(key, value); }
    });
    const roundTrip = jest.fn().mockResolvedValueOnce('PONG').mockResolvedValueOnce('東京').mockResolvedValueOnce('PONG')
        .mockResolvedValueOnce(failed ? 'wrong' : 'PONG').mockResolvedValueOnce('東京');
    Object.assign(c, {
        envServer: { getValue: async () => ({ value: 'edgexpert/qwen3.8-flash-next' }) },
        preferences: { ready: Promise.resolve(), get: (key: string, fallback: unknown) => prefs.get(key) ?? fallback,
            inspect: (key: string) => ({ globalValue: prefs.get(key) }), set },
        switchService: { getActiveProvider: () => 'openai', getActiveModel: () => 'saved',
            setActive: jest.fn(async (kind: string) => ({ modelId: kind })) },
        cliService: { check: async () => ({ available: true }), listModels: jest.fn(async () => ['edgexpert/qwen3.8-flash-next']) },
        roundTrip, log: jest.fn()
    });
    return c.run().then(() => {
        expect(c.cliService.listModels).toHaveBeenCalledWith('opencode-cli', expect.objectContaining({
            opencodeAgent: 'plan', opencodeModel: 'edgexpert/qwen3.8-flash-next'
        }));
        expect(c.log).toHaveBeenCalledWith('opencode-models: PASS');
        expect(c.log).toHaveBeenCalledWith(`opencode-pong: ${failed ? 'FAIL' : 'PASS'}`);
        expect(c.log).toHaveBeenCalledWith('opencode-japanese: PASS');
        expect(c.log).toHaveBeenLastCalledWith(failed ? 'SUMMARY 5 PASS / 1 FAIL' : 'SUMMARY 6 PASS / 0 FAIL');
        expect(prefs).toEqual(initial);
        expect(c.switchService.setActive).toHaveBeenLastCalledWith('openai', 'saved');
        expect(set.mock.calls.every((call: unknown[]) => call[2] === PreferenceScope.User)).toBe(true);
    });
});

it('never resolves Windows launchers from cwd, relative PATH entries, or a local node.exe', () => {
    if (process.platform !== 'win32') { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'arschat-cli-cwd-'));
    const files = ['codex.cmd', 'codex.js', 'node.exe', 'taskkill.exe'];
    try {
        writeFileSync(path.join(dir, 'codex.cmd'), '"%_prog%" "%dp0%\\codex.js" %*');
        for (const file of files.slice(1)) { writeFileSync(path.join(dir, file), ''); }
        expect(() => cliExecutable('codex', 'win32', { PATH: `;.;relative;${dir}` }, dir)).toThrow('missing');
        expect(() => cliExecutable('.\\codex.cmd', 'win32', { PATH: dir }, dir)).toThrow('absolute');
        expect(cliExecutable(path.join(dir, 'codex.cmd'), 'win32', { PATH: dir }, dir))
            .toEqual({ command: process.execPath, prefix: [path.join(dir, 'codex.js')] });
        mockedSpawn.mockReset().mockReturnValue(new FakeChild());
        spawnCli(path.join(dir, 'codex.cmd'), ['--version'], {}, dir);
        expect(mockedSpawn.mock.calls[0][0]).toBe(process.execPath);
        expect(path.isAbsolute(mockedSpawn.mock.calls[0][0])).toBe(true);
        killCliTree(new FakeChild() as any);
        expect(mockedSpawn.mock.calls[1][0]).toBe(path.win32.join(process.env.SystemRoot!, 'System32', 'taskkill.exe'));
    } finally {
        for (const file of files) { unlinkSync(path.join(dir, file)); }
        rmdirSync(dir);
    }
});

it('runs the trusted Electron executable as Node for a JS shim without inheriting NODE_OPTIONS', () => {
    if (process.platform !== 'win32') { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'arschat-cli-electron-'));
    const previous = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    try {
        Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'test' });
        writeFileSync(path.join(dir, 'codex.cmd'), '"%_prog%" "%dp0%\\codex.js" %*');
        writeFileSync(path.join(dir, 'codex.js'), '');
        mockedSpawn.mockReset().mockReturnValue(new FakeChild());
        spawnCli(path.join(dir, 'codex.cmd'), [], cliEnvironment('codex-cli', { NODE_OPTIONS: '--require evil' }));
        expect(mockedSpawn.mock.calls[0][0]).toBe(process.execPath);
        expect(mockedSpawn.mock.calls[0][2].env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    } finally {
        if (previous) { Object.defineProperty(process.versions, 'electron', previous); } else { Reflect.deleteProperty(process.versions, 'electron'); }
        unlinkSync(path.join(dir, 'codex.cmd')); unlinkSync(path.join(dir, 'codex.js')); rmdirSync(dir);
    }
});

it.each([false, true])('logs sanitized taskkill failures and falls back once (error before close: %s)', errorFirst => {
    if (process.platform !== 'win32') { return; }
    const child = new FakeChild(), killer = new FakeChild();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        mockedSpawn.mockReset().mockReturnValue(killer);
        killCliTree(child as any);
        if (errorFirst) { killer.emit('error', new Error('secret details')); }
        killer.emit('close', 1);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[CLI-AGENTS] Process tree termination failed.');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret details');
    } finally { warn.mockRestore(); }
});
