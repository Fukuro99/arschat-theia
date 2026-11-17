import { injectable } from '@theia/core/shared/inversify';
import type { ViewContainer } from '@theia/core/lib/browser';
import { PluginViewRegistry } from '@theia/plugin-ext/lib/main/browser/view/plugin-view-registry';
import { createPluginViewContainerGuard } from './arschat-plugin-view-policy';

/** Preserve view/provider registration, but suppress docking of diluted plugin containers. */
@injectable()
export class ArschatPluginViewRegistry extends PluginViewRegistry {
    // Theia 1.71.2 uses an argument-free constructor, inherited property injection
    // and @postConstruct init. Do not replace any of those initialization paths.
    private readonly canOpenViewContainer = createPluginViewContainerGuard(message => console.log(message));

    override async openViewContainer(containerId: string): Promise<ViewContainer | undefined> {
        if (!this.canOpenViewContainer(containerId)) {
            return undefined;
        }
        return super.openViewContainer(containerId);
    }
}
