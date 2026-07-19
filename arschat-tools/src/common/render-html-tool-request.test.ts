import { ToolInvocationContext } from '@theia/ai-core/lib/common/language-model';
import {
    createRenderHtmlTool,
    createRenderInteractiveHtmlTool,
    validateRenderHtmlArgs
} from './render-html-tool-request';
import { RENDER_HTML_TOOL_ID, RENDER_INTERACTIVE_HTML_TOOL_ID } from './tool-ids';

describe('sandbox html tool requests', () => {
    it('validates sandbox html args', () => {
        expect(validateRenderHtmlArgs({ id: 'html-1', html: '<button>ok</button>' }, RENDER_HTML_TOOL_ID)).toEqual({
            ok: true,
            value: { id: 'html-1', html: '<button>ok</button>', title: undefined, width: undefined, height: undefined }
        });
        expect(validateRenderHtmlArgs({ id: 'html-1', html: '' }, RENDER_HTML_TOOL_ID)).toEqual({
            ok: false,
            error: 'arschat_render_html requires a non-empty string "html".'
        });
    });

    it('render_html returns immediately after validation', async () => {
        const tool = createRenderHtmlTool();
        expect(tool.id).toBe(RENDER_HTML_TOOL_ID);
        expect(tool.checkAutoAction?.('{}')).toEqual({ action: 'allow' });
        await expect(tool.handler(JSON.stringify({ id: 'html-1', html: '<p>hello</p>' })))
            .resolves.toEqual({ uiId: 'html-1', status: 'rendered' });
    });

    it('interactive html waits for the first postMessage action path', async () => {
        const awaitLiveInteraction = jest.fn(async () => ({ uiId: 'html-1', action: 'click', data: { ok: true } }));
        const tool = createRenderInteractiveHtmlTool({
            awaitInteraction: async () => ({}),
            awaitLiveInteraction
        });

        expect(tool.id).toBe(RENDER_INTERACTIVE_HTML_TOOL_ID);
        const result = await tool.handler(
            JSON.stringify({ id: 'html-1', html: '<button>go</button>' }),
            ToolInvocationContext.create('tc-html')
        );
        expect(result).toEqual({ uiId: 'html-1', action: 'click', data: { ok: true } });
        expect(awaitLiveInteraction).toHaveBeenCalledWith('html-1', 'tc-html', undefined);
    });

    it('interactive html returns cancelled when the backend rejects with the chat cancellation reason', async () => {
        const tool = createRenderInteractiveHtmlTool({
            awaitInteraction: async () => ({}),
            awaitLiveInteraction: async () => {
                throw new Error('Chat request canceled');
            }
        });

        await expect(tool.handler(
            JSON.stringify({ id: 'html-1', html: '<button>go</button>' }),
            ToolInvocationContext.create('tc-html-cancel')
        )).resolves.toEqual({ cancelled: true });
    });
});
