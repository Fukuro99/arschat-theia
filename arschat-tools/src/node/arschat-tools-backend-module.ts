// *****************************************************************************
// ArsChat tools extension - backend (node) DI module (PHASE1_DESIGN.md §7, M5 e-4).
//
// Exposes the arschat-tools *backend* services to the frontend over JSON-RPC.
// These are the node-side tools (e-2/e-3 were frontend-only):
//   - run_command (e-4): command execution needs Node.
//   - web_search / fetch_page (e-5): network I/O + Turndown need Node (and Node's
//     fetch sidesteps the browser CORS wall).
// So they cannot live in the browser bundle.
//
// Wiring follows Theia's own @theia/file-search FileSearchService pattern
// (backend-application-module precedent, verified against 1.71.2 sources), one
// service per JSON-RPC path:
//   1. bind each service impl to its DI symbol (singleton),
//   2. contribute a ConnectionHandler as an RpcConnectionHandler on that
//      service's path that hands the impl to each connecting frontend.
// Adding a service = binding it + one more ConnectionHandler (no package wiring:
// theiaExtensions.backend was declared for e-4). The frontend counterparts
// (browser/*-tool-provider.ts + the frontend module) create proxies from the
// same paths via RemoteConnectionProvider.
//
// Declared in package.json theiaExtensions as { "backend": "lib/node/..." },
// mirroring how arschat-branding declares its electronMain module.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { CommandRunnerService, commandRunnerServicePath } from '../common/command-runner-protocol';
import { CommandRunnerServiceImpl } from './command-runner-service-impl';
import { WebFetchService, webFetchServicePath } from '../common/web-fetch-protocol';
import { WebFetchServiceImpl } from './web-fetch-service-impl';

export default new ContainerModule(bind => {
    // e-4: run_command backend.
    bind(CommandRunnerService).to(CommandRunnerServiceImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(
            commandRunnerServicePath,
            () => ctx.container.get<CommandRunnerService>(CommandRunnerService)
        )
    ).inSingletonScope();

    // e-5: web_search / fetch_page backend.
    bind(WebFetchService).to(WebFetchServiceImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(
            webFetchServicePath,
            () => ctx.container.get<WebFetchService>(WebFetchService)
        )
    ).inSingletonScope();
});
