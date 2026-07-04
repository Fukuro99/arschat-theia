// *****************************************************************************
// ArsChat tools extension - backend (node) DI module (PHASE1_DESIGN.md §7, M5 e-4).
//
// Exposes the run_command backend (CommandRunnerServiceImpl) to the frontend over
// JSON-RPC. This is the first *backend* module in arschat-tools (e-2/e-3 were
// frontend-only): command execution needs Node, so it cannot live in the browser
// bundle.
//
// Wiring follows Theia's own @theia/file-search FileSearchService pattern
// (backend-application-module precedent, verified against 1.71.2 sources):
//   1. bind the service impl to the CommandRunnerService symbol (singleton),
//   2. contribute a ConnectionHandler as an RpcConnectionHandler on
//      `commandRunnerServicePath` that hands the impl to each connecting frontend.
// The frontend counterpart (browser/run-command-tool-provider.ts + the frontend
// module) creates a proxy from the same path via RemoteConnectionProvider.
//
// Declared in package.json theiaExtensions as { "backend": "lib/node/..." },
// mirroring how arschat-branding declares its electronMain module.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { CommandRunnerService, commandRunnerServicePath } from '../common/command-runner-protocol';
import { CommandRunnerServiceImpl } from './command-runner-service-impl';

export default new ContainerModule(bind => {
    bind(CommandRunnerService).to(CommandRunnerServiceImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(
            commandRunnerServicePath,
            () => ctx.container.get<CommandRunnerService>(CommandRunnerService)
        )
    ).inSingletonScope();
});
