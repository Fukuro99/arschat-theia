// *****************************************************************************
// ArsChat PoC-1: electron-main DI module.
//
// This is the entry point registered via `theiaExtensions[].electronMain` in
// arschat-core/package.json. It is loaded by Theia's electron-main bootstrap
// alongside `electron-main-application-module` (Theia core, unmodified).
//
// Two DI operations, both allowed by Theia's own extension contract:
//   - rebind(ElectronMainApplication) to our subclass, so we can override
//     `onWindowAllClosed` (see arschat-electron-main-application.ts). This is
//     the officially documented pattern (see the class doc comment in
//     node_modules/@theia/core/lib/electron-main/electron-main-application.d.ts:
//     "you can extend and rebind the `ElectronMainApplication` class").
//   - bind(ElectronMainApplicationContribution) to our tray/shortcut/widget
//     contribution, using the standard multi-bound contribution point.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ArschatElectronMainApplication } from './arschat-electron-main-application';
import { ArschatTrayContribution } from './arschat-tray-contribution';
import { ArschatPoc1AutotestContribution } from './arschat-poc1-autotest-contribution';
import { ArschatPoc2AutotestContribution } from './arschat-poc2-autotest-contribution';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(ArschatElectronMainApplication).toSelf().inSingletonScope();
    rebind(ElectronMainApplication).toService(ArschatElectronMainApplication);

    bind(ArschatTrayContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatTrayContribution);

    bind(ArschatPoc1AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc1AutotestContribution);

    bind(ArschatPoc2AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc2AutotestContribution);
});
