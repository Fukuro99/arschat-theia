// *****************************************************************************
// Pure run_command ToolRequest factory (PHASE1_DESIGN.md §7, M5 e-4).
//
// Builds the run_command ToolRequest (id, schema, description, handler) given a
// plain "command runner" backend + a cwd resolver. Theia-DI-free (only touches
// @theia/ai-core's ToolRequest *type*), so the tool shape and result formatting
// are unit-tested in a plain node jest env, mirroring file-tool-requests.ts.
//
// The browser ToolProvider (browser/run-command-tool-provider.ts) is a thin
// @injectable wrapper that delegates getTool() to this, passing a backend that
// forwards to the node CommandRunnerService over JSON-RPC and a resolver that
// maps a caller-supplied (or omitted) cwd to an absolute path via WorkspaceService.
// *****************************************************************************

import type { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ARSCHAT_TOOL_PROVIDER_NAME, RUN_COMMAND_TOOL_ID } from './tool-ids';
import { parseToolArgs, toolError } from './tool-args';
import { RunCommandResult } from './command-runner-protocol';
import { RUN_COMMAND_CONFIRM_WARNING } from './run-command';

/** The command-execution operations the run_command tool needs. */
export interface CommandToolBackend {
    /**
     * Resolve the caller-supplied cwd (possibly undefined/relative) to the
     * absolute directory the command should run in. Kept on the backend interface
     * so the browser provider owns workspace-root knowledge.
     */
    resolveCwd(cwd: string | undefined): Promise<string>;
    /** Execute the command in `cwd` and return its captured, bounded output. */
    run(command: string, cwd: string, timeout?: number): Promise<RunCommandResult>;
}

/** Format a finished command result into the text the model reads back. */
export function formatRunResult(command: string, result: RunCommandResult): string {
    const lines: string[] = [];
    lines.push(`$ ${command}`);
    lines.push(`exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`);
    lines.push(`--- stdout ---\n${result.stdout || '(empty)'}`);
    lines.push(`--- stderr ---\n${result.stderr || '(empty)'}`);
    if (result.truncated) {
        lines.push('(output was truncated to fit the context limit)');
    }
    return lines.join('\n');
}

export function createRunCommandTool(backend: CommandToolBackend): ToolRequest {
    return {
        id: RUN_COMMAND_TOOL_ID,
        name: RUN_COMMAND_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        // e-4: run_command executes arbitrary shell commands, so it is
        // confirm-required. The string form of confirmAlwaysAllow forces Theia's
        // ToolConfirmationManager into CONFIRM mode (never ALWAYS_ALLOW, even under
        // a global '*' allow), so every call raises the ArsChat approval card, and
        // it doubles as the warning shown on "always allow". Same mechanism as the
        // write tools (see file-tool-requests.ts); the shared approval card lives in
        // arschat-chat's ArschatChatWidget.
        confirmAlwaysAllow: RUN_COMMAND_CONFIRM_WARNING,
        description: 'Run a shell command and return its exit code, stdout and stderr. Runs in the '
            + 'workspace root unless `cwd` is given. Use this for builds, tests, git, and other CLI '
            + 'tasks. The command runs in the platform default shell (PowerShell/cmd on Windows, the '
            + 'login shell on macOS/Linux). Output is truncated if very large; long-running commands '
            + 'time out (default 30s).',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command line to execute.'
                },
                cwd: {
                    type: 'string',
                    description: 'Working directory (absolute, or relative to the workspace root). '
                        + 'Defaults to the workspace root.'
                },
                timeout: {
                    type: 'number',
                    description: 'Timeout in milliseconds before the command (and its child processes) '
                        + 'is killed. Defaults to 30000.'
                }
            },
            required: ['command']
        },
        handler: async (argString: string) => {
            try {
                const { command, cwd, timeout } =
                    parseToolArgs<{ command: string; cwd?: string; timeout?: number }>(argString);
                if (!command || !command.trim()) {
                    return toolError('run_command requires a non-empty "command" argument.');
                }
                const resolvedCwd = await backend.resolveCwd(cwd);
                const result = await backend.run(command, resolvedCwd, timeout);
                return formatRunResult(command, result);
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}
