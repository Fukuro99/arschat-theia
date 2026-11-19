import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import { ArschatKeyStoreServiceImpl } from './arschat-key-store-service-impl';
import { ArschatKeychainStatusService, arschatKeychainStatusPath } from '../common/arschat-keychain-status-service';
import { ArschatKeychainStatusServiceImpl } from './arschat-keychain-status-service-impl';
import { LanguageModelProvider } from '@theia/ai-core';
import { CliAgentService, cliAgentServicePath } from '../common/cli-agents';
import { CliAgentLanguageModel, CliAgentServiceImpl } from './cli-agent-service';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    // Theia loads backendApplicationModule before extension backend modules.
    // Fail closed if that order changes; never leave the credential RPC on another instance.
    if (!isBound(KeyStoreService)) {
        throw new Error('ArsChat requires the core KeyStoreService binding before its backend module.');
    }
    rebind(KeyStoreService).to(ArschatKeyStoreServiceImpl).inSingletonScope();
    bind(CliAgentServiceImpl).toSelf().inSingletonScope();
    bind(CliAgentService).toService(CliAgentServiceImpl);
    bind(LanguageModelProvider).toDynamicValue(ctx => async () => {
        const service = ctx.container.get(CliAgentServiceImpl);
        return [new CliAgentLanguageModel('codex-cli', service), new CliAgentLanguageModel('claude-code-cli', service)];
    });
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(
        cliAgentServicePath, () => ctx.container.get<CliAgentService>(CliAgentService)
    )).inSingletonScope();
    bind(ArschatKeychainStatusService).to(ArschatKeychainStatusServiceImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(
        arschatKeychainStatusPath,
        () => ctx.container.get<ArschatKeychainStatusService>(ArschatKeychainStatusService)
    )).inSingletonScope();
});
