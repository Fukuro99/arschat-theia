import { ContainerModule } from '@theia/core/shared/inversify';
import { ArschatCoreWidget } from './arschat-core-widget';
import { ArschatCoreContribution } from './arschat-core-contribution';
import { ArschatMenuFilterContribution } from './arschat-ide-dilution';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { FilterContribution } from '@theia/core';

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
});
