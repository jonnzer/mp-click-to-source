const fs = require('fs');
const path = require('path');

const DEFAULT_EXTENSIONS = ['.wxml', '.axml', '.swan', '.ttml', '.qml'];
const SKIP_TAGS = new Set(['wxs', 'import', 'include', 'template', 'block']);
const TAG_NAME_RE = /^<\/?\s*([A-Za-z][\w:-]*)/;
const HAS_CODE_LOC_RE = /\sdata-code-loc\s*=/;
const CODE_LOC_RE = /(\sdata-code-loc\s*=\s*)(["'])(.*?)\2/;
const CODE_FILE_RE = /(\sdata-code-file\s*=\s*)(["'])(.*?)\2/;
const CODE_LINE_RE = /(\sdata-code-line\s*=\s*)(["'])(.*?)\2/;
const CODE_COLUMN_RE = /(\sdata-code-column\s*=\s*)(["'])(.*?)\2/;
const CAPTURE_TAP_RE = /\s(?:capture-)?(?:bind|catch):?tap\s*=/;
const CAPTURE_LONGPRESS_RE = /\s(?:capture-)?bind:?(?:longpress|longtap)\s*=/;
// 任意 capture-bind:tap（业务自己的或我们的），存在则不再注入观察绑定
const HAS_CAPTURE_BIND_TAP_RE = /\scapture-bind:?tap\s*=/;
// 旧版本的拦截式注入（capture-catch + 补发），已废弃，重新转换时强制清除
const LEGACY_TAP_CATCH_RE = /\s(?:capture-catch:?tap)\s*=\s*(["'])__mpCodeInspectorTapCatch\1/g;
const LEGACY_ORIGINAL_TAP_ATTR_RE = /\sdata-code-original-tap\s*=\s*(["'])[\s\S]*?\1/g;
const HAS_CODE_ID_RE = /\sdata-code-id\s*=/;
const CODE_ID_RE = /\sdata-code-id\s*=\s*(["'])(.*?)\1/;
const CLASS_RE = /(\sclass\s*=\s*)(["'])(.*?)\2/;
const NATIVE_BUTTON_ACTION_RE = /\s(?:open-type|form-type)\s*=/;
// 旧版本注入过的过时 hover 绑定，重新转换时清掉。
// 保留 mouseover：开发者工具不按键时通常只派发"进入元素"事件；
// touchmove 改为条件 catch（见 HOVER_BINDINGS），旧的 capture-bind 形式按过时清理。
const OBSOLETE_HOVER_BINDING_RE = /\s(?:capture-)?(?:bind|catch):?(?:mouseenter|mouseleave|touchmove|touchend|touchcancel)\s*=\s*(["'])__mpCodeInspector(?:Hover|Leave)\1/g;
const OLD_OVERLAY_NODE_RE = /<view\b[^>]*__mpCodeInspectorOverlay[^>]*__mpCodeInspectorStop[^>]*><\/view>/g;
const SENSOR_OVERLAY_NODE_RE = /<view\b[^>]*__mpCodeInspectorActive[^>]*__mpCodeInspectorPointerMove[^>]*>[\s\S]*?<view\b[^>]*__mpCodeInspectorOverlay[\s\S]*?<\/view>\s*<\/view>/g;
const TARGET_CLASS = 'mpcts-target';
const HOVER_BINDINGS = [
  ['capture-bind:mouseover', '__mpCodeInspectorHover'],
  ['capture-bind:mousemove', '__mpCodeInspectorHover'],
  ['capture-bind:touchstart', '__mpCodeInspectorHover'],
  // 条件 catch：按住修饰键时接管拖动（既用坐标驱动 hover，又阻止模拟器把拖动当页面滚动）；
  // 松开时表达式为空串，等于没有绑定，页面滚动完全正常
  ['catchtouchmove', "{{__mpCodeInspectorActive ? '__mpCodeInspectorHover' : ''}}"],
  ['capture-bind:mouseout', '__mpCodeInspectorLeave']
];

function shouldBindTap(trigger) {
  return trigger === 'tap' || trigger === 'both' || trigger === 'option-click';
}

function shouldBindLongpress(trigger) {
  return trigger === 'longpress' || trigger === 'both';
}

function normalizePathForDataset(file, root) {
  const absolute = path.resolve(file);
  const relative = root ? path.relative(path.resolve(root), absolute) : file;
  // root 不对（如构建工具 cwd 在别处）时相对路径会变成 ../../.. 逃逸串，
  // 此时直接用绝对路径，/open 依然能正确打开
  if (relative.startsWith('..')) {
    return absolute.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

function toSourcePathCandidate(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  if (!DEFAULT_EXTENSIONS.includes(path.posix.extname(normalized))) return null;

  const sourceLikePath = normalized.replace(/(^|\/)node-modules\//g, '$1node_modules/');
  return sourceLikePath.replace(/\.[^/.]+$/, '.vue');
}

function resolveGeneratedSourceFile(file, root) {
  const candidate = toSourcePathCandidate(file);
  if (!candidate || candidate === file) return null;

  const absoluteCandidate = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(root || process.cwd(), candidate);

  return fs.existsSync(absoluteCandidate)
    ? candidate.split(path.sep).join('/')
    : null;
}

function parseCodeLoc(value) {
  const match = String(value || '').match(/^(.*):(\d+):(\d+)$/);
  if (!match) return null;

  return {
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3])
  };
}

function getCodeLoc(rawTag) {
  const match = rawTag.match(CODE_LOC_RE);
  return match ? parseCodeLoc(match[3]) : null;
}

function rewriteCodeLoc(rawTag, loc) {
  const nextValue = `${loc.file}:${loc.line}:${loc.column}`;
  let output = rawTag.replace(CODE_LOC_RE, function replaceLoc(_, prefix, quote) {
    return `${prefix}${quote}${nextValue}${quote}`;
  });

  output = output.replace(CODE_FILE_RE, function replaceFile(_, prefix, quote) {
    return `${prefix}${quote}${loc.file}${quote}`;
  });
  output = output.replace(CODE_LINE_RE, function replaceLine(_, prefix, quote) {
    return `${prefix}${quote}${loc.line}${quote}`;
  });
  output = output.replace(CODE_COLUMN_RE, function replaceColumn(_, prefix, quote) {
    return `${prefix}${quote}${loc.column}${quote}`;
  });

  return output;
}

function normalizeExistingCodeLoc(rawTag, root) {
  const loc = getCodeLoc(rawTag);
  if (!loc) return { rawTag, loc: null };

  const generatedSourceFile = resolveGeneratedSourceFile(loc.file, root);
  if (!generatedSourceFile) return { rawTag, loc };

  const mappedLoc = { file: generatedSourceFile, line: 1, column: 1 };
  return {
    rawTag: rewriteCodeLoc(rawTag, mappedLoc),
    loc: mappedLoc
  };
}

function getLineColumn(source, offset) {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function offsetLineColumn(loc, options) {
  const startLine = options.startLine || 1;
  const startColumn = options.startColumn || 1;

  return {
    line: loc.line + startLine - 1,
    column: loc.line === 1 ? loc.column + startColumn - 1 : loc.column
  };
}

function findTagEnd(source, start) {
  let quote = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '>') return index;
  }

  return -1;
}

function isSkippableTag(rawTag, tagName) {
  if (!tagName) return true;
  if (rawTag.startsWith('</')) return true;
  if (rawTag.startsWith('<!--') || rawTag.startsWith('<!') || rawTag.startsWith('<?')) return true;
  if (rawTag.includes('__mpCodeInspectorOverlay') || rawTag.includes('__mpCodeInspectorStop')) return true;
  if (SKIP_TAGS.has(tagName.toLowerCase())) return true;
  return false;
}

function buildAttributes(loc, options) {
  const attrs = [
    `data-code-loc="${loc.file}:${loc.line}:${loc.column}"`,
    `data-code-file="${loc.file}"`,
    `data-code-line="${loc.line}"`,
    `data-code-column="${loc.column}"`
  ];

  if (shouldBindTap(options.trigger)) {
    attrs.push('capture-bind:tap="__mpCodeInspectorTap"');
  }

  if (shouldBindLongpress(options.trigger)) {
    attrs.push('capture-bind:longpress="__mpCodeInspectorLongPress"');
  }

  return attrs;
}

function injectAttributes(rawTag, attrs) {
  if (rawTag.endsWith('/>')) {
    return `${rawTag.slice(0, -2)} ${attrs.join(' ')} />`;
  }

  return `${rawTag.slice(0, -1)} ${attrs.join(' ')}>`;
}

// 纯旁观原则：绝不 catch / 代理 / 补发业务 tap。
// 只挂非阻塞的 capture-bind 观察者，业务事件链与原生行为（button open-type、
// form-type、navigator、picker 等）100% 原样执行。
// 代价：按住修饰键点击时业务行为也会执行——这是"不碰点击"的必然结果。
function isNativeActionButton(rawTag, tagName) {
  return String(tagName || '').toLowerCase() === 'button' && NATIVE_BUTTON_ACTION_RE.test(rawTag);
}

function getTapAttributes(rawTag, tagName) {
  if (isNativeActionButton(rawTag, tagName)) return [];
  if (HAS_CAPTURE_BIND_TAP_RE.test(rawTag)) return [];
  return ['capture-bind:tap="__mpCodeInspectorTap"'];
}

function createCodeId(loc) {
  const value = `${loc.file}:${loc.line}:${loc.column}`;
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return `mpcts_${(hash >>> 0).toString(36)}`;
}

function getCodeId(rawTag, loc) {
  return rawTag.match(CODE_ID_RE)?.[2] || createCodeId(loc);
}

function hasClassToken(value, className) {
  return String(value).split(/\s+/).includes(className);
}

function addCodeClass(rawTag, codeId) {
  const classTokens = [TARGET_CLASS, codeId];
  const classMatch = rawTag.match(CLASS_RE);

  if (classMatch) {
    const missingTokens = classTokens.filter((className) => !hasClassToken(classMatch[3], className));
    if (!missingTokens.length) return rawTag;

    return rawTag.replace(CLASS_RE, function replaceClass(_, prefix, quote, value) {
      return `${prefix}${quote}${value} ${missingTokens.join(' ')}${quote}`;
    });
  }

  return injectAttributes(rawTag, [`class="${classTokens.join(' ')}"`]);
}

function getHoverAttributes(rawTag, loc) {
  const attrs = [];
  const codeId = getCodeId(rawTag, loc);

  if (!HAS_CODE_ID_RE.test(rawTag)) {
    attrs.push(`data-code-id="${codeId}"`);
  }

  for (const [name, handler] of HOVER_BINDINGS) {
    const eventName = name.replace(/^(?:capture-)?(?:bind|catch):?/, '');
    const eventRe = new RegExp(`\\s(?:capture-)?(?:bind|catch):?${eventName}\\s*=`);
    if (!eventRe.test(rawTag)) {
      attrs.push(`${name}="${handler}"`);
    }
  }

  return attrs;
}

function removeLegacyInspectorBindings(rawTag) {
  return rawTag.replace(OBSOLETE_HOVER_BINDING_RE, '');
}

// 清除旧版本注入的拦截式绑定：静态 capture-catch:tap 曾在捕获阶段吞掉原生 tap，
// 导致 button open-type（拿手机号/隐私授权）、form 提交等原生行为彻底失效且无法 replay 还原
function stripLegacyTapInterception(rawTag) {
  return rawTag
    .replace(LEGACY_TAP_CATCH_RE, '')
    .replace(LEGACY_ORIGINAL_TAP_ATTR_RE, '');
}

function buildOverlayNode() {
  return [
    '<view wx:if="{{__mpCodeInspectorOverlay && __mpCodeInspectorOverlay.visible}}"',
    ' style="{{__mpCodeInspectorOverlay.style}}"',
    ' catchtap="__mpCodeInspectorStop"',
    ' catchtouchmove="__mpCodeInspectorStop">',
    '<view wx:if="{{__mpCodeInspectorOverlay.label}}"',
    ' style="{{__mpCodeInspectorOverlay.labelStyle}}">',
    '{{__mpCodeInspectorOverlay.label}}',
    '</view>',
    '</view>'
  ].join('');
}

function transformTemplate(source, options = {}) {
  // UNI_INPUT_DIR 由 HBuilderX/uni-cli 设置，指向项目源码目录，
  // 比构建工具自身的 cwd（可能在 HBuilderX 安装目录里）更可靠
  const root = options.root || process.env.UNI_INPUT_DIR || process.cwd();
  const file = normalizePathForDataset(options.file || 'unknown.wxml', root);
  const generatedSourceFile = resolveGeneratedSourceFile(file, root);
  const trigger = options.trigger || 'option-click';
  const tagFilter = options.tagFilter || (() => true);
  const normalizedSource = options.injectOverlay
    ? source.replace(SENSOR_OVERLAY_NODE_RE, '').replace(OLD_OVERLAY_NODE_RE, '')
    : source;
  let output = '';
  let cursor = 0;

  while (cursor < normalizedSource.length) {
    const tagStart = normalizedSource.indexOf('<', cursor);
    if (tagStart === -1) {
      output += normalizedSource.slice(cursor);
      break;
    }

    output += normalizedSource.slice(cursor, tagStart);

    const tagEnd = findTagEnd(normalizedSource, tagStart);
    if (tagEnd === -1) {
      output += normalizedSource.slice(tagStart);
      break;
    }

    const rawTag = normalizedSource.slice(tagStart, tagEnd + 1);
    const cleanedRawTag = removeLegacyInspectorBindings(stripLegacyTapInterception(rawTag));
    const tagName = rawTag.match(TAG_NAME_RE)?.[1];

    if (
      isSkippableTag(rawTag, tagName) ||
      !tagFilter(tagName, rawTag)
    ) {
      output += cleanedRawTag;
      cursor = tagEnd + 1;
      continue;
    }

    // locOnly：只注入 data-code-loc（用于 .vue 模板预处理阶段，
    // 事件/class 等由最终 WXML 资产阶段统一补齐，减少对 vue 编译的干扰）
    if (options.locOnly) {
      if (HAS_CODE_LOC_RE.test(rawTag)) {
        output += normalizeExistingCodeLoc(cleanedRawTag, root).rawTag;
      } else {
        const loc = {
          file,
          ...offsetLineColumn(getLineColumn(normalizedSource, tagStart), options)
        };
        output += injectAttributes(rawTag, [`data-code-loc="${loc.file}:${loc.line}:${loc.column}"`]);
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (HAS_CODE_LOC_RE.test(rawTag)) {
      const normalizedExisting = normalizeExistingCodeLoc(cleanedRawTag, root);
      const loc = normalizedExisting.loc || {
        file,
        ...offsetLineColumn(getLineColumn(normalizedSource, tagStart), options)
      };
      const upgradedTag = normalizedExisting.rawTag;
      const hoverTag = addCodeClass(upgradedTag, getCodeId(upgradedTag, loc));
      const upgradeAttrs = getHoverAttributes(hoverTag, loc);
      if (trigger === 'option-click') {
        upgradeAttrs.push(...getTapAttributes(hoverTag, tagName));
      }
      output += injectAttributes(hoverTag, upgradeAttrs);
      cursor = tagEnd + 1;
      continue;
    }

    const loc = generatedSourceFile
      ? { file: generatedSourceFile, line: 1, column: 1 }
      : {
          file,
          ...offsetLineColumn(getLineColumn(normalizedSource, tagStart), options)
        };
    const attrs = trigger === 'option-click'
      ? [
          `data-code-loc="${loc.file}:${loc.line}:${loc.column}"`,
          ...getTapAttributes(cleanedRawTag, tagName),
          ...getHoverAttributes(addCodeClass(cleanedRawTag, getCodeId(cleanedRawTag, loc)), loc)
        ]
      : buildAttributes(loc, { trigger });
    const shouldAddTap = attrs.some((attr) => attr.startsWith('capture-bind:tap'));
    const shouldAddLongpress = attrs.some((attr) => attr.startsWith('capture-bind:longpress'));
    const filteredAttrs = attrs.filter((attr) => {
      // 旧版 trigger（longpress/tap/both）沿用"已有任意 tap 绑定则不加"的保守去重
      if (trigger !== 'option-click' && attr.startsWith('capture-bind:tap') && shouldAddTap && CAPTURE_TAP_RE.test(cleanedRawTag)) return false;
      if (attr.startsWith('capture-bind:longpress') && shouldAddLongpress && CAPTURE_LONGPRESS_RE.test(cleanedRawTag)) return false;
      return true;
    });

    const outputTag = trigger === 'option-click'
      ? addCodeClass(cleanedRawTag, getCodeId(cleanedRawTag, loc))
      : cleanedRawTag;
    output += injectAttributes(outputTag, filteredAttrs);
    cursor = tagEnd + 1;
  }

  return options.injectOverlay && !output.includes('__mpCodeInspectorOverlay')
    ? output + buildOverlayNode()
    : output;
}

function shouldTransformFile(file, extensions = DEFAULT_EXTENSIONS) {
  return extensions.includes(path.extname(file));
}

module.exports = {
  DEFAULT_EXTENSIONS,
  transformTemplate,
  shouldTransformFile,
  shouldBindTap,
  shouldBindLongpress,
  getLineColumn
};
