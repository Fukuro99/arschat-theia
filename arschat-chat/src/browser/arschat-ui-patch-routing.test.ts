import 'reflect-metadata';
import { ArschatChatWidget } from './arschat-chat-widget';
import {
    RENDER_INTERACTIVE_HTML_TOOL_ID,
    RENDER_UI_TOOL_ID
} from 'arschat-tools/lib/common/tool-ids';

describe('ArschatChatWidget UI patch routing', () => {
    it('routes update_ui patches to live primitive state and interactive iframe postMessage', () => {
        const widget = Object.create(ArschatChatWidget.prototype) as any;
        widget.update = jest.fn();
        widget.pendingSandboxPatches = new Map();
        widget.sandboxIframes = new Map();
        const postMessage = jest.fn();
        widget.sandboxIframes.set('html-1', { contentWindow: { postMessage } });
        const liveView = {
            content: {
                name: RENDER_UI_TOOL_ID,
                arguments: JSON.stringify({
                    id: 'live-1',
                    mode: 'live',
                    state: { nested: { a: 1, keep: true }, list: [1] },
                    root: { primitive: 'box' }
                })
            },
            state: 'done',
            uiLiveState: { nested: { a: 1, keep: true }, list: [1] },
            uiWaitingForPatch: true
        };
        const htmlView = {
            content: {
                name: RENDER_INTERACTIVE_HTML_TOOL_ID,
                arguments: JSON.stringify({ id: 'html-1', html: '<button>Go</button>' })
            },
            state: 'done',
            uiWaitingForPatch: true
        };
        widget.messages = [{ toolCalls: [liveView, htmlView] }];

        widget.onUiPatch('live-1', { nested: { a: 2 }, list: [2, 3] });
        expect(liveView.uiLiveState).toEqual({ nested: { a: 2, keep: true }, list: [2, 3] });
        expect(liveView.uiWaitingForPatch).toBe(false);

        widget.onUiPatch('html-1', { screen: 'next' });
        expect(postMessage).toHaveBeenCalledWith({
            type: 'interactive-ui-update',
            uiId: 'html-1',
            patch: { screen: 'next' }
        }, '*');
        expect(htmlView.uiWaitingForPatch).toBe(false);
    });

    it('marks routed UIs finished when a patch sets status finished', () => {
        const widget = Object.create(ArschatChatWidget.prototype) as any;
        widget.update = jest.fn();
        widget.pendingSandboxPatches = new Map();
        widget.sandboxIframes = new Map();
        const liveView: any = {
            content: {
                name: RENDER_UI_TOOL_ID,
                arguments: JSON.stringify({
                    id: 'live-1',
                    mode: 'live',
                    state: {},
                    root: { primitive: 'box' }
                })
            },
            state: 'done'
        };
        widget.messages = [{ toolCalls: [liveView] }];

        widget.onUiPatch('live-1', { status: 'finished' });
        expect(liveView.uiFinished).toBe(true);
        expect(liveView.uiLiveState).toEqual({ status: 'finished' });
    });
});
