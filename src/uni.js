const { createMpClickToSourceWebpackPlugin } = require('./plugins');

// uni-app (vue2/webpack) 一行接入：
//
//   // vue.config.js
//   const { withMpClickToSource } = require('mp-click-to-source/uni')
//   module.exports = withMpClickToSource({ /* 原有 vue config */ }, { root: __dirname })
//
// 默认仅在 mp-weixin + 非 production 构建下生效，生产构建原样返回配置。
function withMpClickToSource(vueConfig, options) {
  vueConfig = vueConfig || {};
  options = options || {};

  let enabled;
  if (options.enabled !== undefined) {
    enabled = !!options.enabled;
  } else {
    const platform = process.env.UNI_PLATFORM || process.env.VUE_APP_PLATFORM || '';
    const platforms = options.platforms || ['mp-weixin'];
    enabled = process.env.NODE_ENV !== 'production' && platforms.indexOf(platform) !== -1;
  }

  if (!enabled) return vueConfig;

  const plugin = createMpClickToSourceWebpackPlugin({
    root: options.root || process.env.UNI_INPUT_DIR || process.cwd(),
    ...options,
    enabled: true
  });

  const previous = vueConfig.configureWebpack;
  const merged = { ...vueConfig };

  if (typeof previous === 'function') {
    merged.configureWebpack = function configureWebpack(config) {
      const result = previous(config);
      if (result) {
        result.plugins = (result.plugins || []).concat(plugin);
        return result;
      }
      config.plugins = (config.plugins || []).concat(plugin);
      return result;
    };
  } else {
    merged.configureWebpack = {
      ...(previous || {}),
      plugins: [...((previous && previous.plugins) || []), plugin]
    };
  }

  return merged;
}

module.exports = {
  withMpClickToSource
};
