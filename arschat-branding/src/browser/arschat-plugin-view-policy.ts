/** Plugin side views are denied by default; only these stock containers remain available. */
export const ALLOWED_PLUGIN_VIEW_CONTAINER_IDS: readonly string[] = Object.freeze(['explorer', 'search']);

export function isPluginViewContainerAllowed(containerId: string): boolean {
    return ALLOWED_PLUGIN_VIEW_CONTAINER_IDS.includes(containerId);
}

/** Keep suppression messages once per id for the lifetime of a registry instance. */
export function createPluginViewContainerGuard(log: (message: string) => void): (containerId: string) => boolean {
    const suppressed = new Set<string>();
    return containerId => {
        if (isPluginViewContainerAllowed(containerId)) {
            return true;
        }
        if (!suppressed.has(containerId)) {
            suppressed.add(containerId);
            log(`[arschat-dilution] plugin view container suppressed: ${containerId}`);
        }
        return false;
    };
}
