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

// Same as electron-app: @vscode/windows-ca-certs is an optional native addon
// used by @vscode/proxy-agent. This environment lacks the MSVC Spectre runtime
// needed to build crypt32.node, and proxy-agent already falls back when loading
// the optional module fails. Ignore it for the backend webpack bundle.
nodeConfig.ignoredResources.add('@vscode/windows-ca-certs');
nodeConfig.ignoredResources.add('@vscode/windows-ca-certs/build/Release/crypt32.node');

module.exports = [
    ...configs,
    nodeConfig.config
];
