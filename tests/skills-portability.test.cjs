'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseCommandFile } = require('../.opencode/plugins/jev-flash-review-frontmatter.cjs');

const root = path.resolve(__dirname, '..');
const commandsDir = path.join(root, 'commands');
const skillsDir = path.join(root, 'skills');

function readBody(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, `${file} must have YAML frontmatter`);
  return match[1].trim();
}

function readFrontmatter(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, `${file} must have YAML frontmatter`);
  const lines = match[1].split(/\r?\n/);
  let name;
  let description;
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^name:\s*(.+)$/);
    if (nameMatch) name = nameMatch[1].trim();
    const descriptionMatch = lines[i].match(/^description:\s*(.*)$/);
    if (descriptionMatch) {
      let value = descriptionMatch[1].trim();
      if (/^[>|][+-]?$/.test(value)) {
        const folded = [];
        let j = i + 1;
        while (j < lines.length && /^\s+/.test(lines[j])) {
          folded.push(lines[j].trim());
          j++;
        }
        value = folded.join(' ');
        i = j - 1;
      }
      description = value;
    }
  }
  return { name, description };
}

const commandNames = fs
  .readdirSync(commandsDir)
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length))
  .sort();

const skillNames = fs
  .readdirSync(skillsDir)
  .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
  .sort();

for (const name of skillNames) {
  test(`${name} has portable Agent Skills frontmatter`, () => {
    const metadata = readFrontmatter(path.join(skillsDir, name, 'SKILL.md'));
    assert.equal(metadata.name, name);
    assert.ok(metadata.description, 'description must be non-empty');
    assert.match(metadata.description, /^Use (when|after)/, 'description must state triggers only');
  });

  test(`${name} teaches the review_diff tool contract`, () => {
    const body = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(body, /review_diff/, 'skills must name the MCP tool they depend on');
    assert.match(
      body,
      /never present one as the engine's result/,
      'skills must forbid substituting a manual review when the engine is missing',
    );
    assert.match(
      body,
      /`violations` array/,
      'skills must read confirmed findings from the violations array, not raw results',
    );
    assert.doesNotMatch(body, /CLAUDE_PLUGIN_ROOT/, 'canonical skills must stay provider-neutral');
  });
}

for (const name of commandNames) {
  test(`${name} has a canonical skill and a thin command adapter`, () => {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    const commandFile = path.join(commandsDir, `${name}.md`);
    assert.ok(fs.existsSync(skillFile), `missing ${skillFile}`);

    const skillBody = readBody(skillFile);
    const commandBody = readBody(commandFile);

    assert.ok(skillBody.length >= 500, `${skillFile} must contain the workflow instructions`);
    assert.match(commandBody, new RegExp(`skills/${name}/SKILL\\.md`));
    assert.ok(commandBody.length < 400, `${commandFile} must remain a thin adapter`);
  });
}

test('every command has a skill', () => {
  assert.deepEqual(commandNames, skillNames, 'commands and skills must cover the same workflows');
});

test('provider manifests declare aligned versions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const claude = JSON.parse(
    fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  const codex = JSON.parse(
    fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  const cursor = JSON.parse(
    fs.readFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), 'utf8'),
  );
  const portable = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  for (const manifest of [claude, codex, cursor, portable]) {
    assert.equal(manifest.version, pkg.version, `${manifest.name} version must match package.json`);
  }
  const serverSource = fs.readFileSync(path.join(root, 'src', 'mcp', 'server.ts'), 'utf8');
  assert.match(
    serverSource,
    new RegExp(`new McpServer\\(\\{ name: 'jev-flash-review', version: '${pkg.version}' \\}\\)`),
    'MCP server name and version must match package.json',
  );
});

test('opencode command parsing extracts description and template', () => {
  const parsed = parseCommandFile(path.join(commandsDir, 'review-pr.md'));
  assert.ok(parsed.description);
  assert.match(parsed.template, /skills\/review-pr\/SKILL\.md/);
});
