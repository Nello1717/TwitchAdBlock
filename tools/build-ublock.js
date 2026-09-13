'use strict';

// Generates the uBlock Origin scriptlet from the userscript, so both stay identical.
// Usage: npm run build   (or: node tools/build-ublock.js --check to verify it is up to date)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'twitch-adblock-hq.user.js'), 'utf8').replace(/\r\n/g, '\n');
const target = path.join(root, 'twitch-adblock-hq-ublock-origin.js');

const body = source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, '');
if (body === source) {
    throw new Error('userscript header not found');
}
const marker = "(function (root) {\n    'use strict';\n";
if (!body.includes(marker)) {
    throw new Error('script entry point not found');
}
const output = 'twitch-videoad.js text/javascript\n' + body.replace(
    marker,
    `${marker}    if (/(^|\\.)twitch\\.tv$/.test(document.location.hostname) === false) { return; }\n`,
);

if (process.argv.includes('--check')) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== output) {
        console.error('twitch-adblock-hq-ublock-origin.js is out of date. Run: npm run build');
        process.exit(1);
    }
    console.log('twitch-adblock-hq-ublock-origin.js is up to date');
} else {
    fs.writeFileSync(target, output);
    console.log(`wrote ${path.relative(root, target)}`);
}
