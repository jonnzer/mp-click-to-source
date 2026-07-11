#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { startInspectorServer } = require('../src/server');
const { transformTemplate, shouldTransformFile } = require('../src/transform-template');

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, onFile);
    } else {
      onFile(file);
    }
  }
}

function copyAndTransform(inputDir, outputDir, options) {
  const root = path.resolve(options.root || inputDir);

  walk(inputDir, (file) => {
    const relative = path.relative(inputDir, file);
    const target = path.join(outputDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (shouldTransformFile(file)) {
      const source = fs.readFileSync(file, 'utf8');
      const transformed = transformTemplate(source, {
        root,
        file,
        trigger: options.trigger || 'option-click',
        injectOverlay: true
      });
      fs.writeFileSync(target, transformed);
      return;
    }

    fs.copyFileSync(file, target);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === 'server') {
    const root = path.resolve(args.root || process.cwd());
    const editor = args.editor || 'code';
    const port = args.port || 17365;
    const modifier = args.modifier || 'option';
    const { host } = await startInspectorServer({ root, editor, port, modifier });
    console.log(`[mp-click-to-source] listening on http://${host}:${port}, root=${root}, editor=${editor}, modifier=${modifier}`);
    return;
  }

  if (command === 'rewrite') {
    const inputDir = args._[1] ? path.resolve(args._[1]) : process.cwd();
    const outputDir = args._[2] ? path.resolve(args._[2]) : path.resolve(process.cwd(), 'dist-mp-inspector');
    copyAndTransform(inputDir, outputDir, {
      root: args.root || inputDir,
      trigger: args.trigger || 'option-click'
    });
    console.log(`[mp-click-to-source] wrote transformed project to ${outputDir}`);
    return;
  }

  console.log([
    'Usage:',
    '  mp-click-to-source server --root <projectRoot> [--port 17365] [--editor code|cursor|webstorm] [--modifier option|cmd|shift|control|none]',
    '  mp-click-to-source rewrite <inputDir> <outputDir> [--trigger option-click|longpress|tap|both]'
  ].join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
