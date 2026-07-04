// *****************************************************************************
// ArsChat file-tools service (PHASE1_DESIGN.md §7, M5 e-2).
//
// The single Theia-wired place that actually touches the filesystem for the
// read_file / write_file / edit_file tools. All I/O goes through Theia's
// frontend FileService (RPC to the backend fs) rather than Node `fs` directly,
// so path/URI resolution and workspace permissions follow Theia's rules
// (BUILD_NOTES / persona-service already use this same FileService pattern).
//
// Path resolution: the tools accept a `path` argument that is either
//   - absolute (starts with '/', a drive letter like 'C:...', or a URI scheme
//     such as 'file://'), used as-is, or
//   - relative, resolved against the first workspace root when one is open,
//     otherwise treated as relative to the config dir (so the tools remain
//     usable even with no folder open).
//
// The heavy lifting of the edit transformation lives in ../common/edit-file.ts
// as a pure, unit-tested function; this service is the thin FileService glue.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { applyEdit, EditFileParams, EditFileResult } from '../common/edit-file';

@injectable()
export class ArschatFileToolsService {

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    /**
     * Resolve a caller-supplied path string into a Theia URI. Absolute paths /
     * explicit URIs are used verbatim; relative paths resolve against the first
     * workspace root (or the config dir when no folder is open).
     */
    async resolvePath(path: string): Promise<URI> {
        const trimmed = path.trim();
        if (this.isAbsolute(trimmed)) {
            // A bare drive/posix path needs the file:// scheme; a full URI is kept.
            return trimmed.includes('://') ? new URI(trimmed) : URI.fromFilePath(trimmed);
        }
        const base = await this.baseUri();
        return base.resolve(trimmed);
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
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir);
    }

    // ------------------------------------------------------------------ read

    async readFile(path: string): Promise<string> {
        const uri = await this.resolvePath(path);
        if (!(await this.fileService.exists(uri))) {
            throw new Error(`File not found: ${uri.toString(true)}`);
        }
        const content = await this.fileService.read(uri);
        return content.value;
    }

    // ------------------------------------------------------------------ write

    async writeFile(path: string, content: string): Promise<{ uri: string; created: boolean }> {
        const uri = await this.resolvePath(path);
        const existed = await this.fileService.exists(uri);
        const parent = uri.parent;
        if (!(await this.fileService.exists(parent))) {
            await this.fileService.createFolder(parent);
        }
        await this.fileService.write(uri, content);
        return { uri: uri.toString(true), created: !existed };
    }

    // ------------------------------------------------------------------ edit

    async editFile(path: string, params: EditFileParams): Promise<EditFileResult & { uri: string }> {
        const uri = await this.resolvePath(path);
        if (!(await this.fileService.exists(uri))) {
            return { ok: false, content: '', replacements: 0, error: `File not found: ${uri.toString(true)}`, uri: uri.toString(true) };
        }
        const current = (await this.fileService.read(uri)).value;
        const result = applyEdit(current, params);
        if (result.ok) {
            await this.fileService.write(uri, result.content);
        }
        return { ...result, uri: uri.toString(true) };
    }
}
