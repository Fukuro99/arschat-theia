// Backend service smoke tests: the real CommandRunnerServiceImpl actually spawns
// a shell and captures output/exit codes. These run in node jest (no Theia DI —
// the impl is a plain @injectable class we can `new`). They exercise the RPC
// *target* directly, which is what the frontend proxy ultimately invokes.
//
// Cross-platform: assertions use commands available on both Windows (pwsh/cmd)
// and POSIX (`echo`, `exit`). Kept minimal so CI without pwsh still passes.
import { CommandRunnerServiceImpl } from './command-runner-service-impl';

describe('CommandRunnerServiceImpl (real spawn)', () => {
    const service = new CommandRunnerServiceImpl();
    const cwd = process.cwd();

    it('runs echo and returns its stdout with exit code 0', async () => {
        const res = await service.runCommand({ command: 'echo arschat-e4', cwd });
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain('arschat-e4');
        expect(res.timedOut).toBeFalsy();
    });

    it('propagates a non-zero exit code', async () => {
        // `exit 3` works in pwsh, cmd, and POSIX shells.
        const res = await service.runCommand({ command: 'exit 3', cwd });
        expect(res.exitCode).toBe(3);
    });

    it('kills the (tree of the) command on timeout and reports exitCode -1 + timedOut', async () => {
        // A ~20s blocking command against a 500ms timeout: must be tree-killed well
        // before it ends. Use a long-runner that needs no nested quotes (which the
        // Windows shells would mangle): `ping` loops on Windows, `sleep` on POSIX.
        const longRunner = process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 20';
        const start = Date.now();
        const res = await service.runCommand({ command: longRunner, cwd, timeout: 500 });
        const elapsed = Date.now() - start;
        expect(res.timedOut).toBe(true);
        expect(res.exitCode).toBe(-1);
        expect(res.stderr).toContain('[timeout');
        // Proves the process was actually killed (not awaited for the full 20s).
        expect(elapsed).toBeLessThan(10000);
    }, 30000);
});
