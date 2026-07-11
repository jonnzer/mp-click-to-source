const test = require('node:test');
const assert = require('node:assert/strict');
const { withMpClickToSource } = require('../src/uni');

test('returns the original config when disabled', () => {
  const vueConfig = { transpileDependencies: ['uview-ui'] };
  const merged = withMpClickToSource(vueConfig, { enabled: false });

  assert.equal(merged, vueConfig);
});

test('merges webpack plugin into object-style configureWebpack when enabled', () => {
  const marker = { name: 'existing-plugin' };
  const merged = withMpClickToSource({
    configureWebpack: { plugins: [marker] }
  }, {
    enabled: true,
    root: '/repo',
    server: false
  });

  assert.equal(merged.configureWebpack.plugins.length, 2);
  assert.equal(merged.configureWebpack.plugins[0], marker);
  assert.equal(typeof merged.configureWebpack.plugins[1].apply, 'function');
});

test('wraps function-style configureWebpack when enabled', () => {
  let receivedConfig = null;
  const merged = withMpClickToSource({
    configureWebpack(config) {
      receivedConfig = config;
    }
  }, {
    enabled: true,
    root: '/repo',
    server: false
  });

  const config = { plugins: [] };
  merged.configureWebpack(config);

  assert.equal(receivedConfig, config);
  assert.equal(config.plugins.length, 1);
  assert.equal(typeof config.plugins[0].apply, 'function');
});
