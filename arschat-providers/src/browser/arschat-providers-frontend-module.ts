// *****************************************************************************
// ArsChat providers extension - frontend DI module (PHASE1_DESIGN.md §4).
//
// M2: registers the four-provider switching machinery.
//   - ArsChat active-provider/model preferences (arschat.provider.*)
//   - ProviderSwitchService (drives the ArsChat agent's model requirement)
//   - a startup contribution that seeds the LM Studio / Unsloth OpenAI-custom
//     endpoints into `ai-features.openAiCustom.customOpenAiModels` if absent,
//     and (under ARSCHAT_M2_AUTOTEST=1) logs the registered LanguageModels and
//     runs the live round-trip / switch checks.
//
// @theia/ai-openai is added as an electron-app dependency, so its own
// frontend+backend modules auto-register (theiaExtensions). This module only
// adds ArsChat-specific bindings on top; it never touches Theia internals.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { bindArschatProviderPreferences } from './arschat-provider-preferences';
import { ProviderSwitchService } from './provider-switch-service';
import { ArschatProvidersSeedContribution } from './arschat-providers-seed-contribution';
import { ArschatM2AutotestContribution } from './arschat-m2-autotest-contribution';
import { ArschatLocalLlmAutotestContribution } from './arschat-local-llm-autotest-contribution';

export default new ContainerModule(bind => {
    bindArschatProviderPreferences(bind);

    bind(ProviderSwitchService).toSelf().inSingletonScope();

    bind(ArschatProvidersSeedContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatProvidersSeedContribution);

    bind(ArschatM2AutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatM2AutotestContribution);

    bind(ArschatLocalLlmAutotestContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ArschatLocalLlmAutotestContribution);
});
