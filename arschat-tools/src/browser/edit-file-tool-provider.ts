// *****************************************************************************
// edit_file ToolProvider (PHASE1_DESIGN.md §7, M5 e-2).
//
// Thin @injectable @theia/ai-core ToolProvider wrapper: getTool() delegates to
// the pure createEditFileTool() factory (../common/file-tool-requests.ts). The
// edit transformation itself is the pure, unit-tested applyEdit() in
// ../common/edit-file.ts; ArschatFileToolsService reads the file, applies it,
// and writes the result back. Registered via bindToolProvider() in
// arschat-tools-frontend-module.ts.
//
// Approval (e-3): edit_file mutates the disk, so its ToolRequest carries
// `confirmAlwaysAllow` (set in createEditFileTool), flipping Theia's
// ToolConfirmationManager into CONFIRM mode. Every call raises the ArsChat
// approval card and only runs after the user allows it. See
// arschat-chat-widget.tsx (tool call cards) and BUILD_NOTES.md.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { ArschatFileToolsService } from './arschat-file-tools-service';
import { createEditFileTool } from '../common/file-tool-requests';

@injectable()
export class EditFileToolProvider implements ToolProvider {

    @inject(ArschatFileToolsService)
    protected readonly files!: ArschatFileToolsService;

    getTool(): ToolRequest {
        return createEditFileTool(this.files);
    }
}
