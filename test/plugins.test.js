const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUNTIME_MARK,
  buildRuntimeBanner,
  createMpClickToSourceWebpackPlugin
} = require('../src/plugins');

function createWebpack4Compiler() {
  const hooks = {
    emit: {
      tap(name, fn) {
        hooks.emit.fn = fn;
      }
    },
    done: {
      tap() {}
    },
    thisCompilation: {
      tap() {}
    }
  };

  return {
    hooks,
    options: {}
  };
}

function createAsset(content) {
  return {
    source: () => content,
    size: () => Buffer.byteLength(content)
  };
}

test('runtime banner embeds marker, runtime source and config', () => {
  const banner = buildRuntimeBanner({ host: '127.0.0.1', port: 12345, trigger: 'option-click' });

  assert.ok(banner.startsWith(RUNTIME_MARK));
  assert.match(banner, /installMpClickToSource\(\{"host":"127\.0\.0\.1","port":12345,"trigger":"option-click"\}\)/);
  assert.match(banner, /function installMpClickToSource/);
});

test('webpack plugin transforms wxml assets and injects runtime into app.js', () => {
  const plugin = createMpClickToSourceWebpackPlugin({
    enabled: true,
    root: '/repo',
    server: false
  });
  const compiler = createWebpack4Compiler();
  plugin.apply(compiler);

  const compilation = {
    assets: {
      'app.js': createAsset("require('./common/main.js')"),
      'pages/index/index.wxml': createAsset('<view bindtap="__e"></view>')
    }
  };
  compiler.hooks.emit.fn(compilation);

  const appJs = compilation.assets['app.js'].source();
  assert.ok(appJs.startsWith(RUNTIME_MARK));
  assert.match(appJs, /require\('\.\/common\/main\.js'\)/);

  const wxml = compilation.assets['pages/index/index.wxml'].source();
  assert.match(wxml, /data-code-loc=/);
  assert.match(wxml, /__mpCodeInspectorOverlay/);

  // 再跑一次 emit（watch 增量），runtime 不应重复注入
  compiler.hooks.emit.fn(compilation);
  const again = compilation.assets['app.js'].source();
  assert.equal(again.indexOf(RUNTIME_MARK), again.lastIndexOf(RUNTIME_MARK));
});

test('webpack plugin is a no-op in production', () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const plugin = createMpClickToSourceWebpackPlugin({ root: '/repo' });
    // no-op 插件的 apply 不应访问 compiler
    plugin.apply(null);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});
