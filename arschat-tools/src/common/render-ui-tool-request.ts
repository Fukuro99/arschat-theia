// *****************************************************************************
// arschat_render_ui ToolRequest factory (MS13).
//
// The browser provider injects ArschatUiInteractionService as the backend. The
// handler intentionally stays pending until the chat widget resolves the matching
// toolCallId with submitted form data.
// *****************************************************************************

import type { CancellationToken } from '@theia/core/lib/common/cancellation';
import type { ToolCallResult, ToolInvocationContext, ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { isCancelledError, parseToolArgs, toolError } from './tool-args';
import { ARSCHAT_TOOL_PROVIDER_NAME, RENDER_UI_TOOL_ID } from './tool-ids';

export interface RenderUiToolBackend {
    awaitInteraction(toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult>;
    awaitLiveInteraction(uiId: string, toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult>;
}

export interface RenderUiArgs {
    id: string;
    mode?: 'default' | 'live';
    title?: string;
    state?: Record<string, unknown>;
    root: unknown;
    actions?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateRenderUiArgs(args: Partial<RenderUiArgs>): { ok: true; value: RenderUiArgs } | { ok: false; error: string } {
    if (!args.id || typeof args.id !== 'string') {
        return { ok: false, error: 'arschat_render_ui requires a non-empty string "id".' };
    }
    if (args.mode !== undefined && args.mode !== 'default' && args.mode !== 'live') {
        return { ok: false, error: 'arschat_render_ui mode must be "default" or "live".' };
    }
    if (!isRecord(args.root)) {
        return { ok: false, error: 'arschat_render_ui requires an object "root" UI node.' };
    }
    const primitive = (args.root as { primitive?: unknown }).primitive;
    if (typeof primitive !== 'string' || !primitive.trim()) {
        return { ok: false, error: 'arschat_render_ui root requires a non-empty string "primitive".' };
    }
    if (args.state !== undefined && !isRecord(args.state)) {
        return { ok: false, error: 'arschat_render_ui "state" must be an object when provided.' };
    }
    if (args.actions !== undefined && !Array.isArray(args.actions)) {
        return { ok: false, error: 'arschat_render_ui "actions" must be an array when provided.' };
    }
    return {
        ok: true,
        value: {
            id: args.id,
            mode: args.mode ?? 'default',
            title: typeof args.title === 'string' ? args.title : undefined,
            state: args.state ?? {},
            root: args.root,
            actions: args.actions
        }
    };
}

export function createRenderUiTool(backend: RenderUiToolBackend): ToolRequest {
    return {
        id: RENDER_UI_TOOL_ID,
        name: RENDER_UI_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        description: 'Render an interactive UI inside the ArsChat message. Default mode returns after submit/cancel. Live mode returns on each user action and continues through arschat_update_ui.',
        // Theia runs checkAutoAction before requestUserConfirmation(), so global CONFIRM cannot park the handler before awaitInteraction().
        checkAutoAction: () => ({ action: 'allow' }),
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'Stable UI id unique within the current conversation.'
                },
                mode: {
                    type: 'string',
                    enum: ['default', 'live'],
                    description: 'Use "default" for submit-once forms and "live" for action/update loops.'
                },
                title: {
                    type: 'string',
                    description: 'Optional short title shown above the UI.'
                },
                state: {
                    type: 'object',
                    description: 'Initial state object. Inputs bind into this object by dot path.'
                },
                root: {
                    type: 'object',
                    description: 'Root UI node: { primitive, id?, props?, bind?, showIf?, children? }.'
                },
                actions: {
                    type: 'array',
                    description: 'Submit/cancel/custom action buttons for default mode.'
                }
            },
            required: ['id', 'root']
        },
        handler: async (argString: string, ctx?: ToolInvocationContext) => {
            const validation = validateRenderUiArgs(parseToolArgs<RenderUiArgs>(argString));
            if (!validation.ok) {
                return toolError(validation.error);
            }
            const toolCallId = ctx?.toolCallId;
            if (!toolCallId) {
                return toolError('arschat_render_ui requires a tool invocation context with toolCallId.');
            }
            try {
                if (validation.value.mode === 'live') {
                    return await backend.awaitLiveInteraction(validation.value.id, toolCallId, ctx?.cancellationToken);
                }
                return await backend.awaitInteraction(toolCallId, ctx?.cancellationToken);
            } catch (e) {
                if (isCancelledError(e)) {
                    return { cancelled: true };
                }
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}
