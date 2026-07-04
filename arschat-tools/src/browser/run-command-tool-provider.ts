// *****************************************************************************
// run_command ToolProvider (PHASE1_DESIGN.md §7, M5 e-4).
//
// Thin @injectable @theia/ai-core ToolProvider: getTool() delegates to the pure
// createRunCommandTool() factory (../common/command-tool-request.ts). Unlike the
// file tools, the actual work happens on the *backend* — this provider owns two
// responsibilities on the frontend side:
//   1. resolveCwd(): map the caller-supplied (or omitted) cwd to an absolute FS
//      path using WorkspaceService (workspace root when open, else home), so the
//      backend receives a concrete directory and needs no workspace knowledge.
//   2. run(): forward to the CommandRunnerService JSON-RPC proxy (bound in the
//      frontend module from commandRunnerServicePath).
//
// Approval: run_command's ToolRequest carries `confirmAlwaysAllow` (see
// command-tool-request.ts / run-command.ts), so Theia's ToolConfirmationManager
// forces CONFIRM mode and the ArsChat approval card (arschat-chat) gates every
// call — identical to the write tools from e-3.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { CommandToolBackend, createRunCommandTool } from '../common/command-tool-request';
import { CommandRunnerService, RunCommandResult } from '../common/command-runner-protocol';

@injectable()
export class RunCommandToolProvider implements ToolProvider, CommandToolBackend {

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(CommandRunnerService)
    protected readonly runner!: CommandRunnerService;

    getTool(): ToolRequest {
        return createRunCommandTool(this);
    }

    // --------------------------------------------------------------- backend

    /**
     * Resolve the working directory for the command:
     *  - absolute path / file:// URI -> used verbatim,
     *  - relative path -> resolved against the first workspace root,
     *  - omitted -> the first workspace root, or the user's home dir when no
     *    folder is open (so run_command still works with no workspace).
     */
    async resolveCwd(cwd: string | undefined): Promise<string> {
        const base = await this.baseUri();
        if (!cwd || !cwd.trim()) {
            return base.path.fsPath();
        }
        const trimmed = cwd.trim();
        if (this.isAbsolute(trimmed)) {
            const uri = trimmed.includes('://') ? new URI(trimmed) : URI.fromFilePath(trimmed);
            return uri.path.fsPath();
        }
        return base.resolve(trimmed).path.fsPath();
    }

    async run(command: string, cwd: string, timeout?: number): Promise<RunCommandResult> {
        return this.runner.runCommand({ command, cwd, timeout });
    }

    protected isAbsolute(path: string): boolean {
        return path.startsWith('/')
            || path.includes('://')
            || /^[a-zA-Z]:[\\/]/.test(path);
    }

    protected async baseUri(): Promise<URI> {
        const roots = this.workspaceService.tryGetRoots();
        if (roots.length > 0) {
            return roots[0].resource;
        }
        const home = await this.envServer.getHomeDirUri();
        return new URI(home);
    }
}
