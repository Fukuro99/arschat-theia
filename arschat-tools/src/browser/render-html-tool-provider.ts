// *****************************************************************************
// Sandbox HTML ToolProviders (MS13 Phase 2).
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { createRenderHtmlTool, createRenderInteractiveHtmlTool } from '../common/render-html-tool-request';
import { ArschatUiInteractionService } from './arschat-ui-interaction-service';

@injectable()
export class RenderHtmlToolProvider implements ToolProvider {

    getTool(): ToolRequest {
        return createRenderHtmlTool();
    }
}

@injectable()
export class RenderInteractiveHtmlToolProvider implements ToolProvider {

    @inject(ArschatUiInteractionService)
    protected readonly interactions!: ArschatUiInteractionService;

    getTool(): ToolRequest {
        return createRenderInteractiveHtmlTool(this.interactions);
    }
}
