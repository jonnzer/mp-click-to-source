const fs = require('fs');
const path = require('path');
const { transformTemplate, shouldTransformFile, DEFAULT_EXTENSIONS } = require('./transform-template');
const { ensureInspectorServer, DEFAULT_PORT } = require('./server');

const RUNTIME_MARK = '/* mp-click-to-source:runtime */';
const RUNTIME_ENTRY_CANDIDATES = ['app.js', 'common/main.js'];

let runtimeSourceCache = null;

function getRuntimeSource() {
  if (runtimeSourceCache === null) {
    runtimeSourceCache = fs.readFileSync(path.resolve(__dirname, '../runtime/miniprogram.js'), 'utf8');
  }
  return runtimeSourceCache;
}

// 把 runtime 内联为 IIFE，编译期直接注入产物入口，业务源码零改动
function buildRuntimeBanner(config) {
  return [
    RUNTIME_MARK,
    ';(function () {',
    'try {',
    'var module = { exports: {} };',
    getRuntimeSource(),
    'module.exports.installMpClickToSource(' + JSON.stringify(config || {}) + ');',
    '} catch (error) {',
    'console.warn("[mp-click-to-source] runtime install failed:", error);',
    '}',
    '})();',
    ''
  ].join('\n');
}

function isPluginEnabled(options) {
  if (options.enabled !== undefined) return !!options.enabled;
  return process.env.NODE_ENV !== 'production';
}

function createMpClickToSourceVitePlugin(options = {}) {
  if (!isPluginEnabled(options)) {
    return { name: 'mp-click-to-source' };
  }

  const root = options.root || process.cwd();
  const extensions = options.extensions || DEFAULT_EXTENSIONS;

  return {
    name: 'mp-click-to-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!shouldTransformFile(file, extensions)) return null;

      return {
        code: transformTemplate(code, {
          ...options,
          root,
          file
        }),
        map: null
      };
    }
  };
}

function createMpClickToSourceWebpackPlugin(options = {}) {
  // 生产构建硬隔离：不转换模板、不注入 runtime、不起服务
  if (!isPluginEnabled(options)) {
    return { apply() {} };
  }

  const root = options.root || process.cwd();
  const extensions = options.extensions || DEFAULT_EXTENSIONS;
  const pluginName = 'MpClickToSourceWebpackPlugin';
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || DEFAULT_PORT);
  const runtimeConfig = {
    host,
    port,
    trigger: options.trigger || 'option-click',
    ...options.runtime
  };

  let serverLogged = false;
  let serverWarned = false;
  let entryWarned = false;

  function ensureServer() {
    if (options.server === false) return;

    ensureInspectorServer({
      root,
      host,
      port,
      editor: options.editor,
      modifier: options.modifier,
      modifierGraceMs: options.modifierGraceMs
    }).then((info) => {
      if (serverLogged) return;
      serverLogged = true;
      if (info.reused) {
        console.log(`[mp-click-to-source] reusing inspector server at http://${host}:${port}` +
          (info.root && path.resolve(info.root) !== path.resolve(root)
            ? ` (warning: server root is ${info.root}, expected ${root})`
            : ''));
      } else {
        console.log(`[mp-click-to-source] inspector server listening on http://${host}:${port} (editor: ${options.editor || process.env.MP_CLICK_TO_SOURCE_EDITOR || 'code'})`);
      }
    }).catch((error) => {
      if (serverWarned) return;
      serverWarned = true;
      console.warn(`[mp-click-to-source] failed to start inspector server on ${host}:${port}:`, error.message);
    });
  }

  function injectRuntimeIntoAssets(assets, readAsset, writeAsset) {
    if (options.injectRuntime === false) return;

    const entryName = RUNTIME_ENTRY_CANDIDATES.find((name) => assets[name]);
    if (!entryName) {
      if (!entryWarned) {
        entryWarned = true;
        console.warn(`[mp-click-to-source] runtime not injected: none of ${RUNTIME_ENTRY_CANDIDATES.join(', ')} found in assets`);
      }
      return;
    }

    const current = readAsset(entryName).toString();
    if (current.includes(RUNTIME_MARK)) return;

    writeAsset(entryName, buildRuntimeBanner(runtimeConfig) + current);
  }

  return {
    apply(compiler) {
      if (options.transformVue !== false) {
        compiler.options.module = compiler.options.module || {};
        compiler.options.module.rules = compiler.options.module.rules || [];
        compiler.options.module.rules.unshift({
          test: /\.vue$/,
          enforce: 'pre',
          use: [{
            loader: path.resolve(__dirname, 'vue-sfc-loader.js'),
            options: {
              root,
              trigger: options.trigger || 'option-click',
              locOnly: options.locOnly !== false
            }
          }]
        });
      }

      ensureServer();
      if (compiler.hooks && compiler.hooks.done && typeof compiler.hooks.done.tap === 'function') {
        // watch 模式下每次编译完成都自愈一次（服务被误杀后自动拉起）
        compiler.hooks.done.tap(pluginName, () => {
          serverLogged = false;
          ensureServer();
        });
      }

      function transformAsset(assetName, rawSource) {
        const absoluteAssetPath = path.resolve(root, assetName);
        return transformTemplate(rawSource.toString(), {
          ...options,
          root,
          file: absoluteAssetPath,
          injectOverlay: options.injectOverlay !== false
        });
      }

      if (compiler.hooks.emit && !compiler.webpack) {
        // webpack4（HBuilderX / uni-app vue2 构建走这里）
        compiler.hooks.emit.tap(pluginName, (compilation) => {
          for (const assetName of Object.keys(compilation.assets)) {
            if (!shouldTransformFile(assetName, extensions)) continue;

            const asset = compilation.assets[assetName];
            const transformed = transformAsset(assetName, asset.source());
            compilation.assets[assetName] = {
              source: () => transformed,
              size: () => Buffer.byteLength(transformed)
            };
          }

          injectRuntimeIntoAssets(
            compilation.assets,
            (name) => compilation.assets[name].source(),
            (name, content) => {
              compilation.assets[name] = {
                source: () => content,
                size: () => Buffer.byteLength(content)
              };
            }
          );
        });
        return;
      }

      compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
        const { Compilation, sources } = compiler.webpack || {};
        const stage = Compilation?.PROCESS_ASSETS_STAGE_ADDITIONS || 0;

        compilation.hooks.processAssets.tap(
          { name: pluginName, stage },
          (assets) => {
            for (const assetName of Object.keys(assets)) {
              if (!shouldTransformFile(assetName, extensions)) continue;

              const asset = compilation.getAsset(assetName);
              const transformed = transformAsset(assetName, asset.source.source());

              compilation.updateAsset(
                assetName,
                sources ? new sources.RawSource(transformed) : {
                  source: () => transformed,
                  size: () => Buffer.byteLength(transformed)
                }
              );
            }

            injectRuntimeIntoAssets(
              assets,
              (name) => compilation.getAsset(name).source.source(),
              (name, content) => {
                compilation.updateAsset(
                  name,
                  sources ? new sources.RawSource(content) : {
                    source: () => content,
                    size: () => Buffer.byteLength(content)
                  }
                );
              }
            );
          }
        );
      });
    }
  };
}

module.exports = {
  RUNTIME_MARK,
  buildRuntimeBanner,
  createMpClickToSourceVitePlugin,
  createMpClickToSourceWebpackPlugin
};
