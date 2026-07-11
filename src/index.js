const { transformTemplate, shouldTransformFile } = require('./transform-template');
const {
  RUNTIME_MARK,
  buildRuntimeBanner,
  createMpClickToSourceVitePlugin,
  createMpClickToSourceWebpackPlugin
} = require('./plugins');
const { transformVueSfc } = require('./transform-vue-sfc');
const {
  DEFAULT_PORT,
  DEFAULT_MODIFIER,
  createInspectorServer,
  startInspectorServer,
  ensureInspectorServer
} = require('./server');
const {
  normalizeModifier,
  isModifierPressed,
  createModifierMonitor
} = require('./modifier-state');
const { withMpClickToSource } = require('./uni');

module.exports = {
  DEFAULT_PORT,
  DEFAULT_MODIFIER,
  RUNTIME_MARK,
  transformTemplate,
  transformVueSfc,
  shouldTransformFile,
  buildRuntimeBanner,
  createMpClickToSourceVitePlugin,
  createMpClickToSourceWebpackPlugin,
  createInspectorServer,
  startInspectorServer,
  ensureInspectorServer,
  normalizeModifier,
  isModifierPressed,
  createModifierMonitor,
  withMpClickToSource
};
