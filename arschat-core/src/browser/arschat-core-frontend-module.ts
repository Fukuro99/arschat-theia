import { ContainerModule } from '@theia/core/shared/inversify';
import { ArschatCoreWidget } from './arschat-core-widget';
import { ArschatCoreContribution } from './arschat-core-contribution';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';

import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    bindViewContribution(bind, ArschatCoreContribution);
    bind(FrontendApplicationContribution).toService(ArschatCoreContribution);
    bind(ArschatCoreWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ArschatCoreWidget.ID,
        createWidget: () => ctx.container.get<ArschatCoreWidget>(ArschatCoreWidget)
    })).inSingletonScope();
});
