const test = require('node:test');
const assert = require('node:assert/strict');
const { transformVueSfc } = require('../src/transform-vue-sfc');
const vueSfcLoader = require('../src/vue-sfc-loader');

test('injects source metadata into vue sfc template with vue file line numbers', () => {
  const input = [
    '<template>',
    '  <view class="page">',
    '    <text>{{ title }}</text>',
    '  </view>',
    '</template>',
    '',
    '<script>',
    'export default {}',
    '</script>'
  ].join('\n');

  const output = transformVueSfc(input, {
    root: '/repo',
    file: '/repo/pages/index/index.vue'
  });

  assert.match(output, /data-code-loc="pages\/index\/index\.vue:2:3"/);
  assert.match(output, /data-code-loc="pages\/index\/index\.vue:3:5"/);
  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
});

test('webpack loader defaults to locOnly so vue templates stay clean', () => {
  const input = [
    '<template>',
    '  <view class="page" @click="go">',
    '    <text>{{ title }}</text>',
    '  </view>',
    '</template>'
  ].join('\n');

  const output = vueSfcLoader.call({
    getOptions: () => ({ root: '/repo' }),
    resourcePath: '/repo/pages/index/index.vue'
  }, input);

  assert.match(output, /data-code-loc="pages\/index\/index\.vue:2:3"/);
  assert.match(output, /data-code-loc="pages\/index\/index\.vue:3:5"/);
  assert.doesNotMatch(output, /capture-bind:tap/);
  assert.doesNotMatch(output, /mpcts-target/);
});

test('keeps injecting vue locations after nested template branches', () => {
  const input = [
    '<template>',
    '  <view class="before" />',
    '  <template v-if="score > 0">',
    '    <text class="positive">positive</text>',
    '  </template>',
    '  <!-- a fake </template> in a comment must not close the SFC block -->',
    '  <template v-else>',
    '    <text class="empty">empty</text>',
    '  </template>',
    '  <view class="after" />',
    '</template>',
    '',
    '<script>',
    'export default {}',
    '</script>'
  ].join('\n');

  const output = transformVueSfc(input, {
    root: '/repo',
    file: '/repo/pages/nested/nested.vue',
    locOnly: true
  });

  assert.match(output, /class="before"\s+data-code-loc="pages\/nested\/nested\.vue:2:3"/);
  assert.match(output, /class="positive" data-code-loc="pages\/nested\/nested\.vue:4:5"/);
  assert.match(output, /class="empty" data-code-loc="pages\/nested\/nested\.vue:8:5"/);
  assert.match(output, /class="after"\s+data-code-loc="pages\/nested\/nested\.vue:10:3"/);
  assert.match(output, /<script>\nexport default \{\}\n<\/script>$/);
});
