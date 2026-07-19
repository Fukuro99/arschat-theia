// *****************************************************************************
// arschat_update_ui ToolRequest factory (MS13 Phase 2).
// *****************************************************************************

import type { CancellationToken } from '@theia/core/lib/common/cancellation';
import type { ToolCallResult, ToolInvocationContext, ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { isCancelledError, parseToolArgs, toolError } from './tool-args';
import { ARSCHAT_TOOL_PROVIDER_NAME, UPDATE_UI_TOOL_ID } from './tool-ids';

export interface UpdateUiToolBackend {
    applyUiPatch(uiId: string, patch: Record<string, unknown>): { status?: string; error?: string };
    awaitLiveInteraction(uiId: string, toolCallId: string, cancellationToken?: CancellationToken): Promise<ToolCallResult>;
}

export interface UpdateUiArgs {
    ui_id?: string;
    id?: string;
    patch: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateUpdateUiArgs(args: Partial<UpdateUiArgs>): { ok: true; uiId: string; patch: Record<string, unknown> } | { ok: false; error: string } {
    const uiId = typeof args.ui_id === 'string' ? args.ui_id : args.id;
    if (!uiId || typeof uiId !== 'string') {
        return { ok: false, error: 'arschat_update_ui requires a non-empty string "ui_id".' };
    }
    if (!isRecord(args.patch)) {
        return { ok: false, error: 'arschat_update_ui requires an object "patch".' };
    }
    return { ok: true, uiId, patch: args.patch };
}

export function createUpdateUiTool(backend: UpdateUiToolBackend): ToolRequest {
    return {
        id: UPDATE_UI_TOOL_ID,
        name: UPDATE_UI_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        description: 'Apply a patch to a live or interactive-html UI, then wait for the next user action unless the patch sets status:"finished".',
        checkAutoAction: () => ({ action: 'allow' }),
        parameters: {
            type: 'object',
            properties: {
                ui_id: {
                    type: 'string',
                    description: 'The UI id originally passed to arschat_render_ui or arschat_render_interactive_html.'
                },
                patch: {
                    type: 'object',
                    description: 'Patch to apply. Objects merge recursively; arrays replace. status:"finished" ends the UI.'
                }
            },
            required: ['ui_id', 'patch']
        },
        handler: async (argString: string, ctx?: ToolInvocationContext) => {
            const validation = validateUpdateUiArgs(parseToolArgs<UpdateUiArgs>(argString));
            if (!validation.ok) {
                return toolError(validation.error);
            }
            const applied = backend.applyUiPatch(validation.uiId, validation.patch);
            if (applied.error) {
                return { uiId: validation.uiId, error: applied.error, status: applied.status ?? 'finished' };
            }
            if (applied.status === 'finished' || validation.patch.status === 'finished') {
                return { uiId: validation.uiId, status: 'finished' };
            }
            const toolCallId = ctx?.toolCallId;
            if (!toolCallId) {
                return toolError('arschat_update_ui requires a tool invocation context with toolCallId.');
            }
            try {
                return await backend.awaitLiveInteraction(validation.uiId, toolCallId, ctx?.cancellationToken);
            } catch (e) {
                if (isCancelledError(e)) {
                    return { cancelled: true };
                }
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}
