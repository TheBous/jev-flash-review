#!/usr/bin/env node

// Syncs the release version from package.json into every provider manifest so
// the portability test's lockstep check always passes. Run by release-it's
// after:bump hook; also safe to run standalone (idempotent).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPaths = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'plugin.json',
];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error(`Unsupported version in package.json: ${pkg.version}`);
}

for (const relativePath of manifestPaths) {
  const file = path.join(root, relativePath);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = data.version !== pkg.version;
  data.version = pkg.version;
  for (const plugin of data.plugins || []) {
    if (plugin.version !== pkg.version) {
      plugin.version = pkg.version;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`${relativePath} → ${pkg.version}`);
  }
}
