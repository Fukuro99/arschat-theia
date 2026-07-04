/**
 * This file can be edited to customize webpack configuration.
 * To reset delete this file and rerun theia build again.
 */
// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');

/**
 * Expose bundled modules on window.theia.moduleName namespace, e.g.
 * window['theia']['@theia/core/lib/common/uri'].
 * Such syntax can be used by external code, for instance, for testing.
configs[0].module.rules.push({
    test: /\.js$/,
    loader: require.resolve('@theia/application-manager/lib/expose-loader')
}); */

// PoC-3: @vscode/windows-ca-certs is an OPTIONAL native addon used only by
// @vscode/proxy-agent to read the Windows certificate store for HTTPS proxy
// resolution (used transitively by @theia/vsx-registry when installing from
// Open VSX through a corporate proxy). Its native build requires MSVC
// "Spectre-mitigated" libraries that are not installed in this environment,
// so the module is absent from node_modules. gen-webpack.node.config.js only
// adds it to the IgnorePlugin list when process.platform !== 'win32', so on
// Windows webpack tries to statically resolve it and fails. The caller
// (@vscode/proxy-agent's getCaCertificates) already wraps the call in a
// .catch() that logs and falls back to `undefined`, so ignoring the module
// unconditionally is safe here (no corporate TLS-intercepting proxy in this
// PoC environment). This does not modify Theia itself (node_modules), only
// our own generated-webpack customization hook.
nodeConfig.ignoredResources.add('@vscode/windows-ca-certs');
nodeConfig.ignoredResources.add('@vscode/windows-ca-certs/build/Release/crypt32.node');

module.exports = [
    ...configs,
    nodeConfig.config
];
