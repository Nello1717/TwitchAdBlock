'use strict';

// Works out the release for the current commit: tag name, title and release notes.
// Used by .github/workflows/release.yml; run it locally to preview: node tools/release-info.js
//
// Outputs (to $GITHUB_OUTPUT when set, otherwise printed): tag, title, notes_file.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SCRIPTS = ['twitch-adblock-hq.user.js', 'twitch-adblock-hq-ublock-origin.js'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const userscript = fs.readFileSync(path.join(root, SCRIPTS[0]), 'utf8');
const versionMatch = /^\/\/ @version\s+(\S+)/m.exec(userscript);
if (!versionMatch) {
    throw new Error(`@version not found in ${SCRIPTS[0]}`);
}
const version = versionMatch[1];
const repository = process.env.GITHUB_REPOSITORY || 'Nello1717/TwitchAdBlock';
const sha = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
const runNumber = process.env.GITHUB_RUN_NUMBER || 'local';

const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
const versionBumped = !tags.includes(`v${version}`);
const tag = versionBumped ? `v${version}` : `v${version}-r${runNumber}`;

// Commits that touched the scripts since the previous release (or all of them for the first release).
let previousTag = '';
try {
    previousTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${sha}^`);
} catch (err) {
    // No earlier release (or no parent commit): list the whole history.
}
const range = previousTag ? [`${previousTag}..${sha}`] : [sha];
const changes = git('log', '--no-merges', '--pretty=format:- %s (%h)', ...range, '--', ...SCRIPTS);

const raw = `https://raw.githubusercontent.com/${repository}`;
const notes = [
    '## Changes',
    changes || '- Script files updated',
    '',
    '## Install or update',
    `- **Userscript:** [twitch-adblock-hq.user.js](https://github.com/${repository}/raw/main/twitch-adblock-hq.user.js). Userscript managers pick up new versions automatically.`,
    `- **uBlock Origin:** set \`userResourcesLocation\` to this release's address and click *Apply changes* (uBlock Origin only re-downloads when the address changes):`,
    '  ```',
    `  ${raw}/${sha}/twitch-adblock-hq-ublock-origin.js`,
    '  ```',
];
if (!versionBumped) {
    notes.push('', `> The scripts changed without a new \`@version\` (still ${version}), so userscript managers won't offer this update automatically.`);
}

const notesFile = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), 'release-notes.md');
fs.writeFileSync(notesFile, `${notes.join('\n')}\n`);

const outputs = { tag, title: `Twitch AdBlock HQ ${tag}`, notes_file: notesFile };
if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}
console.log(JSON.stringify(outputs, null, 2));
console.log(fs.readFileSync(notesFile, 'utf8'));
