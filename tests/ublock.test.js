'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'twitch-adblock-hq-ublock-origin.js');

// Reads a userResourcesLocation file the way uBlock Origin does: a leading /* */ block is removed, a resource starts
// with a "name mime" line, lines starting with '#' or '// ' are ignored and a whitespace-only line ends the resource.
function readUblockResources(text) {
    const resources = new Map();
    const lines = `${text.replace(/^\/\*[\S\s]+?\*\/\s*/, '')}\n\n`.split(/\r?\n/);
    let current = null;
    for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('// ')) continue;
        if (!current) {
            const head = line.trim().split(/\s+/);
            if (head.length === 2 && /^[a-z]+\/[a-z0-9.+-]+$/.test(head[1])) current = { name: head[0], lines: [] };
            continue;
        }
        if (/\S/.test(line)) {
            current.lines.push(line);
            continue;
        }
        resources.set(current.name, current.lines.join('\n'));
        current = null;
    }
    return resources;
}

function fakeBrowserGlobals() {
    const location = { hostname: 'www.twitch.tv', href: 'https://www.twitch.tv/somechannel', pathname: '/somechannel' };
    const noop = () => {};
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        location,
        document: { location, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [] },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        fetch: async () => ({}),
        Worker: class Worker {},
        XMLHttpRequest: class XMLHttpRequest { open() {} },
        URL,
        Blob,
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: noop,
    };
    const context = vm.createContext(sandbox);
    vm.runInContext('var window = globalThis; var top = globalThis;', context);
    return context;
}

test('uBlock Origin reads the complete script from the resource file', () => {
    const text = fs.readFileSync(FILE, 'utf8');
    const resources = readUblockResources(text);
    assert.deepEqual([...resources.keys()], ['twitch-videoad.js']);
    const script = resources.get('twitch-videoad.js');
    assert.ok(script.trimEnd().endsWith("})(typeof window !== 'undefined' ? window : globalThis);"), 'resource ends with the script, not at a blank line');
    assert.doesNotThrow(() => new vm.Script(script), 'resource is valid JavaScript');
});

test('the uBlock Origin resource installs its hooks on twitch.tv', () => {
    const script = readUblockResources(fs.readFileSync(FILE, 'utf8')).get('twitch-videoad.js');
    const context = fakeBrowserGlobals();
    vm.runInContext(script, context);
    assert.equal(typeof context.twitchAdBlockHQ, 'object', 'console API exposed');
    assert.equal(context.twitchAdBlockHQ.getSettings().fallbackMode, 'hold');
    assert.equal(context.Worker.name, 'Worker');
    assert.match(String(context.fetch), /\[native code\]/, 'fetch is hooked');
});
