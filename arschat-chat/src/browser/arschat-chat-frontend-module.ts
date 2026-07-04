// *****************************************************************************
// ArsChat chat extension - frontend DI module.
//
// Registers (M3):
//   - the chat ReactWidget + its WidgetFactory (main-area chat surface)
//   - the view contribution that forces it into the main area on startup
//   - the history panel ReactWidget + WidgetFactory + its (left-area) view
//     contribution
//   - the ArschatChatUiService that decouples the two views
//   - the custom ChatResponsePartRenderer (informational content)
//   - the M3 autotest (flag-gated: ARSCHAT_M3_AUTOTEST=1) which registers a mock
//     LanguageModel and drives a streaming round-trip + persistence checks
//
// The IDE-dilution FilterContribution and the PoC autotest contributions live in
// arschat-branding ("the app skin"). This module is the chat + history views.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ArschatChatContribution } from './arschat-chat-contribution';
import { ArschatHistoryWidget } from './arschat-history-widget';
import { ArschatHistoryContribution } from './arschat-history-contribution';
import { ArschatChatUiService } from './arschat-chat-ui-service';
import { ArschatInformationalPartRenderer } from './arschat-informational-part-renderer';
import { ArschatM3AutotestContribution } from './arschat-m3-autotest-contribution';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';

import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    // Shared coordination service (chat widget <-> history panel).
    bind(ArschatChatUiService).toSelf().inSingletonScope();

    // Main-area chat widget.
    bindViewContribution(bind, ArschatChatContribution);
    bind(FrontendApplicationContribution).toService(ArschatChatContribution);
    bind(ArschatChatWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatChatWidget.ID,
        createWidget: () => ctx.container.get<ArschatChatWidget>(ArschatChatWidget)
    })).inSingletonScope();

    // Left-sidebar history panel.
    bindViewContribution(bind, ArschatHistoryContribution);
    bind(FrontendApplicationContribution).toService(ArschatHistoryContribution);
    bind(ArschatHistoryWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatHistoryWidget.ID,
        createWidget: () => ctx.container.get<ArschatHistoryWidget>(ArschatHistoryWidget)
    })).inSingletonScope();

    // Custom ChatResponsePartRenderer (see arschat-informational-part-renderer.tsx).
    bind(ArschatInformationalPartRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(ArschatInformationalPartRenderer);

    // M3 autotest (no-op unless ARSCHAT_M3_AUTOTEST=1).
    bind(ArschatM3AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM3AutotestContribution);
});
