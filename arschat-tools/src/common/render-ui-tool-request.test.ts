import { ToolInvocationContext } from '@theia/ai-core/lib/common/language-model';
import { CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { ArschatUiInteractionService } from '../browser/arschat-ui-interaction-service';
import { createRenderUiTool, validateRenderUiArgs } from './render-ui-tool-request';
import { RENDER_UI_TOOL_ID } from './tool-ids';

const backend = (overrides: Partial<Parameters<typeof createRenderUiTool>[0]> = {}): Parameters<typeof createRenderUiTool>[0] => ({
    awaitInteraction: async () => ({}),
    awaitLiveInteraction: async () => ({}),
    ...overrides
});

describe('arschat_render_ui tool request', () => {
    it('defines the default-mode UI schema shape', () => {
        const tool = createRenderUiTool(backend());
        expect(tool.id).toBe(RENDER_UI_TOOL_ID);
        expect(tool.name).toBe(RENDER_UI_TOOL_ID);
        expect(tool.parameters.required).toEqual(['id', 'root']);
        expect(tool.parameters.properties.mode.enum).toEqual(['default', 'live']);
        expect(tool.confirmAlwaysAllow).toBeUndefined();
        expect(tool.checkAutoAction?.('{}')).toEqual({ action: 'allow' });
    });

    it('validates a minimal default UI block', () => {
        const result = validateRenderUiArgs({
            id: 'form-1',
            root: { primitive: 'box', children: [] }
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.mode).toBe('default');
            expect(result.value.state).toEqual({});
        }
    });

    it('validates live mode in Phase 2', () => {
        const result = validateRenderUiArgs({
            id: 'form-1',
            mode: 'live' as 'default',
            root: { primitive: 'box' }
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.mode).toBe('live');
        }
    });

    it('awaits the backend interaction using the toolCallId', async () => {
        const awaitInteraction = jest.fn(async () => ({ action: 'submit', data: { name: 'Ada' } }));
        const tool = createRenderUiTool(backend({ awaitInteraction }));
        const result = await tool.handler(
            JSON.stringify({ id: 'form-1', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-1')
        );
        expect(result).toEqual({ action: 'submit', data: { name: 'Ada' } });
        expect(awaitInteraction).toHaveBeenCalledWith('tc-1', undefined);
    });

    it('returns cancelled when the backend rejects with the chat cancellation reason', async () => {
        const tool = createRenderUiTool(backend({
            awaitInteraction: async () => {
                throw new Error('Chat request canceled');
            }
        }));

        await expect(tool.handler(
            JSON.stringify({ id: 'form-1', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-cancel')
        )).resolves.toEqual({ cancelled: true });
    });

    it('does not miss an interaction that resolved before the handler reaches awaitInteraction', async () => {
        const pending = new Map<string, unknown>([
            ['tc-early', { action: 'submit', data: { ready: true } }]
        ]);
        const tool = createRenderUiTool(backend({
            awaitInteraction: async toolCallId => {
                const value = pending.get(toolCallId);
                pending.delete(toolCallId);
                return value as any;
            }
        }));
        const result = await tool.handler(
            JSON.stringify({ id: 'form-1', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-early')
        );
        expect(result).toEqual({ action: 'submit', data: { ready: true } });
    });

    it('returns an ERROR string when the invocation context has no toolCallId', async () => {
        const tool = createRenderUiTool(backend());
        await expect(tool.handler(JSON.stringify({ id: 'form-1', root: { primitive: 'box' } })))
            .resolves.toContain('ERROR: arschat_render_ui requires a tool invocation context with toolCallId.');
    });

    it('awaits live interactions by ui id and toolCallId', async () => {
        const awaitLiveInteraction = jest.fn(async () => ({ uiId: 'live-1', action: 'tap', data: {} }));
        const tool = createRenderUiTool(backend({ awaitLiveInteraction }));
        const result = await tool.handler(
            JSON.stringify({ id: 'live-1', mode: 'live', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-live')
        );
        expect(result).toEqual({ uiId: 'live-1', action: 'tap', data: {} });
        expect(awaitLiveInteraction).toHaveBeenCalledWith('live-1', 'tc-live', undefined);
    });

    it('returns cancelled for pre-cancelled live render waits', async () => {
        const service = new ArschatUiInteractionService();
        const tool = createRenderUiTool(service);
        const source = new CancellationTokenSource();
        source.cancel();

        await expect(tool.handler(
            JSON.stringify({ id: 'live-1', mode: 'live', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-live-cancel', source.token)
        )).resolves.toEqual({ cancelled: true });
    });
});
