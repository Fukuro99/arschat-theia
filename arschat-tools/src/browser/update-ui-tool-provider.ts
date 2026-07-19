// *****************************************************************************
// arschat_update_ui ToolProvider (MS13 Phase 2).
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { createUpdateUiTool } from '../common/update-ui-tool-request';
import { ArschatUiInteractionService } from './arschat-ui-interaction-service';

@injectable()
export class UpdateUiToolProvider implements ToolProvider {

    @inject(ArschatUiInteractionService)
    protected readonly interactions!: ArschatUiInteractionService;

    getTool(): ToolRequest {
        return createUpdateUiTool(this.interactions);
    }
}
