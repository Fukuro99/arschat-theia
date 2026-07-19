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
import { ArschatStatsStore } from './arschat-stats-store';
import { ArschatInformationalPartRenderer } from './arschat-informational-part-renderer';
import { ArschatM3AutotestContribution } from './arschat-m3-autotest-contribution';
import { ArschatM6AutotestContribution } from './arschat-m6-autotest-contribution';
import { ArschatM7AutotestContribution } from './arschat-m7-autotest-contribution';
import { ArschatM11AutotestContribution } from './arschat-m11-autotest-contribution';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';

import '../../src/browser/style/index.css';
import '../../src/browser/interactive-ui/styles.css';
// KaTeX stylesheet + fonts for math rendering (M6 e-23). Imported here (not in
// arschat-markdown.ts) so it is bundled by the app's webpack exactly once and the
// jsdom unit tests - which import arschat-markdown directly - never touch it.
// The app webpack handles the woff2/woff/ttf font URLs via asset/resource rules.
import 'katex/dist/katex.min.css';

export default new ContainerModule(bind => {
    // Shared coordination service (chat widget <-> history panel).
    bind(ArschatChatUiService).toSelf().inSingletonScope();

    // Per-message elapsed-time store backing the stats bar (M6 e-25).
    bind(ArschatStatsStore).toSelf().inSingletonScope();

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

    // M6 autotest (no-op unless ARSCHAT_M6_AUTOTEST=1): verifies the M6 "見た目"
    // features (IDE dilution, code highlight, KaTeX, message action bar, stats bar).
    bind(ArschatM6AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM6AutotestContribution);

    // M7/MS8 autotest (no-op unless ARSCHAT_M7_AUTOTEST=1): verifies edit,
    // continue, and branch through the real chat widget DOM.
    bind(ArschatM7AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM7AutotestContribution);

    // M11 autotest (no-op unless ARSCHAT_M11_AUTOTEST=1): verifies the chat
    // header terminal toggle button expands and collapses Theia's bottom panel.
    bind(ArschatM11AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM11AutotestContribution);
});
