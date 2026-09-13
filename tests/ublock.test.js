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

function fakeBrowserGlobals(storage = new Map()) {
    const location = { hostname: 'www.twitch.tv', href: 'https://www.twitch.tv/somechannel', pathname: '/somechannel' };
    const noop = () => {};
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        location,
        document: { location, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [] },
        localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
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
    assert.equal(context.twitchAdBlockHQ.getSettings().fallbackMode, 'lowres');
    assert.equal(context.Worker.name, 'Worker');
    assert.match(String(context.fetch), /\[native code\]/, 'fetch is hooked');
});

test('settings stored in full by version 1.1.3 or earlier pick up new defaults and keep chosen values', () => {
    const script = readUblockResources(fs.readFileSync(FILE, 'utf8')).get('twitch-videoad.js');
    const KEY = 'twitchAdBlockHQ.settings';
    const legacy = {
        fallbackMode: 'hold', minFallbackHeight: 0, pauseDuringHold: false, resumeAtLiveEdge: true,
        backupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed'], fallbackPlayerTypes: ['autoplay/android'],
        forcePlayerType: 'popout', hideDisplayAds: true, showBanner: false, debug: false, tuning: {},
    };
    const storage = new Map([[KEY, JSON.stringify(legacy)]]);
    let context = fakeBrowserGlobals(storage);
    vm.runInContext(script, context);
    assert.equal(context.twitchAdBlockHQ.getSettings().fallbackMode, 'lowres', 'old default replaced');
    assert.equal(context.twitchAdBlockHQ.getSettings().showBanner, false, 'chosen value kept');
    assert.deepEqual(JSON.parse(storage.get(KEY)), { showBanner: false }, 'only changed settings stay stored');

    // Settings saved by newer versions only hold what the viewer changed, and are never migrated.
    storage.set(KEY, JSON.stringify({ fallbackMode: 'hold' }));
    context = fakeBrowserGlobals(storage);
    vm.runInContext(script, context);
    assert.equal(context.twitchAdBlockHQ.getSettings().fallbackMode, 'hold');
    context.twitchAdBlockHQ.setSettings({ debug: true });
    assert.deepEqual(JSON.parse(storage.get(KEY)), { fallbackMode: 'hold', debug: true });
    context.twitchAdBlockHQ.resetSettings();
    assert.equal(storage.has(KEY), false);
});
