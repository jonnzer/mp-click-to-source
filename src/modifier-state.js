const { spawn, spawnSync } = require('child_process');

// 修饰键检测，全部走系统自带命令，零编译、零安装：
// - macOS: osascript(JXA) 读取 NSEvent.modifierFlags
// - Windows: powershell P/Invoke user32!GetAsyncKeyState（Add-Type 用系统内置 .NET 编译器）
//
// 统一映射到 NSEventModifierFlags 的掩码位（与 CGEventFlags 相同），上层无需关心平台：
//   option/alt -> macOS Option / Windows Alt (1<<19)
//   control    -> Ctrl (1<<18)
//   shift      -> Shift (1<<17)
//   command    -> macOS Command / Windows Win 键 (1<<20)
const MODIFIER_MASKS = {
  option: 1n << 19n,
  alt: 1n << 19n,
  shift: 1n << 17n,
  command: 1n << 20n,
  cmd: 1n << 20n,
  meta: 1n << 20n,
  control: 1n << 18n,
  ctrl: 1n << 18n
};

const MAC_READ_ONCE_SCRIPT = 'ObjC.import("Cocoa"); $.NSEvent.modifierFlags';

// 常驻监听：状态变化才输出一行 flags，30ms 轮询开销可忽略
const MAC_WATCH_SCRIPT = [
  'ObjC.import("Cocoa");',
  'var stdout = $.NSFileHandle.fileHandleWithStandardOutput;',
  'function emit(s) { stdout.writeData($(s + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }',
  'var last = -1;',
  'while (true) {',
  '  var flags = Number($.NSEvent.modifierFlags);',
  '  if (flags !== last) { last = flags; emit(String(flags)); }',
  '  delay(0.03);',
  '}'
].join('\n');

// VK_SHIFT=0x10 VK_CONTROL=0x11 VK_MENU(Alt)=0x12 VK_LWIN=0x5B VK_RWIN=0x5C
const WIN_FLAGS_PRELUDE = [
  "Add-Type -Namespace MpCts -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);'",
  'function Get-MpctsFlags { $f = 0;' +
    ' if ([MpCts.Keys]::GetAsyncKeyState(0x10) -band 0x8000) { $f = $f -bor 131072 };' +
    ' if ([MpCts.Keys]::GetAsyncKeyState(0x11) -band 0x8000) { $f = $f -bor 262144 };' +
    ' if ([MpCts.Keys]::GetAsyncKeyState(0x12) -band 0x8000) { $f = $f -bor 524288 };' +
    ' if ((([MpCts.Keys]::GetAsyncKeyState(0x5B)) -bor ([MpCts.Keys]::GetAsyncKeyState(0x5C))) -band 0x8000) { $f = $f -bor 1048576 };' +
    ' return $f }'
].join('; ');

const WIN_READ_ONCE_SCRIPT = WIN_FLAGS_PRELUDE + '; [Console]::Out.WriteLine((Get-MpctsFlags))';

const WIN_WATCH_SCRIPT = WIN_FLAGS_PRELUDE +
  '; $last = -1; while ($true) {' +
  ' $f = Get-MpctsFlags;' +
  ' if ($f -ne $last) { $last = $f; [Console]::Out.WriteLine($f) };' +
  ' Start-Sleep -Milliseconds 30 }';

const POWERSHELL_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function isSupportedPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function getWatchCommand(platform = process.platform) {
  if (platform === 'darwin') {
    return ['osascript', ['-l', 'JavaScript', '-e', MAC_WATCH_SCRIPT]];
  }
  if (platform === 'win32') {
    return ['powershell', [...POWERSHELL_BASE_ARGS, WIN_WATCH_SCRIPT]];
  }
  return null;
}

function normalizeModifier(modifier) {
  if (!modifier || modifier === true) return [];
  if (modifier === 'none' || modifier === 'false') return [];

  return String(modifier)
    .split(/[+,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readModifierFlagsOnce() {
  let command;
  let args;
  let timeout;

  if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-l', 'JavaScript', '-e', MAC_READ_ONCE_SCRIPT];
    timeout = 3000;
  } else if (process.platform === 'win32') {
    command = 'powershell';
    args = [...POWERSHELL_BASE_ARGS, WIN_READ_ONCE_SCRIPT];
    // PowerShell 冷启动较慢
    timeout = 8000;
  } else {
    throw new Error(`unsupported platform: ${process.platform}`);
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true
  });

  if (result.status !== 0) {
    const message = result.stderr || result.stdout || 'failed to read modifier state';
    throw new Error(message.trim());
  }

  return BigInt(result.stdout.trim() || '0');
}

function matchFlags(flags, modifier) {
  const keys = normalizeModifier(modifier);
  if (keys.length === 0) return true;

  return keys.every((key) => {
    const mask = MODIFIER_MASKS[key];
    if (!mask) return false;
    return (flags & mask) !== 0n;
  });
}

function isModifierPressed(modifier) {
  const keys = normalizeModifier(modifier);
  if (keys.length === 0) return true;
  if (!isSupportedPlatform()) return false;

  return matchFlags(readModifierFlagsOnce(), modifier);
}

// 常驻监听器：spawn 一次系统脚本进程，按行读取 flags 变化。
// 相比高频 spawnSync 每次起进程，CPU/内存开销几乎为零。
function createModifierMonitor() {
  const listeners = new Set();
  let child = null;
  let stopped = false;
  let flags = 0n;
  let available = isSupportedPlatform();
  let lastError = null;
  let restartTimer = null;
  let restartDelay = 1000;
  let exitHookInstalled = false;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener(flags);
      } catch (error) {
        // 监听器异常不应打断状态流
      }
    }
  }

  function spawnChild() {
    if (stopped) return;

    const watchCommand = getWatchCommand();
    if (!watchCommand) {
      available = false;
      return;
    }

    try {
      child = spawn(watchCommand[0], watchCommand[1], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      });
    } catch (error) {
      lastError = error;
      available = false;
      return;
    }

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            flags = BigInt(line);
            emit();
          } catch (error) {
            // 非法输出行，忽略
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', (error) => {
      lastError = error;
      available = false;
    });
    child.on('exit', () => {
      child = null;
      if (stopped) return;
      restartTimer = setTimeout(spawnChild, restartDelay);
      restartDelay = Math.min(restartDelay * 2, 10000);
      if (typeof restartTimer.unref === 'function') restartTimer.unref();
    });
    child.unref();
  }

  return {
    start() {
      if (stopped || child) return;
      if (!isSupportedPlatform()) {
        available = false;
        return;
      }
      spawnChild();
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once('exit', () => {
          try {
            if (child) child.kill();
          } catch (error) {
            // 进程退出时尽力清理
          }
        });
      }
    },
    stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child) {
        try {
          child.kill();
        } catch (error) {
          // 已退出则忽略
        }
        child = null;
      }
    },
    isAvailable() {
      return available;
    },
    getFlags() {
      return flags;
    },
    isPressed(modifier) {
      return matchFlags(flags, modifier);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLastError() {
      return lastError;
    }
  };
}

module.exports = {
  MODIFIER_MASKS,
  normalizeModifier,
  isModifierPressed,
  isSupportedPlatform,
  createModifierMonitor
};
