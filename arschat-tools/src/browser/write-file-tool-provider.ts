// *****************************************************************************
// write_file ToolProvider (PHASE1_DESIGN.md §7, M5 e-2).
//
// Thin @injectable @theia/ai-core ToolProvider wrapper: getTool() delegates to
// the pure createWriteFileTool() factory (../common/file-tool-requests.ts).
// Registered via bindToolProvider() in arschat-tools-frontend-module.ts.
//
// Approval (e-3): write_file mutates the disk, so its ToolRequest carries
// `confirmAlwaysAllow` (set in createWriteFileTool). That flips Theia's
// ToolConfirmationManager into CONFIRM mode, so every call raises the ArsChat
// approval card and the tool only runs after the user allows it. See
// arschat-chat-widget.tsx (tool call cards) and BUILD_NOTES.md.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { createWriteFileTool } from '../common/file-tool-requests';

@injectable()
export class WriteFileToolProvider implements ToolProvider {

    @inject(ArschatFileToolsService)
    protected readonly files!: ArschatFileToolsService;

    getTool(): ToolRequest {
        return createWriteFileTool(this.files);
    }
}
