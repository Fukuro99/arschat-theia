// *****************************************************************************
// Sandbox HTML ToolRequest factories (MS13 Phase 2).
// *****************************************************************************

import type { ToolCallResult, ToolInvocationContext, ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { isCancelledError, parseToolArgs, toolError } from './tool-args';
import { ARSCHAT_TOOL_PROVIDER_NAME, RENDER_HTML_TOOL_ID, RENDER_INTERACTIVE_HTML_TOOL_ID } from './tool-ids';
import type { RenderUiToolBackend } from './render-ui-tool-request';

export interface RenderHtmlArgs {
    id: string;
    title?: string;
    html: string;
    width?: string;
    height?: string;
}

export function validateRenderHtmlArgs(args: Partial<RenderHtmlArgs>, toolId: string): { ok: true; value: RenderHtmlArgs } | { ok: false; error: string } {
    if (!args.id || typeof args.id !== 'string') {
        return { ok: false, error: `${toolId} requires a non-empty string "id".` };
    }
    if (typeof args.html !== 'string' || !args.html.trim()) {
        return { ok: false, error: `${toolId} requires a non-empty string "html".` };
    }
    return {
        ok: true,
        value: {
            id: args.id,
            html: args.html,
            title: typeof args.title === 'string' ? args.title : undefined,
            width: typeof args.width === 'string' ? args.width : undefined,
            height: typeof args.height === 'string' ? args.height : undefined
        }
    };
}

const htmlParameters: ToolRequest['parameters'] = {
    type: 'object',
    properties: {
        id: {
            type: 'string',
            description: 'Stable UI id unique within the current conversation.'
        },
        title: {
            type: 'string',
            description: 'Optional short title shown above the iframe.'
        },
        html: {
            type: 'string',
            description: 'Complete HTML document or fragment to run inside sandbox="allow-scripts".'
        },
        width: {
            type: 'string',
            description: 'Optional CSS width for the iframe, default 100%.'
        },
        height: {
            type: 'string',
            description: 'Optional CSS height for the iframe, default 400px.'
        }
    },
    required: ['id', 'html']
};

export function createRenderHtmlTool(): ToolRequest {
    return {
        id: RENDER_HTML_TOOL_ID,
        name: RENDER_HTML_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        description: 'Render display-only sandboxed HTML in an iframe using sandbox="allow-scripts". Returns immediately after rendering.',
        checkAutoAction: () => ({ action: 'allow' }),
        parameters: htmlParameters,
        handler: async (argString: string): Promise<ToolCallResult> => {
            const validation = validateRenderHtmlArgs(parseToolArgs<RenderHtmlArgs>(argString), RENDER_HTML_TOOL_ID);
            if (!validation.ok) {
                return toolError(validation.error);
            }
            return { uiId: validation.value.id, status: 'rendered' };
        }
    };
}

export function createRenderInteractiveHtmlTool(backend: RenderUiToolBackend): ToolRequest {
    return {
        id: RENDER_INTERACTIVE_HTML_TOOL_ID,
        name: RENDER_INTERACTIVE_HTML_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        description: 'Render sandboxed HTML that reports user actions via postMessage({type:"interactive-ui-action", uiId, action, data}). Returns each action as the tool result.',
        checkAutoAction: () => ({ action: 'allow' }),
        parameters: htmlParameters,
        handler: async (argString: string, ctx?: ToolInvocationContext): Promise<ToolCallResult> => {
            const validation = validateRenderHtmlArgs(parseToolArgs<RenderHtmlArgs>(argString), RENDER_INTERACTIVE_HTML_TOOL_ID);
            if (!validation.ok) {
                return toolError(validation.error);
            }
            const toolCallId = ctx?.toolCallId;
            if (!toolCallId) {
                return toolError('arschat_render_interactive_html requires a tool invocation context with toolCallId.');
            }
            try {
                return await backend.awaitLiveInteraction(validation.value.id, toolCallId, ctx?.cancellationToken);
            } catch (e) {
                if (isCancelledError(e)) {
                    return { cancelled: true };
                }
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}
