// *****************************************************************************
// Pure run_command helpers (PHASE1_DESIGN.md §7, M5 e-4).
//
// The command-execution tool is a *backend* (node) tool: spawning a shell needs
// Node, so the actual child_process work lives in ../node/. What stays here is
// the Theia-DI-free, unit-testable core:
//   - shell-invocation assembly (which shell + which args for a given command),
//   - output truncation (bounding stdout/stderr so a chatty command cannot blow
//     the model's context window),
// mirroring the "pure logic in common/, thin glue elsewhere" split used by the
// file tools. The backend impl (command-runner-service-impl.ts) calls these so
// the platform-branching and truncation rules are covered by plain node jest.
// *****************************************************************************

/** The shell ArsChat runs a command through. */
export type CommandShell = 'pwsh' | 'cmd' | 'posix';

/** A fully assembled `spawn(file, args, { shell })` invocation. */
export interface ShellInvocation {
    /** Executable to spawn (or the raw command line when `useShellOption` is true). */
    file: string;
    /** Argument vector (empty when `useShellOption` is true). */
    args: string[];
    /** When true, spawn with `{ shell: true }` and no explicit arg vector (POSIX). */
    useShellOption: boolean;
}

/**
 * Upper bound on how much command output (stdout + stderr, counted together) we
 * feed back to the model. Kept in sync with read_file's READ_FILE_MAX_CHARS so
 * both tools truncate at the same ceiling. A runaway command (e.g. `cat` of a
 * huge file, an infinite loop printing) would otherwise flood the context
 * window; we cut it off and mark it so the model knows the output is partial.
 * (Review nit for e-4: the ArsChat original had no output cap at all.)
 */
export const RUN_COMMAND_MAX_OUTPUT_CHARS = 50_000;

/** Default command timeout in ms when the request does not specify one. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Human/LLM-facing warning shown when the user is asked to enable "always allow"
 * for run_command. Passed as the `confirmAlwaysAllow` string so Theia's
 * confirmation manager treats run_command as confirm-required (never
 * ALWAYS_ALLOW) and surfaces this text in the always-allow escalation. Command
 * execution is strictly more dangerous than file writes, so the warning is
 * blunter than WRITE_TOOL_CONFIRM_WARNING.
 */
export const RUN_COMMAND_CONFIRM_WARNING =
    'This tool runs an arbitrary shell command on your machine. Auto-approval would let the '
    + 'assistant execute commands (including destructive ones) without asking. Leave this off '
    + 'unless you fully trust the current task.';

/**
 * Assemble the concrete shell invocation for a command on a given shell.
 *
 * Windows:
 *  - `pwsh`: PowerShell 7+. Prepend an encoding preamble so child output is
 *    UTF-8 regardless of the console code page, then run the command via
 *    `-Command`. `-NoProfile` keeps startup deterministic/fast.
 *  - `cmd`: legacy cmd.exe fallback. `chcp 65001` switches the code page to
 *    UTF-8 (silenced) before the command, so non-ASCII output round-trips.
 * POSIX: run the raw command line through the login shell via `{ shell: true }`.
 *
 * The chosen shell is decided at runtime by the backend (probe for pwsh); this
 * function is the pure "given the shell, build the argv" half so the exact
 * argument wiring is unit-tested without spawning anything.
 */
export function buildShellInvocation(command: string, shell: CommandShell): ShellInvocation {
    switch (shell) {
        case 'pwsh':
            return {
                file: 'pwsh.exe',
                args: [
                    '-NoProfile',
                    '-Command',
                    `$OutputEncoding = [System.Text.Encoding]::UTF8; `
                    + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
                ],
                useShellOption: false
            };
        case 'cmd':
            return {
                file: 'cmd.exe',
                args: ['/c', `chcp 65001 >nul 2>&1 & ${command}`],
                useShellOption: false
            };
        case 'posix':
        default:
            return { file: command, args: [], useShellOption: true };
    }
}

/**
 * Bound the combined length of stdout+stderr at RUN_COMMAND_MAX_OUTPUT_CHARS.
 * stdout is preserved first; stderr gets whatever budget remains. Any stream
 * that is cut has a `...(truncated)` marker appended so the model can tell the
 * output is incomplete. Returns the (possibly shortened) streams plus a flag.
 */
export function truncateOutput(
    stdout: string,
    stderr: string,
    maxChars: number = RUN_COMMAND_MAX_OUTPUT_CHARS
): { stdout: string; stderr: string; truncated: boolean } {
    if (stdout.length + stderr.length <= maxChars) {
        return { stdout, stderr, truncated: false };
    }
    const marker = '\n...(truncated)';
    // Give stdout priority; it is usually the useful part.
    const outBudget = Math.min(stdout.length, maxChars);
    const cutStdout = stdout.length > outBudget;
    const outText = cutStdout ? stdout.slice(0, Math.max(0, outBudget - marker.length)) + marker : stdout;

    const errBudget = Math.max(0, maxChars - outText.length);
    let errText: string;
    let cutStderr: boolean;
    if (stderr.length <= errBudget) {
        errText = stderr;
        cutStderr = false;
    } else if (errBudget <= marker.length) {
        // No room left for meaningful stderr text (stdout took the whole budget):
        // drop it rather than emit a bare marker that would overflow the cap.
        errText = errBudget > 0 ? marker.slice(0, errBudget) : '';
        cutStderr = true;
    } else {
        errText = stderr.slice(0, errBudget - marker.length) + marker;
        cutStderr = true;
    }

    return { stdout: outText, stderr: errText, truncated: cutStdout || cutStderr };
}
