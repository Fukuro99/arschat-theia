import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import {
    FrontendApplicationContribution,
    RemoteConnectionProvider,
    ServiceConnectionProvider,
    WidgetFactory,
    bindViewContribution
} from '@theia/core/lib/browser';
import { ExtensionRegistryService } from './extension-registry-service';
import { ExtensionManagerWidget } from './extension-manager-widget';
import { ExtensionManagerContribution } from './extension-manager-contribution';
import { ExtensionHostWidget } from './extension-host-widget';
import {
    arschatExtensionFetchServicePath,
    ExtensionFetchService
} from '../common/extension-fetch-protocol';

import '../../src/browser/style/index.css';

export function bindArschatExtensions(bind: interfaces.Bind): void {
    bind(ExtensionRegistryService).toSelf().inSingletonScope();

    bind(ExtensionFetchService).toDynamicValue(ctx => {
        const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<ExtensionFetchService>(arschatExtensionFetchServicePath);
    }).inSingletonScope();

    bindViewContribution(bind, ExtensionManagerContribution);
    bind(FrontendApplicationContribution).toService(ExtensionManagerContribution);
    bind(ExtensionManagerWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ExtensionManagerWidget.ID,
        createWidget: () => ctx.container.get<ExtensionManagerWidget>(ExtensionManagerWidget)
    })).inSingletonScope();

    bind(ExtensionHostWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ExtensionHostWidget.FACTORY_ID,
        createWidget: (options?: { name?: string }) => {
            const widget = ctx.container.get<ExtensionHostWidget>(ExtensionHostWidget);
            widget.setExtensionName(String(options?.name ?? ''));
            return widget;
        }
    })).inSingletonScope();
}

export default new ContainerModule(bind => {
    bindArschatExtensions(bind);
});
