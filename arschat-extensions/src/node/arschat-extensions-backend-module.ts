import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import {
    arschatExtensionFetchServicePath,
    ExtensionFetchService
} from '../common/extension-fetch-protocol';
import { ExtensionFetchServiceImpl } from './extension-fetch-service-impl';

export default new ContainerModule(bind => {
    bind(ExtensionFetchService).to(ExtensionFetchServiceImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(
            arschatExtensionFetchServicePath,
            () => ctx.container.get<ExtensionFetchService>(ExtensionFetchService)
        )
    ).inSingletonScope();
});
