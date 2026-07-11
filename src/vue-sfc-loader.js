const { transformVueSfc } = require('./transform-vue-sfc');

module.exports = function mpClickToSourceVueSfcLoader(source) {
  const options = typeof this.getOptions === 'function'
    ? this.getOptions()
    : this.query || {};

  return transformVueSfc(source, {
    // 个别构建环境下 loader options 传递不可靠，兜底到 UNI_INPUT_DIR（项目源码目录）
    root: options.root || process.env.UNI_INPUT_DIR,
    file: this.resourcePath,
    trigger: options.trigger || 'option-click',
    // 默认只注入 data-code-loc（真实 .vue 行号），其余属性由 WXML 资产阶段补齐
    locOnly: options.locOnly !== false
  });
};
