// *****************************************************************************
// ArsChat providers extension - frontend DI module (skeleton).
//
// M1 (package re-org): this package is an empty, buildable skeleton. The real
// LLM provider registration / switching (OpenAI / Anthropic / LM Studio /
// Unsloth Studio, see PHASE1_DESIGN.md §4) lands in M2. Keeping an empty but
// registered `theiaExtensions.frontend` module here means the package is wired
// into the Theia build now, so M2 only has to add bindings - not touch the
// electron-app dependency graph again.
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';

export default new ContainerModule(() => {
    // Intentionally empty. Bindings added in M2 (PHASE1_DESIGN.md §4).
});
