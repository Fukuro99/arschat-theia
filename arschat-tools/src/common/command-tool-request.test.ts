// Wiring-level tests for run_command's ToolRequest: the factory must yield the
// expected id/schema + be confirm-required, and its handler must resolve cwd,
// route through the CommandToolBackend, and format the result the way the LLM
// sees it. Theia-DI-free (fake backend), plain node jest env.
import { createRunCommandTool, formatRunResult, CommandToolBackend } from './command-tool-request';
import { RUN_COMMAND_TOOL_ID, ARSCHAT_TOOL_PROVIDER_NAME } from './tool-ids';
import { RunCommandResult } from './command-runner-protocol';

class FakeBackend implements CommandToolBackend {
    lastCommand?: string;
    lastCwd?: string;
    lastTimeout?: number;
    result: RunCommandResult = { stdout: 'ok', stderr: '', exitCode: 0 };

    async resolveCwd(cwd: string | undefined): Promise<string> {
        // Emulate "default to workspace root when omitted".
        return cwd && cwd.trim() ? cwd : '/workspace/root';
    }
    async run(command: string, cwd: string, timeout?: number): Promise<RunCommandResult> {
        this.lastCommand = command;
        this.lastCwd = cwd;
        this.lastTimeout = timeout;
        return this.result;
    }
}

describe('run_command ToolRequest (factory shape + handler wiring)', () => {

    it('exposes the expected ToolRequest shape and IS confirm-required', () => {
        const tool = createRunCommandTool(new FakeBackend());
        expect(tool.id).toBe(RUN_COMMAND_TOOL_ID);
        expect(tool.name).toBe(RUN_COMMAND_TOOL_ID);
        expect(tool.providerName).toBe(ARSCHAT_TOOL_PROVIDER_NAME);
        expect(tool.parameters.required).toContain('command');
        expect(typeof tool.handler).toBe('function');
        // confirm-required: a non-empty confirmAlwaysAllow forces Theia into CONFIRM
        // mode (never ALWAYS_ALLOW), so every call raises the approval card.
        expect(typeof tool.confirmAlwaysAllow).toBe('string');
        expect((tool.confirmAlwaysAllow as string).length).toBeGreaterThan(0);
    });

    it('resolves the default cwd (workspace root) when none is supplied', async () => {
        const backend = new FakeBackend();
        const tool = createRunCommandTool(backend);
        await tool.handler(JSON.stringify({ command: 'npm test' }));
        expect(backend.lastCommand).toBe('npm test');
        expect(backend.lastCwd).toBe('/workspace/root');
    });

    it('passes an explicit cwd and timeout straight through', async () => {
        const backend = new FakeBackend();
        const tool = createRunCommandTool(backend);
        await tool.handler(JSON.stringify({ command: 'ls', cwd: '/tmp/x', timeout: 5000 }));
        expect(backend.lastCwd).toBe('/tmp/x');
        expect(backend.lastTimeout).toBe(5000);
    });

    it('formats exit code / stdout / stderr into the model-facing text', async () => {
        const backend = new FakeBackend();
        backend.result = { stdout: 'built', stderr: 'warn', exitCode: 0 };
        const tool = createRunCommandTool(backend);
        const out = (await tool.handler(JSON.stringify({ command: 'make' }))) as string;
        expect(out).toContain('$ make');
        expect(out).toContain('exit code: 0');
        expect(out).toContain('built');
        expect(out).toContain('warn');
    });

    it('rejects an empty command without touching the backend', async () => {
        const backend = new FakeBackend();
        const tool = createRunCommandTool(backend);
        const out = (await tool.handler(JSON.stringify({ command: '   ' }))) as string;
        expect(out).toMatch(/^ERROR:/);
        expect(backend.lastCommand).toBeUndefined();
    });

    it('surfaces a backend failure as an ERROR string', async () => {
        const backend = new FakeBackend();
        backend.run = async () => { throw new Error('spawn ENOENT'); };
        const tool = createRunCommandTool(backend);
        const out = (await tool.handler(JSON.stringify({ command: 'nope' }))) as string;
        expect(out).toMatch(/^ERROR: spawn ENOENT/);
    });
});

describe('formatRunResult', () => {
    it('marks timeout and truncation in the summary', () => {
        const text = formatRunResult('sleep 99', {
            stdout: '', stderr: '[timeout after 30000ms]', exitCode: -1, timedOut: true, truncated: true
        });
        expect(text).toContain('exit code: -1 (timed out)');
        expect(text).toContain('truncated');
    });

    it('shows (empty) placeholders for blank streams', () => {
        const text = formatRunResult('true', { stdout: '', stderr: '', exitCode: 0 });
        expect(text).toContain('--- stdout ---\n(empty)');
        expect(text).toContain('--- stderr ---\n(empty)');
    });
});
