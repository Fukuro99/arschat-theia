// *****************************************************************************
// ArsChat branding - electron-main DI module.
//
// Entry point registered via `theiaExtensions[].electronMain` in
// arschat-branding/package.json. Loaded by Theia's electron-main bootstrap
// alongside `electron-main-application-module` (Theia core, unmodified).
// Moved here from arschat-core during the M1 package re-org.
//
// Two DI operations, both allowed by Theia's own extension contract:
//   - rebind(ElectronMainApplication) to our subclass, so we can override
//     `onWindowAllClosed` / `getDefaultOptions` (officially documented pattern,
//     see the class doc comment in
//     node_modules/@theia/core/lib/electron-main/electron-main-application.d.ts).
//   - bind(ElectronMainApplicationContribution) to our tray/shortcut/widget
//     contribution + the flag-gated PoC regression autotests, via the standard
//     multi-bound contribution point.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ArschatElectronMainApplication } from './arschat-electron-main-application';
import { ArschatTrayContribution } from './arschat-tray-contribution';
import { ArschatPoc1AutotestContribution } from './arschat-poc1-autotest-contribution';
import { ArschatPoc2AutotestContribution } from './arschat-poc2-autotest-contribution';
import { ArschatPoc3AutotestContribution } from './arschat-poc3-autotest-contribution';
import { ArschatPoc4AutotestContribution } from './arschat-poc4-autotest-contribution';
import { ArschatM2AutotestContribution } from './arschat-m2-autotest-contribution';
import { ArschatM3AutotestContribution } from './arschat-m3-autotest-contribution';
import { ArschatM4AutotestContribution } from './arschat-m4-autotest-contribution';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(ArschatElectronMainApplication).toSelf().inSingletonScope();
    rebind(ElectronMainApplication).toService(ArschatElectronMainApplication);

    bind(ArschatTrayContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatTrayContribution);

    bind(ArschatPoc1AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc1AutotestContribution);

    bind(ArschatPoc2AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc2AutotestContribution);

    bind(ArschatPoc3AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc3AutotestContribution);

    bind(ArschatPoc4AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatPoc4AutotestContribution);

    bind(ArschatM2AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatM2AutotestContribution);

    bind(ArschatM3AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatM3AutotestContribution);

    bind(ArschatM4AutotestContribution).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(ArschatM4AutotestContribution);
});
