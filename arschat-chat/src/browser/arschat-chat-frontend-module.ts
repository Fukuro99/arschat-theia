// *****************************************************************************
// ArsChat chat extension - frontend DI module.
//
// Moved here from arschat-core during the M1 package re-org. Registers:
//   - the chat ReactWidget + its WidgetFactory (main-area chat surface)
//   - the view contribution that forces it into the main area on startup
//   - the custom ChatResponsePartRenderer (informational content)
//
// The IDE-dilution FilterContribution and the PoC autotest contributions that
// used to live alongside these in arschat-core now live in arschat-branding
// ("the app skin"). This module is purely the chat view.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ArschatChatContribution } from './arschat-chat-contribution';
import { ArschatInformationalPartRenderer } from './arschat-informational-part-renderer';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';

import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    bindViewContribution(bind, ArschatChatContribution);
    bind(FrontendApplicationContribution).toService(ArschatChatContribution);
    bind(ArschatChatWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatChatWidget.ID,
        createWidget: () => ctx.container.get<ArschatChatWidget>(ArschatChatWidget)
    })).inSingletonScope();

    // Custom ChatResponsePartRenderer (see arschat-informational-part-renderer.tsx
    // for why this content type was chosen and what it proves).
    bind(ArschatInformationalPartRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(ArschatInformationalPartRenderer);
});
