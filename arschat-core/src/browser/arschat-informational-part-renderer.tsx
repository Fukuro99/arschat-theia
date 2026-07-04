// *****************************************************************************
// ArsChat PoC-4 (4-3): custom chat response part renderer.
//
// Demonstrates plugging a bespoke React component into Theia AI's chat
// response rendering extension point (`ChatResponsePartRenderer`, see
// node_modules/@theia/ai-chat-ui/lib/browser/chat-response-part-renderer.d.ts).
// This is a plain multi-bound contribution point
// (`bindRootContributionProvider(bind, ChatResponsePartRenderer)` in
// ai-chat-ui-frontend-module.js) - no Theia core changes required.
//
// Target content type: `InformationalChatResponseContent` (kind:
// 'informational'). Chosen deliberately because Theia AI's own built-in
// `MarkdownPartRenderer` already claims this kind (canHandle() returns 10)
// but its `render()` intentionally returns `null` for it - see the
// "TODO let the user configure whether they want to see informational
// content" comment in
// node_modules/@theia/ai-chat-ui/lib/browser/chat-response-renderer/markdown-part-renderer.js.
// In other words: informational content is silently swallowed by default.
// By registering `ArschatInformationalPartRenderer` with a strictly higher
// `canHandle()` score (11 > 10), it wins the "highest score" selection Theia
// AI uses to pick a renderer per content part, and an ArsChat-branded React
// component actually paints the content that upstream drops on the floor.
// This is proof, not decoration: without this contribution the informational
// part renders as nothing at all.
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { ChatResponseContent } from '@theia/ai-chat/lib/common';
import { InformationalChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { OpenerService } from '@theia/core/lib/browser';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import { useMarkdownRendering } from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/markdown-part-renderer';

@injectable()
export class ArschatInformationalPartRenderer implements ChatResponsePartRenderer<InformationalChatResponseContent> {

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    canHandle(response: ChatResponseContent): number {
        if (InformationalChatResponseContent.is(response)) {
            // Strictly higher than MarkdownPartRenderer's 10 for the same
            // 'informational' kind, so this contribution wins and its
            // render() (which actually paints something) is used instead of
            // the built-in no-op.
            return 11;
        }
        return -1;
    }

    render(response: InformationalChatResponseContent, _parentNode: ResponseNode): React.ReactNode {
        return <ArschatInformationalBadge response={response} openerService={this.openerService} />;
    }
}

const ArschatInformationalBadge = (
    { response, openerService }: { response: InformationalChatResponseContent; openerService: OpenerService }
) => {
    const ref = useMarkdownRendering(response.content, openerService, true);
    return (
        <div className='arschat-informational-part'>
            <span className='arschat-informational-part-icon codicon codicon-info' />
            <div className='arschat-informational-part-body' ref={ref} />
        </div>
    );
};
