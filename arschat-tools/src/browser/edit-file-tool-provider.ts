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
// Approval (INTERIM - e-3 will replace this): edit_file mutates the disk. As
// with write_file, M5 e-2 leaves `confirmAlwaysAllow` unset so the tool runs
// UNCONFIRMED under Theia 1.71.2's default confirmation mode. This is the
// documented e-2 stopgap; the approval flow lands in e-3. See BUILD_NOTES.md.
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
