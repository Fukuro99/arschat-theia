// *****************************************************************************
// read_file ToolProvider (PHASE1_DESIGN.md §7, M5 e-2).
//
// Thin @injectable @theia/ai-core ToolProvider wrapper: getTool() delegates to
// the pure createReadFileTool() factory (../common/file-tool-requests.ts),
// passing the FileService-backed ArschatFileToolsService as the backend.
// Registered via bindToolProvider() in arschat-tools-frontend-module.ts.
//
// Approval: read_file is read-only, so its ToolRequest carries no
// `confirmAlwaysAllow`. Under Theia 1.71.2's default confirmation mode
// (ALWAYS_ALLOW for normal tools) it runs without a confirmation prompt. The
// real approval UI is e-3's job (see frontend module TODO / BUILD_NOTES).
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { createReadFileTool } from '../common/file-tool-requests';

@injectable()
export class ReadFileToolProvider implements ToolProvider {

    @inject(ArschatFileToolsService)
    protected readonly files!: ArschatFileToolsService;

    getTool(): ToolRequest {
        return createReadFileTool(this.files);
    }
}
