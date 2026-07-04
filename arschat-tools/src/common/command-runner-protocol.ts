// *****************************************************************************
// RPC protocol for the run_command backend service (PHASE1_DESIGN.md §7, M5 e-4).
//
// run_command spawns a shell, which requires Node -> the work lives on the
// backend (../node/command-runner-service-impl.ts). The frontend ToolProvider
// (../browser/run-command-tool-provider.ts) reaches it through a JSON-RPC proxy
// created from `commandRunnerServicePath`, following the same
// ConnectionHandler/RpcConnectionHandler pattern Theia's own @theia/file-search
// FileSearchService uses (backend: RpcConnectionHandler(path, () => impl);
// frontend: RemoteConnectionProvider.createProxy(path)).
//
// This module is deliberately Theia-runtime-free (only a plain symbol + interfaces
// + data types) so it can be imported from both node and browser without dragging
// browser/DOM deps into the node build (the same discipline as tool-ids.ts).
// *****************************************************************************

/** JSON-RPC service path the run_command backend is exposed on. */
export const commandRunnerServicePath = '/services/arschat-run-command';

/** DI symbol for the backend command runner (bound in node + as a proxy in browser). */
export const CommandRunnerService = Symbol('CommandRunnerService');

/** A request to execute one shell command line. */
export interface RunCommandRequest {
    /** The shell command line to run. */
    command: string;
    /**
     * Working directory to run in. The frontend resolves this (workspace root
     * when open, else the config/home dir) before the RPC call, so the backend
     * receives an absolute path and does not need workspace knowledge.
     */
    cwd: string;
    /** Timeout in ms. Defaults to RUN_COMMAND_DEFAULT_TIMEOUT_MS on the backend. */
    timeout?: number;
}

/** The result of a finished (or timed-out / killed) command. */
export interface RunCommandResult {
    /** Captured standard output (already UTF-8 decoded and length-bounded). */
    stdout: string;
    /** Captured standard error (already UTF-8 decoded and length-bounded). */
    stderr: string;
    /**
     * Process exit code. `-1` when the command was killed for exceeding the
     * timeout (a `[timeout]` note is also appended to stderr).
     */
    exitCode: number;
    /** True when stdout/stderr were cut to the output cap. */
    truncated?: boolean;
    /** True when the process (tree) was killed for exceeding the timeout. */
    timedOut?: boolean;
}

/**
 * The backend service the frontend calls over JSON-RPC. A single method keeps
 * the RPC surface minimal; the frontend ToolProvider builds the request and
 * formats the result for the model.
 */
export interface CommandRunnerService {
    runCommand(request: RunCommandRequest): Promise<RunCommandResult>;
}
