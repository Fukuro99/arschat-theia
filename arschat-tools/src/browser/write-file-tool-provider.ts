// *****************************************************************************
// write_file ToolProvider (PHASE1_DESIGN.md §7, M5 e-2).
//
// Thin @injectable @theia/ai-core ToolProvider wrapper: getTool() delegates to
// the pure createWriteFileTool() factory (../common/file-tool-requests.ts).
// Registered via bindToolProvider() in arschat-tools-frontend-module.ts.
//
// Approval (INTERIM - e-3 will replace this): write_file mutates the disk and
// therefore SHOULD require user confirmation. For M5 e-2 the ToolRequest
// deliberately does NOT set `confirmAlwaysAllow`, so under Theia 1.71.2's
// default confirmation mode (ALWAYS_ALLOW for normal tools) it runs UNCONFIRMED.
// This is the documented e-2 stopgap so the read/write/edit path works
// end-to-end now; the approval UI / confirmation policy lands in e-3. See
// BUILD_NOTES.md.
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
