const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const {
  normalizeModifier,
  isModifierPressed,
  createModifierMonitor
} = require('./modifier-state');

const DEFAULT_PORT = 17365;
const DEFAULT_MODIFIER = 'option';
const DEFAULT_MODIFIER_GRACE_MS = 700;
const MAX_LONG_POLL_WAIT_MS = 55000;
// Windows 下 .cmd/.bat 启动器需要 shell，成功与否只能看退出码；
// 快速失败（如命令不存在）会在这个窗口内返回非 0，超过窗口则视为已成功拉起
const WINDOWS_SPAWN_SETTLE_MS = 1500;

function buildFileUrl(scheme, file, line, column) {
  // vscode://file/Users/x/a.vue:1:1 (mac) / vscode://file/C:/x/a.vue:1:1 (win)
  let normalized = String(file).replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  return `${scheme}://file${normalized}:${line}:${column}`;
}

function getEditorCommandCandidates({ editor, file, line, column, platform = process.platform }) {
  const isWindows = platform === 'win32';
  const target = `${file}:${line || 1}:${column || 1}`;
  const openUrl = (scheme) => {
    const url = buildFileUrl(scheme, file, line || 1, column || 1);
    // start 是 cmd 内建命令，第一个引号参数是窗口标题，必须留空占位
    return isWindows ? ['start', ['', url]] : ['open', [url]];
  };

  if (editor === 'cursor') {
    return [
      ['cursor', ['-g', target]],
      openUrl('cursor')
    ];
  }

  if (editor === 'webstorm') {
    return [
      ['webstorm', [target]]
    ];
  }

  return [
    ['code', ['-g', target]],
    openUrl('vscode')
  ];
}

function quoteWindowsArg(value) {
  value = String(value);
  if (value === '') return '""';
  return /[\s"&()^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseLoc(searchParams) {
  const loc = searchParams.get('loc');
  if (loc) {
    const match = loc.match(/^(.*):(\d+):(\d+)$/);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3])
      };
    }
  }

  return {
    file: searchParams.get('file'),
    line: Number(searchParams.get('line') || 1),
    column: Number(searchParams.get('column') || 1)
  };
}

// uni-app 等框架的部分节点只能标到编译产物路径（如 pages/x/x.wxml），
// 源码树里并不存在；打开前必须做存在性检查并优先映射回同名 .vue。
// 不默认打开 unpackage 产物，避免跳到不可维护的编译文件。
const DEFAULT_SOURCE_FALLBACK_DIRS = [];
const GENERATED_TEMPLATE_EXTENSIONS = new Set(['.wxml', '.axml', '.swan', '.ttml', '.qml']);
const GENERATED_OUTPUT_DIRS = ['unpackage/dist/dev/mp-weixin', 'unpackage/dist/build/mp-weixin'];

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function getGeneratedSourceCandidates(file, root, fallbackDirs = DEFAULT_SOURCE_FALLBACK_DIRS) {
  const normalized = normalizeSlash(file);
  const candidates = [];
  const pushVueCandidate = (relativePath) => {
    if (!relativePath || !GENERATED_TEMPLATE_EXTENSIONS.has(path.posix.extname(relativePath))) return;
    const sourceLikePath = normalizeSlash(relativePath)
      .replace(/(^|\/)node-modules\//g, '$1node_modules/')
      .replace(/\.[^/.]+$/, '.vue');
    candidates.push(path.resolve(root, sourceLikePath));
  };

  if (path.isAbsolute(file)) {
    for (const dir of GENERATED_OUTPUT_DIRS.concat(fallbackDirs)) {
      const fallbackRoot = path.resolve(root, dir);
      const relativeToFallback = path.relative(fallbackRoot, file);
      if (!relativeToFallback.startsWith('..') && !path.isAbsolute(relativeToFallback)) {
        pushVueCandidate(relativeToFallback);
      }
    }

    const relativeToRoot = path.relative(root, file);
    if (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
      pushVueCandidate(relativeToRoot);
    }
  } else {
    let relativePath = normalized;
    for (const dir of GENERATED_OUTPUT_DIRS) {
      if (relativePath.startsWith(dir + '/')) {
        relativePath = relativePath.slice(dir.length + 1);
        break;
      }
    }
    pushVueCandidate(relativePath);
  }

  return candidates;
}

function isGeneratedOutputFile(file, root) {
  const normalizedRelative = normalizeSlash(path.isAbsolute(file) ? path.relative(root, file) : file);
  return GENERATED_OUTPUT_DIRS.some((dir) => normalizedRelative.startsWith(dir + '/'));
}

function resolveOpenTarget(root, file, fallbackDirs = DEFAULT_SOURCE_FALLBACK_DIRS) {
  const location = resolveOpenLocation(root, { file }, fallbackDirs);
  return location && location.file;
}

function resolveOpenLocation(root, loc, fallbackDirs = DEFAULT_SOURCE_FALLBACK_DIRS) {
  const file = loc && loc.file;
  if (!file) return null;

  if (isGeneratedOutputFile(file, root)) {
    for (const candidate of getGeneratedSourceCandidates(file, root, fallbackDirs)) {
      if (fs.existsSync(candidate)) {
        return { file: candidate, line: 1, column: 1, mapped: true };
      }
    }
  }

  if (path.isAbsolute(file)) {
    if (fs.existsSync(file)) {
      return { file, line: Number(loc.line || 1), column: Number(loc.column || 1), mapped: false };
    }
  } else {
    const primary = path.resolve(root, file);
    if (fs.existsSync(primary)) {
      return { file: primary, line: Number(loc.line || 1), column: Number(loc.column || 1), mapped: false };
    }
  }

  for (const candidate of getGeneratedSourceCandidates(file, root, fallbackDirs)) {
    if (fs.existsSync(candidate)) {
      return { file: candidate, line: 1, column: 1, mapped: true };
    }
  }

  return null;
}

function spawnEditor(command, args, platform = process.platform) {
  if (platform !== 'win32') {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore'
      });

      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  // Windows: code/cursor 是 .cmd 启动器，start 是 cmd 内建，都必须经 shell 执行。
  // shell 模式下 spawn 总能成功，需通过退出码判断命令是否真的存在/执行成功。
  return new Promise((resolve, reject) => {
    const commandLine = [command, ...args].map(quoteWindowsArg).join(' ');
    const child = spawn(commandLine, [], {
      shell: true,
      stdio: 'ignore',
      windowsHide: true
    });

    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    // 启动器可能阻塞等编辑器退出（如 JetBrains），超过窗口未退出视为已成功拉起
    const timer = setTimeout(() => {
      child.unref();
      settle();
    }, WINDOWS_SPAWN_SETTLE_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('error', settle);
    child.once('exit', (code) => {
      settle(code === 0 ? null : new Error(`command failed (exit ${code}): ${commandLine}`));
    });
  });
}

async function openInEditor({ file, line, column, editor, platform = process.platform }) {
  const commands = getEditorCommandCandidates({ editor, file, line, column, platform });
  let lastError = null;

  for (const [command, args] of commands) {
    try {
      await spawnEditor(command, args, platform);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to open editor: ${editor}`);
}

function createModifierTracker(modifier, options = {}) {
  const graceMs = Number(options.graceMs || DEFAULT_MODIFIER_GRACE_MS);
  const keys = normalizeModifier(modifier);
  const listeners = new Set();
  let pressed = keys.length === 0;
  let lastPressedAt = pressed ? Date.now() : 0;
  let lastError = null;
  let monitor = null;
  let unsubscribeMonitor = null;
  let fallbackTimer = null;
  let usingMonitor = false;

  function getState() {
    return {
      active: pressed || Date.now() - lastPressedAt <= graceMs,
      pressed,
      lastPressedAt,
      lastError: lastError ? lastError.message : null
    };
  }

  function setPressed(next) {
    next = !!next;
    if (next) lastPressedAt = Date.now();
    if (pressed === next) return;

    pressed = next;
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        // 监听器异常不影响其他 waiter
      }
    }
  }

  function readOnce() {
    try {
      lastError = null;
      return isModifierPressed(modifier);
    } catch (error) {
      lastError = error;
      return false;
    }
  }

  function start() {
    if (keys.length === 0) return;

    monitor = createModifierMonitor();
    monitor.start();

    if (monitor.isAvailable()) {
      usingMonitor = true;
      unsubscribeMonitor = monitor.onChange(() => setPressed(monitor.isPressed(modifier)));
      setPressed(monitor.isPressed(modifier));
      return;
    }

    lastError = monitor.getLastError();
    const pollInterval = Number(options.pollInterval || 200);
    fallbackTimer = setInterval(() => {
      setPressed(readOnce());
      // osascript 不可用时反复 spawnSync 只会白烧 CPU，报一次错后停掉
      if (lastError) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    }, pollInterval);
    if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
  }

  function stop() {
    if (unsubscribeMonitor) {
      unsubscribeMonitor();
      unsubscribeMonitor = null;
    }
    if (monitor) {
      monitor.stop();
      monitor = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    listeners.clear();
  }

  function isActive() {
    if (keys.length === 0) return true;
    if (!usingMonitor) setPressed(readOnce());
    return pressed || Date.now() - lastPressedAt <= graceMs;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    stop,
    isActive,
    subscribe,
    getState
  };
}

function createInspectorServer(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const sourceFallbackDirs = options.sourceFallbackDirs || DEFAULT_SOURCE_FALLBACK_DIRS;
  const editor = options.editor || process.env.MP_CLICK_TO_SOURCE_EDITOR || 'code';
  const modifier = options.modifier || process.env.MP_CLICK_TO_SOURCE_MODIFIER || DEFAULT_MODIFIER;
  const tracker = createModifierTracker(modifier, {
    graceMs: options.modifierGraceMs,
    pollInterval: options.modifierPollInterval
  });
  let lastOpenKey = '';
  let lastOpenAt = 0;

  tracker.start();

  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        name: 'mp-click-to-source',
        root,
        editor,
        modifier,
        modifierState: tracker.getState()
      }));
      return;
    }

    if (url.pathname === '/modifier') {
      // 长轮询：runtime 传 wait/known，状态与 known 一致时挂起请求，
      // 直到修饰键状态变化或超时，替代小程序侧的高频轮询。
      const waitMs = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, MAX_LONG_POLL_WAIT_MS));
      const knownParam = url.searchParams.get('known');
      const known = knownParam === '1' ? true : knownParam === '0' ? false : null;

      const respond = (state) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          active: state.pressed,
          modifier,
          state
        }));
      };

      const current = tracker.getState();
      if (!waitMs || known === null || known !== current.pressed) {
        respond(current);
        return;
      }

      let finished = false;
      let unsubscribe = null;
      let timer = null;

      const cleanup = () => {
        finished = true;
        if (unsubscribe) unsubscribe();
        if (timer) clearTimeout(timer);
      };
      const finish = () => {
        if (finished) return;
        cleanup();
        if (!response.writableEnded) respond(tracker.getState());
      };

      unsubscribe = tracker.subscribe(finish);
      timer = setTimeout(finish, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      response.on('close', cleanup);
      return;
    }

    if (url.pathname !== '/open') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, message: 'Not found' }));
      return;
    }

    const loc = parseLoc(url.searchParams);

    if (!loc.file) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, message: 'Missing file' }));
      return;
    }

    const resolvedLoc = resolveOpenLocation(root, loc, sourceFallbackDirs);

    if (!resolvedLoc) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        handled: false,
        ignored: true,
        reason: 'file-not-found',
        file: loc.file
      }));
      return;
    }

    try {
      if (!tracker.isActive()) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          handled: false,
          ignored: true,
          reason: 'modifier-not-pressed',
          modifier
        }));
        return;
      }

      const openKey = `${resolvedLoc.file}:${resolvedLoc.line}:${resolvedLoc.column}`;
      const now = Date.now();
      if (openKey === lastOpenKey && now - lastOpenAt < 300) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, handled: true, ignored: true, reason: 'duplicate-open' }));
        return;
      }

      lastOpenKey = openKey;
      lastOpenAt = now;

      await openInEditor({
        file: resolvedLoc.file,
        line: resolvedLoc.line,
        column: resolvedLoc.column,
        editor
      });

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        handled: true,
        file: resolvedLoc.file,
        line: resolvedLoc.line,
        column: resolvedLoc.column,
        mapped: resolvedLoc.mapped === true
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, message: error.message }));
    }
  });

  server.on('close', () => tracker.stop());

  return server;
}

function startInspectorServer(options = {}) {
  const port = Number(options.port || process.env.MP_CLICK_TO_SOURCE_PORT || DEFAULT_PORT);
  const host = options.host || process.env.MP_CLICK_TO_SOURCE_HOST || '127.0.0.1';
  const server = createInspectorServer(options);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({ server, port: (address && address.port) || port, host });
    });
  });
}

function probeHealth(host, port, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
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
    });
    request.on('timeout', () => request.destroy(new Error('health probe timeout')));
    request.on('error', reject);
  });
}

const ensuredServers = new Map();

// 幂等启动：同端口只起一个；已有实例（本进程或别的进程）则复用。
// 供构建插件在编译进程内自动拉起服务。
async function ensureInspectorServer(options = {}) {
  const port = Number(options.port || process.env.MP_CLICK_TO_SOURCE_PORT || DEFAULT_PORT);
  const host = options.host || process.env.MP_CLICK_TO_SOURCE_HOST || '127.0.0.1';
  const key = `${host}:${port}`;

  const cached = ensuredServers.get(key);
  if (cached) {
    const info = await cached.catch(() => null);
    if (info && info.server && info.server.listening) return info;
    if (info && info.reused) {
      const alive = await probeHealth(host, port).catch(() => null);
      if (alive && alive.ok) return info;
    }
    ensuredServers.delete(key);
  }

  const promise = (async () => {
    const health = await probeHealth(host, port).catch(() => null);
    if (health && health.ok) {
      return { reused: true, host, port, root: health.root, editor: health.editor };
    }

    try {
      const started = await startInspectorServer({ ...options, host, port });
      started.server.on('close', () => ensuredServers.delete(key));
      return { ...started, reused: false, root: path.resolve(options.root || process.cwd()) };
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') {
        const late = await probeHealth(host, port).catch(() => null);
        if (late && late.ok) {
          return { reused: true, host, port, root: late.root, editor: late.editor };
        }
      }
      throw error;
    }
  })();

  ensuredServers.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    ensuredServers.delete(key);
    throw error;
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_MODIFIER,
  DEFAULT_MODIFIER_GRACE_MS,
  createModifierTracker,
  createInspectorServer,
  startInspectorServer,
  ensureInspectorServer,
  probeHealth,
  getEditorCommandCandidates,
  resolveOpenTarget,
  resolveOpenLocation,
  quoteWindowsArg,
  buildFileUrl
};
