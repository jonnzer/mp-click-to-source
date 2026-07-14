const { transformTemplate, getLineColumn } = require('./transform-template');

const TEMPLATE_OPEN_RE = /<template(?=[\s>])/i;
const TEMPLATE_TAG_RE = /^<\s*(\/?)\s*template(?=[\s/>])/i;

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

function findTemplateBlock(source) {
  const openMatch = source.match(TEMPLATE_OPEN_RE);
  if (!openMatch || typeof openMatch.index !== 'number') return null;

  const outerTagStart = openMatch.index;
  const outerTagEnd = findTagEnd(source, outerTagStart);
  if (outerTagEnd === -1) return null;

  const contentStart = outerTagEnd + 1;
  let cursor = contentStart;
  let depth = 1;

  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor);
    if (tagStart === -1) return null;

    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return null;
      cursor = commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, tagStart);
    if (tagEnd === -1) return null;

    const rawTag = source.slice(tagStart, tagEnd + 1);
    const templateMatch = rawTag.match(TEMPLATE_TAG_RE);
    if (templateMatch) {
      if (templateMatch[1]) {
        depth -= 1;
        if (depth === 0) {
          return { contentStart, contentEnd: tagStart };
        }
      } else if (!/\/\s*>$/.test(rawTag)) {
        depth += 1;
      }
    }

    cursor = tagEnd + 1;
  }

  return null;
}

function transformVueSfc(source, options = {}) {
  const templateBlock = findTemplateBlock(source);
  if (!templateBlock) return source;

  const { contentStart, contentEnd } = templateBlock;
  const templateSource = source.slice(contentStart, contentEnd);
  const startLoc = getLineColumn(source, contentStart);
  const transformedTemplate = transformTemplate(templateSource, {
    ...options,
    startLine: startLoc.line,
    startColumn: startLoc.column
  });

  return source.slice(0, contentStart) + transformedTemplate + source.slice(contentEnd);
}

module.exports = {
  transformVueSfc
};
