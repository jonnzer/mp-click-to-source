const { transformTemplate, getLineColumn } = require('./transform-template');

const TEMPLATE_OPEN_RE = /<template(?:\s[^>]*)?>/i;
const TEMPLATE_CLOSE_RE = /<\/template>/i;

function transformVueSfc(source, options = {}) {
  const openMatch = source.match(TEMPLATE_OPEN_RE);
  if (!openMatch || typeof openMatch.index !== 'number') return source;

  const contentStart = openMatch.index + openMatch[0].length;
  const rest = source.slice(contentStart);
  const closeMatch = rest.match(TEMPLATE_CLOSE_RE);
  if (!closeMatch || typeof closeMatch.index !== 'number') return source;

  const contentEnd = contentStart + closeMatch.index;
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
