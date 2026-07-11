const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createInspectorServer,
  getEditorCommandCandidates,
  quoteWindowsArg,
  buildFileUrl,
  resolveOpenLocation
} = require('../src/server');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

test('modifier endpoint supports long-poll and immediate mismatch response', async () => {
  // modifier none => pressed 恒为 true，便于测试长轮询挂起/立即返回两条路径
  const server = createInspectorServer({ root: '/tmp', modifier: 'none' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // known 与当前状态一致 => 挂起直到超时
    const startedAt = Date.now();
    const held = await httpGetJson(`http://127.0.0.1:${port}/modifier?wait=150&known=1`);
    assert.equal(held.active, true);
    assert.ok(Date.now() - startedAt >= 130);

    // known 与当前状态不一致 => 立即返回
    const before = Date.now();
    const immediate = await httpGetJson(`http://127.0.0.1:${port}/modifier?wait=5000&known=0`);
    assert.equal(immediate.active, true);
    assert.ok(Date.now() - before < 1000);

    // 不带 wait => 立即返回
    const plain = await httpGetJson(`http://127.0.0.1:${port}/modifier`);
    assert.equal(plain.active, true);

    const health = await httpGetJson(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.name, 'mp-click-to-source');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('builds macOS editor command candidates', () => {
  const candidates = getEditorCommandCandidates({
    editor: 'code',
    file: '/repo/pages/index/index.vue',
    line: 12,
    column: 3,
    platform: 'darwin'
  });

  assert.deepEqual(candidates[0], ['code', ['-g', '/repo/pages/index/index.vue:12:3']]);
  assert.deepEqual(candidates[1], ['open', ['vscode://file/repo/pages/index/index.vue:12:3']]);
});

test('builds Windows editor command candidates with forward-slash url', () => {
  const candidates = getEditorCommandCandidates({
    editor: 'code',
    file: 'C:\\repo\\pages\\index\\index.vue',
    line: 12,
    column: 3,
    platform: 'win32'
  });

  assert.deepEqual(candidates[0], ['code', ['-g', 'C:\\repo\\pages\\index\\index.vue:12:3']]);
  assert.deepEqual(candidates[1], ['start', ['', 'vscode://file/C:/repo/pages/index/index.vue:12:3']]);

  const cursor = getEditorCommandCandidates({
    editor: 'cursor',
    file: 'C:\\repo\\a.vue',
    line: 1,
    column: 1,
    platform: 'win32'
  });
  assert.equal(cursor[1][0], 'start');
  assert.match(cursor[1][1][1], /^cursor:\/\/file\/C:\/repo\/a\.vue:1:1$/);
});

test('quotes windows shell arguments only when needed', () => {
  assert.equal(quoteWindowsArg('code'), 'code');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('C:\\my project\\a.vue:1:1'), '"C:\\my project\\a.vue:1:1"');
  assert.equal(quoteWindowsArg('a"b'), '"a""b"');
});

test('buildFileUrl normalizes separators per platform', () => {
  assert.equal(buildFileUrl('vscode', '/repo/a.vue', 1, 2), 'vscode://file/repo/a.vue:1:2');
  assert.equal(buildFileUrl('vscode', 'C:\\repo\\a.vue', 1, 2), 'vscode://file/C:/repo/a.vue:1:2');
});

test('resolveOpenTarget checks existence and maps generated wxml to vue source', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { resolveOpenTarget } = require('../src/server');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcts-open-'));
  try {
    const vueFile = path.join(root, 'pages/login/login.vue');
    const distWxml = path.join(root, 'unpackage/dist/dev/mp-weixin/pages/login/login.wxml');
    fs.mkdirSync(path.dirname(vueFile), { recursive: true });
    fs.mkdirSync(path.dirname(distWxml), { recursive: true });
    fs.writeFileSync(vueFile, '<template/>');
    fs.writeFileSync(distWxml, '<view/>');

    // 源码存在 => 直接命中
    assert.equal(resolveOpenTarget(root, 'pages/login/login.vue'), vueFile);
    // 源码树里没有 .wxml => 映射到同名 .vue，不跳 unpackage 产物
    assert.equal(resolveOpenTarget(root, 'pages/login/login.wxml'), vueFile);
    assert.deepEqual(resolveOpenLocation(root, {
      file: 'pages/login/login.wxml',
      line: 1,
      column: 9226
    }), {
      file: vueFile,
      line: 1,
      column: 1,
      mapped: true
    });
    assert.deepEqual(resolveOpenLocation(root, {
      file: distWxml,
      line: 1,
      column: 9226
    }), {
      file: vueFile,
      line: 1,
      column: 1,
      mapped: true
    });
    // 到处都不存在 => null（服务端返回 file-not-found，而不是让编辑器弹错）
    assert.equal(resolveOpenTarget(root, 'pages/nope/nope.wxml'), null);
    // 绝对路径同样做存在性检查
    assert.equal(resolveOpenTarget(root, vueFile), vueFile);
    assert.equal(resolveOpenTarget(root, path.join(root, 'missing.vue')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
