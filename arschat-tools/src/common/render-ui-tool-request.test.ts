import { ToolInvocationContext } from '@theia/ai-core/lib/common/language-model';
import { createRenderUiTool, validateRenderUiArgs } from './render-ui-tool-request';
import { RENDER_UI_TOOL_ID } from './tool-ids';

describe('arschat_render_ui tool request', () => {
    it('defines the default-mode UI schema shape', () => {
        const tool = createRenderUiTool({ awaitInteraction: async () => ({}) });
        expect(tool.id).toBe(RENDER_UI_TOOL_ID);
        expect(tool.name).toBe(RENDER_UI_TOOL_ID);
        expect(tool.parameters.required).toEqual(['id', 'root']);
        expect(tool.parameters.properties.mode.enum).toEqual(['default']);
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

    it('rejects unsupported live mode in Phase 1', () => {
        const result = validateRenderUiArgs({
            id: 'form-1',
            mode: 'live' as 'default',
            root: { primitive: 'box' }
        });
        expect(result).toEqual({ ok: false, error: 'arschat_render_ui Phase 1 only supports mode "default".' });
    });

    it('awaits the backend interaction using the toolCallId', async () => {
        const awaitInteraction = jest.fn(async () => ({ action: 'submit', data: { name: 'Ada' } }));
        const tool = createRenderUiTool({ awaitInteraction });
        const result = await tool.handler(
            JSON.stringify({ id: 'form-1', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-1')
        );
        expect(result).toEqual({ action: 'submit', data: { name: 'Ada' } });
        expect(awaitInteraction).toHaveBeenCalledWith('tc-1', undefined);
    });

    it('does not miss an interaction that resolved before the handler reaches awaitInteraction', async () => {
        const pending = new Map<string, unknown>([
            ['tc-early', { action: 'submit', data: { ready: true } }]
        ]);
        const tool = createRenderUiTool({
            awaitInteraction: async toolCallId => {
                const value = pending.get(toolCallId);
                pending.delete(toolCallId);
                return value as any;
            }
        });
        const result = await tool.handler(
            JSON.stringify({ id: 'form-1', root: { primitive: 'box' } }),
            ToolInvocationContext.create('tc-early')
        );
        expect(result).toEqual({ action: 'submit', data: { ready: true } });
    });

    it('returns an ERROR string when the invocation context has no toolCallId', async () => {
        const tool = createRenderUiTool({ awaitInteraction: async () => ({}) });
        await expect(tool.handler(JSON.stringify({ id: 'form-1', root: { primitive: 'box' } })))
            .resolves.toContain('ERROR: arschat_render_ui requires a tool invocation context with toolCallId.');
    });
});
