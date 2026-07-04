// *****************************************************************************
// run_command backend service (PHASE1_DESIGN.md §7, M5 e-4).
//
// The single node place that actually spawns a child process for the run_command
// tool. Exposed to the frontend over JSON-RPC via CommandRunnerService /
// commandRunnerServicePath (see ../common/command-runner-protocol.ts and
// arschat-tools-backend-module.ts).
//
// Ported from ArsChat's code-editor-manager.ts runCommand + detectWindowsShell,
// with two review fixes over the original:
//   (1) OUTPUT CAP: the original captured unbounded stdout/stderr; we bound the
//       combined length to RUN_COMMAND_MAX_OUTPUT_CHARS (see ../common/run-command.ts).
//   (2) PROCESS-TREE KILL on timeout: the original called only `proc.kill()`,
//       which signals the shell but orphans its children (a build spawning a
//       compiler, `npm` spawning node, etc.). We kill the whole tree:
//         - Windows: `taskkill /pid <pid> /T /F` (/T = tree, /F = force). This is
//           the standard Windows way to end a process and all its descendants;
//           Node has no native process-group kill on win32.
//         - POSIX: spawn the shell `detached` so it becomes a process-group
//           leader (setsid), then `process.kill(-pid, 'SIGKILL')` to signal the
//           entire group. This reaches grandchildren that a bare `proc.kill()`
//           would leave running.
//       Rationale recorded in BUILD_NOTES ("Phase 1 M5 実装メモ (e-4)").
//
// The shell selection + argv assembly + truncation are the pure, unit-tested
// helpers in ../common/run-command.ts; this file is the child_process glue.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { ChildProcess, execSync, spawn } from 'child_process';
import {
    CommandShell,
    buildShellInvocation,
    truncateOutput,
    RUN_COMMAND_DEFAULT_TIMEOUT_MS
} from '../common/run-command';
import {
    CommandRunnerService,
    RunCommandRequest,
    RunCommandResult
} from '../common/command-runner-protocol';

@injectable()
export class CommandRunnerServiceImpl implements CommandRunnerService {

    /** Cached Windows shell probe result (pwsh vs cmd). */
    protected windowsShell: 'pwsh' | 'cmd' | undefined;

    /**
     * Detect the best available Windows shell once and cache it:
     *  - pwsh.exe (PowerShell 7+): `&&` support + native UTF-8,
     *  - cmd.exe (fallback): probed by running `pwsh.exe ... exit` and falling
     *    back on failure.
     */
    protected detectWindowsShell(): 'pwsh' | 'cmd' {
        if (this.windowsShell) {
            return this.windowsShell;
        }
        try {
            execSync('pwsh.exe -NoProfile -Command exit', { timeout: 3000, stdio: 'pipe' });
            this.windowsShell = 'pwsh';
        } catch {
            this.windowsShell = 'cmd';
        }
        return this.windowsShell;
    }

    protected selectShell(): CommandShell {
        return process.platform === 'win32' ? this.detectWindowsShell() : 'posix';
    }

    async runCommand(request: RunCommandRequest): Promise<RunCommandResult> {
        const timeoutMs = request.timeout ?? RUN_COMMAND_DEFAULT_TIMEOUT_MS;
        const shell = this.selectShell();
        const invocation = buildShellInvocation(request.command, shell);

        return new Promise<RunCommandResult>((resolve, reject) => {
            const decoder = new TextDecoder('utf-8');
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let timedOut = false;
            let settled = false;

            let proc: ChildProcess;
            try {
                if (invocation.useShellOption) {
                    // POSIX: run the raw command line through the login shell, and
                    // detach so the shell leads its own process group (for group kill).
                    proc = spawn(invocation.file, {
                        cwd: request.cwd,
                        shell: true,
                        detached: true
                    });
                } else {
                    proc = spawn(invocation.file, invocation.args, { cwd: request.cwd });
                }
            } catch (err) {
                reject(err);
                return;
            }

            const timer = setTimeout(() => {
                timedOut = true;
                this.killTree(proc);
            }, timeoutMs);

            proc.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
            proc.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

            proc.on('close', code => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const rawStdout = decoder.decode(Buffer.concat(stdoutChunks));
                let rawStderr = decoder.decode(Buffer.concat(stderrChunks));
                if (timedOut) {
                    rawStderr = `${rawStderr}\n[timeout after ${timeoutMs}ms]`;
                }
                const { stdout, stderr, truncated } = truncateOutput(rawStdout, rawStderr);
                resolve({
                    stdout,
                    stderr,
                    exitCode: timedOut ? -1 : (code ?? 0),
                    truncated,
                    timedOut
                });
            });

            proc.on('error', err => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Kill the child process AND its descendants. See the file header for the
     * Windows (taskkill /T /F) vs POSIX (negative-pid group kill) rationale.
     */
    protected killTree(proc: ChildProcess): void {
        const pid = proc.pid;
        if (pid === undefined) {
            return;
        }
        if (process.platform === 'win32') {
            try {
                execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
            } catch {
                // Process may already be gone; fall back to a direct kill.
                try {
                    proc.kill();
                } catch { /* ignore */ }
            }
        } else {
            try {
                // Negative pid signals the whole process group (proc was spawned
                // detached, so it leads its own group).
                process.kill(-pid, 'SIGKILL');
            } catch {
                try {
                    proc.kill('SIGKILL');
                } catch { /* ignore */ }
            }
        }
    }
}
