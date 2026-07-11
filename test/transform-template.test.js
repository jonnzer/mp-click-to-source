const test = require('node:test');
const assert = require('node:assert/strict');
const { transformTemplate } = require('../src/transform-template');

test('injects source metadata and longpress handler into wxml nodes', () => {
  const input = [
    '<view class="page">',
    '  <text>{{title}}</text>',
    '  <image src="{{cover}}" />',
    '</view>'
  ].join('\n');

  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    trigger: 'longpress'
  });

  assert.match(output, /data-code-loc="pages\/index\/index\.wxml:1:1"/);
  assert.match(output, /capture-bind:longpress="__mpCodeInspectorLongPress"/);
  assert.match(output, /data-code-loc="pages\/index\/index\.wxml:2:3"/);
  assert.match(output, /<image[^>]+data-code-column="3"[^>]+\/>/);
});

test('defaults to option-click by injecting a capture tap handler', () => {
  const input = '<view class="page"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
  assert.doesNotMatch(output, /capture-bind:longpress/);
});

test('never intercepts business taps: only a non-blocking observer binding is added', () => {
  const input = '<view bindtap="__e" data-event-opts="{{opts}}"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  // 业务 tap 原样保留，绝不 catch / 代理 / 补发
  assert.match(output, /bindtap="__e"/);
  assert.doesNotMatch(output, /capture-catch:tap/);
  assert.doesNotMatch(output, /data-code-original-tap/);
  // 只加非阻塞观察者
  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
  assert.match(output, /data-code-id="mpcts_/);
  assert.match(output, /class="mpcts-target mpcts_/);
  assert.match(output, /capture-bind:mouseover="__mpCodeInspectorHover"/);
  assert.match(output, /capture-bind:mousemove="__mpCodeInspectorHover"/);
  assert.match(output, /capture-bind:touchstart="__mpCodeInspectorHover"/);
  assert.match(output, /catchtouchmove="\{\{__mpCodeInspectorActive \? '__mpCodeInspectorHover' : ''\}\}"/);
  assert.match(output, /capture-bind:mouseout="__mpCodeInspectorLeave"/);
  assert.doesNotMatch(output, /capture-bind:mouseenter/);
  assert.doesNotMatch(output, /capture-bind:touchend/);
  assert.doesNotMatch(output, /capture-bind:touchmove/);
});

test('keeps native button behaviors intact (open-type getPhoneNumber etc.)', () => {
  const input = '<button id="agree-btn" open-type="agreePrivacyAuthorization" bindagreeprivacyauthorization="__e" bindtap="__e"></button>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/login/login.wxml'
  });

  assert.match(output, /open-type="agreePrivacyAuthorization"/);
  assert.match(output, /bindagreeprivacyauthorization="__e"/);
  assert.match(output, /bindtap="__e"/);
  assert.doesNotMatch(output, /capture-catch:tap/);
  assert.doesNotMatch(output, /data-code-original-tap/);
  assert.doesNotMatch(output, /capture-bind:tap="__mpCodeInspectorTap"/);
});

test('locOnly mode only injects data-code-loc', () => {
  const input = '<view bindtap="__e"><text>hi</text></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    locOnly: true
  });

  assert.match(output, /data-code-loc="pages\/index\/index\.wxml:1:1"/);
  assert.match(output, /data-code-loc="pages\/index\/index\.wxml:1:2\d"/);
  assert.doesNotMatch(output, /capture-/);
  assert.doesNotMatch(output, /mpcts-target/);
  assert.doesNotMatch(output, /data-code-original-tap/);
});

test('adds inspector tap binding when upgrading nodes without any tap handler', () => {
  const input = '<view data-code-loc="pages/index/index.vue:2:3"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
  assert.match(output, /class="mpcts-target mpcts_/);
});

test('strips legacy interception attributes from previously transformed output', () => {
  const input = '<view data-code-loc="pages/index/index.vue:2:3" bindtap="__e" data-code-original-tap="__e" capture-catch:tap="__mpCodeInspectorTapCatch"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.match(output, /bindtap="__e"/);
  assert.doesNotMatch(output, /data-code-original-tap/);
  assert.doesNotMatch(output, /capture-catch:tap="__mpCodeInspectorTapCatch"/);
  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
});

test('strips legacy interception attributes from generated nodes without source metadata', () => {
  const input = '<view bindtap="__e" data-code-original-tap="__e" capture-catch:tap="__mpCodeInspectorTapCatch"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.match(output, /bindtap="__e"/);
  assert.doesNotMatch(output, /data-code-original-tap/);
  assert.doesNotMatch(output, /capture-catch:tap="__mpCodeInspectorTapCatch"/);
  assert.match(output, /capture-bind:tap="__mpCodeInspectorTap"/);
});

test('does not duplicate the observer binding on re-transform', () => {
  const input = '<view data-code-loc="pages/index/index.vue:2:3" capture-bind:tap="__mpCodeInspectorTap" bindtap="__e"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.match(output, /bindtap="__e"/);
  assert.equal(output.match(/capture-bind:tap="__mpCodeInspectorTap"/g).length, 1);
  assert.doesNotMatch(output, /capture-catch:tap/);
});

test('can inject rainbow overlay node for compiled wxml assets', () => {
  const input = '<view></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    injectOverlay: true
  });

  assert.match(output, /__mpCodeInspectorOverlay/);
  assert.match(output, /style="{{__mpCodeInspectorOverlay\.style}}"/);
});

test('does not reinstrument the injected overlay node', () => {
  const input = [
    '<view></view>',
    '<view wx:if="{{__mpCodeInspectorOverlay && __mpCodeInspectorOverlay.visible}}"',
    ' style="{{__mpCodeInspectorOverlay.style}}"',
    ' catchtap="__mpCodeInspectorStop"></view>'
  ].join('');
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    injectOverlay: true
  });

  assert.equal(output.match(/catchtap="__mpCodeInspectorStop"/g).length, 1);
  assert.doesNotMatch(output, /data-code-original-tap="__mpCodeInspectorStop"/);
});

test('upgrades old overlay to the lightweight overlay node', () => {
  const input = [
    '<view data-code-loc="pages/index/index.vue:1:1"',
    ' data-code-id="mpcts_demo"',
    ' capture-bind:mousemove="__mpCodeInspectorHover"',
    ' capture-bind:touchmove="__mpCodeInspectorHover"></view>',
    '<view wx:if="{{__mpCodeInspectorOverlay && __mpCodeInspectorOverlay.visible}}"',
    ' style="{{__mpCodeInspectorOverlay.style}}"',
    ' catchtap="__mpCodeInspectorStop" catchtouchmove="__mpCodeInspectorStop"></view>'
  ].join('');
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    injectOverlay: true
  });

  assert.match(output, /class="mpcts-target mpcts_demo"/);
  assert.match(output, /capture-bind:mousemove="__mpCodeInspectorHover"/);
  assert.match(output, /capture-bind:mouseout="__mpCodeInspectorLeave"/);
  // 旧的 capture-bind:touchmove 升级为条件 catchtouchmove（按住修饰键时阻止拖动滚动）
  assert.doesNotMatch(output, /capture-bind:touchmove/);
  assert.match(output, /catchtouchmove="\{\{__mpCodeInspectorActive \? '__mpCodeInspectorHover' : ''\}\}"/);
  assert.doesNotMatch(output, /__mpCodeInspectorPointerMove/);
  assert.match(output, /__mpCodeInspectorOverlay/);
});

test('emits absolute path when the file escapes the configured root', () => {
  const output = transformTemplate('<view></view>', {
    root: '/some/other/tool/dir',
    file: '/repo/pages/index/index.wxml',
    locOnly: true
  });

  assert.match(output, /data-code-loc="\/repo\/pages\/index\/index\.wxml:1:1"/);
  assert.doesNotMatch(output, /data-code-loc="\.\./);
});

test('does not inject duplicate code metadata', () => {
  const input = '<view data-code-loc="x:1:1"></view>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml'
  });

  assert.equal(output.match(/data-code-loc/g).length, 1);
});

test('keeps existing tap handlers when trigger is tap', () => {
  const input = '<button bindtap="submit">Save</button>';
  const output = transformTemplate(input, {
    root: '/repo',
    file: '/repo/pages/index/index.wxml',
    trigger: 'tap'
  });

  assert.match(output, /bindtap="submit"/);
  assert.doesNotMatch(output, /capture-bind:tap="__mpCodeInspectorTap"/);
  assert.match(output, /data-code-loc="pages\/index\/index\.wxml:1:1"/);
});

test('maps generated wxml-only metadata back to a same-name vue source when possible', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcts-template-'));
  try {
    const vueFile = path.join(root, 'pages/login/login.vue');
    fs.mkdirSync(path.dirname(vueFile), { recursive: true });
    fs.writeFileSync(vueFile, '<template/>');

    const output = transformTemplate('<lk-mp-privacy></lk-mp-privacy>', {
      root,
      file: path.join(root, 'pages/login/login.wxml')
    });

    assert.match(output, /data-code-loc="pages\/login\/login\.vue:1:1"/);
    assert.doesNotMatch(output, /pages\/login\/login\.wxml:1:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rewrites stale generated wxml metadata from old output back to vue source', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcts-template-'));
  try {
    const vueFile = path.join(root, 'pages/login/login.vue');
    fs.mkdirSync(path.dirname(vueFile), { recursive: true });
    fs.writeFileSync(vueFile, '<template/>');

    const input = '<lk-mp-privacy data-code-loc="pages/login/login.wxml:1:9226" data-code-file="pages/login/login.wxml" data-code-line="1" data-code-column="9226"></lk-mp-privacy>';
    const output = transformTemplate(input, {
      root,
      file: path.join(root, 'pages/login/login.wxml')
    });

    assert.match(output, /data-code-loc="pages\/login\/login\.vue:1:1"/);
    assert.match(output, /data-code-file="pages\/login\/login\.vue"/);
    assert.match(output, /data-code-line="1"/);
    assert.match(output, /data-code-column="1"/);
    assert.doesNotMatch(output, /pages\/login\/login\.wxml:1:9226/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
