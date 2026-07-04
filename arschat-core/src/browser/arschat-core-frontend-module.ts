import { ContainerModule } from '@theia/core/shared/inversify';
import { ArschatCoreWidget } from './arschat-core-widget';
import { ArschatCoreContribution } from './arschat-core-contribution';
import { ArschatMenuFilterContribution } from './arschat-ide-dilution';
import { ArschatPoc3AutotestContribution } from './arschat-poc3-autotest-contribution';
import { ArschatPoc4AutotestContribution } from './arschat-poc4-autotest-contribution';
import { ArschatInformationalPartRenderer } from './arschat-informational-part-renderer';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { FilterContribution } from '@theia/core';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';

import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    bindViewContribution(bind, ArschatCoreContribution);
    bind(FrontendApplicationContribution).toService(ArschatCoreContribution);
    bind(ArschatCoreWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatCoreWidget.ID,
        createWidget: () => ctx.container.get<ArschatCoreWidget>(ArschatCoreWidget)
    })).inSingletonScope();

    // PoC-2 (2-2): IDE-dilution - menu filtering (Selection/Go/Terminal).
    // Status bar visibility is handled declaratively via
    // electron-app/package.json `theia.frontend.config.preferences`, not here.
    bind(ArschatMenuFilterContribution).toSelf().inSingletonScope();
    bind(FilterContribution).toService(ArschatMenuFilterContribution);

    // PoC-3: flag-gated autotest helper (opens the vsx-registry Extensions
    // view programmatically in the GUI-less verification environment).
    bind(ArschatPoc3AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatPoc3AutotestContribution);

    // PoC-4 (4-3): custom ChatResponsePartRenderer contribution - see
    // arschat-informational-part-renderer.tsx for why this content type
    // (InformationalChatResponseContent) was chosen and what it proves.
    bind(ArschatInformationalPartRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(ArschatInformationalPartRenderer);

    // PoC-4: flag-gated autotest helper (checks Anthropic provider wiring +
    // MCP server start/tool listing, opens the AI chat view).
    bind(ArschatPoc4AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatPoc4AutotestContribution);
});
