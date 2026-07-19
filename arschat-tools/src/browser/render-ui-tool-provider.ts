// *****************************************************************************
// arschat_render_ui ToolProvider (MS13 Phase 1).
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { createRenderUiTool } from '../common/render-ui-tool-request';
import { ArschatUiInteractionService } from './arschat-ui-interaction-service';

@injectable()
export class RenderUiToolProvider implements ToolProvider {

    @inject(ArschatUiInteractionService)
    protected readonly interactions!: ArschatUiInteractionService;

    getTool(): ToolRequest {
        return createRenderUiTool(this.interactions);
    }
}
