'use strict';

// Browser-session regression tests. Runs the shipped script in a VM with a
// deterministic clock, in-memory storage and simulated fetch; no network/UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sessionSource = fs.readFileSync(path.resolve(__dirname,
  'session.js'), 'utf8');
const START = 1_800_000_000_000;

async function flushPromises() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness(fetchImpl) {
  let now = START;
  let nextTimerId = 1;
  const timers = new Map();
  const listeners = { window: new Map(), document: new Map() };
  const requests = [];
  const redirects = [];
  const dispatchedEvents = [];
  const localStorage = {
    'fleet-review-v1:O:Northwind': 'private action note',
    'fleet-review-v1:S:Client': 'another private action note',
    'unrelated-preference': 'keep me',
  };
  Object.defineProperty(localStorage, 'removeItem', {
    value(key) { delete localStorage[key]; },
  });
  function addListener(target, name, fn) {
    if (!listeners[target].has(name)) listeners[target].set(name, []);
    listeners[target].get(name).push(fn);
  }
  function schedule(fn, delay, interval = false) {
    const id = nextTimerId++;
    timers.set(id, { fn, due: now + Number(delay || 0), interval: interval ? Number(delay) : 0 });
    return id;
  }
  let bodyHTML = 'confidential app content';
  const body = {
    get innerHTML() { return bodyHTML; },
    set innerHTML(value) { bodyHTML = String(value); },
    get textContent() { return bodyHTML.replace(/<[^>]*>/g, ''); },
    set textContent(value) { bodyHTML = String(value); },
  };
  const document = {
    body,
    documentElement: { style: { visibility: '' } },
    visibilityState: 'visible',
    addEventListener: (name, fn) => addListener('document', name, fn),
  };
  const window = {
    FLEET_DATA: { marker: 'confidential data reference' },
    addEventListener: (name, fn) => addListener('window', name, fn),
    dispatchEvent(event) {
      dispatchedEvents.push(event.type);
      for (const fn of listeners.window.get(event.type) || []) fn(event);
      return true;
    },
  };
  const context = vm.createContext({
    AbortController,
    Event,
    Date: { now: () => now },
    localStorage,
    document,
    window,
    location: { replace: url => redirects.push(url) },
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl({ url, options, now, requestNumber: requests.length });
    },
  });
  vm.runInContext(sessionSource, context, { filename: 'session.js', timeout: 1000 });
  return {
    document, window, localStorage, redirects, requests, dispatchedEvents,
    async emit(target, name, event = {}) {
      for (const fn of listeners[target].get(name) || []) fn(event);
      await flushPromises();
    },
    async advance(ms) {
      const target = now + ms;
      let executed = 0;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, item]) => item.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++executed <= 100, 'timer execution remains bounded');
        const [id, item] = next;
        now = item.due;
        if (item.interval) item.due += item.interval;
        else timers.delete(id);
        item.fn();
        await flushPromises();
      }
      now = target;
      await flushPromises();
    },
    jumpWithoutTimers(ms) { now += ms; },
  };
}

function authenticated(expiresAt) {
  return Promise.resolve({ ok: true, json: async () => ({ authenticated: true, expiresAt }) });
}

function pendingUntilAborted({ options }) {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(new Error('aborted'));
    else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function assertNotesCleared(h) {
  assert.equal(Object.keys(h.localStorage).some(key => key.startsWith('fleet-review-v1:')), false);
  assert.equal(h.localStorage['unrelated-preference'], 'keep me');
}

function assertLocked(h) {
  assert.deepEqual(h.redirects, [], 'locking must not automatically reload or navigate');
  assert.match(h.document.body.textContent, /Session locked/);
  assert.doesNotMatch(h.document.body.textContent, /confidential app content/);
  assert.match(h.document.body.innerHTML, /href="\/">Reopen prototype<\/a>/);
  assert.equal(h.document.documentElement.style.visibility, '', 'the lock panel must remain visible');
  assert.equal(h.window.FLEET_DATA, undefined, 'the exposed data reference is removed');
  assert.deepEqual(h.dispatchedEvents, ['fleet-session-ended'], 'lock event fires exactly once');
  assert.equal(h.localStorage['fleet-review-v1:O:Northwind'], 'private action note');
  assert.equal(h.localStorage['fleet-review-v1:S:Client'], 'another private action note');
  assert.equal(h.localStorage['unrelated-preference'], 'keep me');
}

test('a hung session fetch is aborted at 8 seconds and locks content while preserving notes', async () => {
  const h = harness(pendingUntilAborted);
  await h.emit('window', 'pageshow');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/session');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.credentials, 'same-origin');
  await h.advance(7999);
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.deepEqual(h.redirects, []);
  await h.advance(1);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assertLocked(h);
  await h.advance(60_000);
  assert.equal(h.requests.length, 1, 'leaving prevents subsequent checks');
  assertLocked(h);
});

test('a stalled response body is bounded by the same 8-second timeout', async () => {
  const h = harness(({ options }) => Promise.resolve({
    ok: true,
    json: () => pendingUntilAborted({ options }),
  }));
  await h.emit('window', 'pageshow');
  await h.advance(8000);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assertLocked(h);
});

test('successful authenticated state preserves notes, restores visibility and cancels timeout', async () => {
  const h = harness(() => authenticated(START + 120_000));
  await h.emit('window', 'pageshow', { persisted: true });
  assert.equal(h.document.documentElement.style.visibility, '');
  await h.advance(8000);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.document.body.textContent, 'confidential app content');
  assert.equal(h.localStorage['fleet-review-v1:O:Northwind'], 'private action note');
  assert.equal(h.window.FLEET_DATA.marker, 'confidential data reference');
  assert.deepEqual(h.dispatchedEvents, []);
  assert.equal(h.requests[0].options.signal.aborted, false, 'successful check removes its timeout');
});

test('known expiry locks the page even while a later session request is pending', async () => {
  const h = harness(args => args.requestNumber === 1
    ? authenticated(START + 5000) : pendingUntilAborted(args));
  await h.emit('window', 'pageshow');
  await h.advance(1000);
  await h.emit('document', 'visibilitychange');
  assert.equal(h.requests.length, 2);
  await h.advance(3999);
  assert.deepEqual(h.redirects, []);
  await h.advance(1);
  assertLocked(h);
  await h.advance(4000);
  assertLocked(h); // Later abort must not navigate or emit a second lock event.
});

test('a resumed page checks known expiry before fetching or waiting on an existing request', async () => {
  const h = harness(args => args.requestNumber === 1
    ? authenticated(START + 5000) : pendingUntilAborted(args));
  await h.emit('window', 'pageshow');
  await h.advance(1000);
  await h.emit('document', 'visibilitychange');
  h.jumpWithoutTimers(4000); // Simulates a suspended/throttled browser tab.
  await h.emit('document', 'visibilitychange');
  assert.equal(h.requests.length, 2, 'expired state must not wait for another fetch');
  assertLocked(h);
});

test('missing, non-numeric, non-finite and already-expired expiry values fail closed', async () => {
  for (const expiresAt of [undefined, '1800000010000', NaN, Infinity, START, START - 1]) {
    const h = harness(() => authenticated(expiresAt));
    await h.emit('window', 'pageshow');
    assertLocked(h);
  }
});

test('unauthenticated or failed session responses lock visible content and preserve notes', async () => {
  for (const fetchImpl of [
    () => Promise.resolve({ ok: false }),
    () => Promise.resolve({ ok: true, json: async () => ({ authenticated: false, expiresAt: START + 60_000 }) }),
    () => Promise.reject(new Error('offline')),
  ]) {
    const h = harness(fetchImpl);
    await h.emit('window', 'pageshow');
    assertLocked(h);
  }
});

test('a restored page shows its lock panel when access validation fails', async () => {
  const h = harness(() => Promise.resolve({ ok: false }));
  await h.emit('window', 'pageshow', { persisted: true });
  assertLocked(h);
  await h.emit('window', 'pageshow', { persisted: true });
  assertLocked(h); // Returning to an already-locked page must remain visible too.
  assert.equal(h.requests.length, 1);
});

test('the lock event reaches lifecycle listeners and later signals cannot restart checks', async () => {
  const h = harness(() => Promise.resolve({ ok: false }));
  let lifecycleStops = 0;
  h.window.addEventListener('fleet-session-ended', () => { lifecycleStops++; });
  await h.emit('window', 'pageshow');
  assertLocked(h);
  assert.equal(lifecycleStops, 1);
  await h.emit('document', 'visibilitychange');
  await h.emit('window', 'storage', { key: 'fleet-review-v1:O:Northwind', newValue: null });
  await h.advance(120_000);
  assert.equal(h.requests.length, 1);
  assert.equal(lifecycleStops, 1);
  assertLocked(h);
});

test('logout clears only demo notes and allows navigation past the unsaved-draft guard', async () => {
  const h = harness(() => authenticated(START + 120_000));
  await h.emit('document', 'submit', { target: { id: 'unrelated-form' } });
  assert.equal(h.localStorage['fleet-review-v1:O:Northwind'], 'private action note');
  let stopped = 0;
  await h.emit('window', 'beforeunload', { stopImmediatePropagation() { stopped++; } });
  assert.equal(stopped, 0);
  await h.emit('document', 'submit', { target: { id: 'logout-form' } });
  assertNotesCleared(h);
  await h.emit('window', 'beforeunload', { stopImmediatePropagation() { stopped++; } });
  assert.equal(stopped, 1);
  await h.emit('window', 'pageshow');
  assert.equal(h.requests.length, 0, 'explicit logout suppresses further checks');
  assert.deepEqual(h.redirects, [], 'server form submission owns logout navigation');
});
