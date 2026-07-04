// Pure-logic tests for run_command's shell-invocation assembly and output
// truncation (../common/run-command.ts). Theia-DI-free / no child_process, so
// these run in a plain node jest env alongside the file-tool tests.
import {
    buildShellInvocation,
    truncateOutput,
    RUN_COMMAND_MAX_OUTPUT_CHARS
} from './run-command';

describe('buildShellInvocation (shell arg assembly)', () => {

    it('pwsh: injects the UTF-8 preamble and runs via -NoProfile -Command', () => {
        const inv = buildShellInvocation('echo hi', 'pwsh');
        expect(inv.file).toBe('pwsh.exe');
        expect(inv.useShellOption).toBe(false);
        expect(inv.args[0]).toBe('-NoProfile');
        expect(inv.args[1]).toBe('-Command');
        // Encoding preamble precedes the user command.
        expect(inv.args[2]).toContain('OutputEncoding');
        expect(inv.args[2]).toContain('[Console]::OutputEncoding');
        expect(inv.args[2]).toMatch(/echo hi$/);
    });

    it('cmd: prepends chcp 65001 (silenced) before the command via /c', () => {
        const inv = buildShellInvocation('dir', 'cmd');
        expect(inv.file).toBe('cmd.exe');
        expect(inv.useShellOption).toBe(false);
        expect(inv.args[0]).toBe('/c');
        expect(inv.args[1]).toBe('chcp 65001 >nul 2>&1 & dir');
    });

    it('posix: runs the raw command line through { shell: true } with no argv', () => {
        const inv = buildShellInvocation('ls -la', 'posix');
        expect(inv.file).toBe('ls -la');
        expect(inv.args).toEqual([]);
        expect(inv.useShellOption).toBe(true);
    });

    it('preserves the exact command text (no shell-escaping mangling)', () => {
        const cmd = 'git commit -m "msg with && special | chars"';
        expect(buildShellInvocation(cmd, 'pwsh').args[2]).toContain(cmd);
        expect(buildShellInvocation(cmd, 'cmd').args[1]).toContain(cmd);
        expect(buildShellInvocation(cmd, 'posix').file).toBe(cmd);
    });
});

describe('truncateOutput (combined output cap)', () => {

    it('leaves small output untouched and flags nothing', () => {
        const r = truncateOutput('hello', 'world');
        expect(r.stdout).toBe('hello');
        expect(r.stderr).toBe('world');
        expect(r.truncated).toBe(false);
    });

    it('caps a giant stdout with a ...(truncated) marker', () => {
        const big = 'a'.repeat(RUN_COMMAND_MAX_OUTPUT_CHARS + 5000);
        const r = truncateOutput(big, '');
        expect(r.truncated).toBe(true);
        expect(r.stdout.length).toBeLessThanOrEqual(RUN_COMMAND_MAX_OUTPUT_CHARS);
        expect(r.stdout.endsWith('...(truncated)')).toBe(true);
    });

    it('bounds the COMBINED stdout+stderr length, prioritising stdout', () => {
        const half = RUN_COMMAND_MAX_OUTPUT_CHARS; // stdout alone already fills the budget
        const r = truncateOutput('o'.repeat(half), 'e'.repeat(half));
        expect(r.stdout.length + r.stderr.length).toBeLessThanOrEqual(RUN_COMMAND_MAX_OUTPUT_CHARS);
        expect(r.truncated).toBe(true);
        // stdout keeps (almost) the whole budget; stderr is squeezed out.
        expect(r.stdout.length).toBeGreaterThan(r.stderr.length);
    });

    it('respects a custom max and truncates stderr when stdout is small', () => {
        const r = truncateOutput('short', 'z'.repeat(100), 20);
        expect(r.stdout).toBe('short');
        expect(r.truncated).toBe(true);
        expect(r.stderr.endsWith('...(truncated)')).toBe(true);
        expect(r.stdout.length + r.stderr.length).toBeLessThanOrEqual(20);
    });
});
