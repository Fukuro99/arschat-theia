// *****************************************************************************
// ArsChat custom chat response part renderer (PoC-4 4-3, preserved through M1).
//
// Moved here from arschat-core during the M1 package re-org. It belongs with
// the chat package because it is chat-response rendering. Kept as-is (still a
// regression asset) - the real custom rendering work is M3 (PHASE1_DESIGN.md
// §5). This proves a bespoke React component can plug into Theia AI's chat
// response rendering extension point (`ChatResponsePartRenderer`) with no
// Theia core changes.
//
// Target content type: `InformationalChatResponseContent` (kind:
// 'informational'). Theia AI's own `MarkdownPartRenderer` claims this kind
// (canHandle() returns 10) but its `render()` intentionally returns `null`
// for it (see the "TODO let the user configure whether they want to see
// informational content" comment in
// node_modules/@theia/ai-chat-ui/lib/browser/chat-response-renderer/markdown-part-renderer.js).
// So informational content is silently swallowed by default. Registering this
// renderer with a strictly higher canHandle() score (11 > 10) wins the
// "highest score" selection, and an ArsChat-branded component actually paints
// what upstream drops on the floor.
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
