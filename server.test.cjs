'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createHandler, constants } = require('./server.cjs');

const PRIVATE = 'PRIVATE_FIXTURE_NOT_FOR_ANONYMOUS_VISITORS';
const script = 'window.fixture=true;';
const app = `<!doctype html><html><head></head><body>${PRIVATE}<script>${script}</script></body></html>`;
const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-server-tests-'));
fs.writeFileSync(path.join(assetDir, 'app.html'), app);
fs.writeFileSync(path.join(assetDir, 'brief.pdf'), '%PDF-1.4\n' + PRIVATE);
test.after(() => fs.rmSync(assetDir, { recursive: true, force: true }));

function setup(extra = {}) {
  const code = crypto.randomBytes(24).toString('base64url');
  const env = { DEMO_ACCESS_CODE_HASH: crypto.createHash('sha256').update(code).digest('hex'), DEMO_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DEMO_ACCESS_VERSION: 'test-v1' };
  let time = 1800000000000;
  return { code, env, handler: createHandler({ env, assetDir, now: () => time, ...extra }), advance: seconds => { time += seconds * 1000; } };
}

async function request(handler, route = '/', { method = 'GET', body = '', chunks, stream, headers = {}, cookie, host = 'private.example.test' } = {}) {
  const req = stream || Readable.from(chunks || (body ? [Buffer.from(body)] : []));
  req.url = route;
  req.method = method;
  req.headers = { host, 'x-forwarded-proto': 'https', ...headers };
  if (cookie) req.headers.cookie = cookie;
  req.socket = { remoteAddress: '192.0.2.20', encrypted: false };
  const out = { statusCode: 200, headers: {}, body: '', headersSent: false, writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value === undefined ? '' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value); this.headersSent = true; this.writableEnded = true; }
  };
  await handler(req, out);
  return out;
}

async function login(s, code = s.code, extra = {}) {
  return request(s.handler, '/login', { method: 'POST', body: new URLSearchParams({ code }).toString(), headers: { origin: 'https://private.example.test', 'content-type': 'application/x-www-form-urlencoded', ...(extra.headers || {}) }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'headers')) });
}

function cookieFrom(response) { return response.headers['set-cookie'].split(';')[0]; }
function noPrivate(response) { assert.ok(!response.body.includes(PRIVATE)); }
function secured(response) {
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'same-origin');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(response.headers['content-security-policy']));
}

test('CommonJS export is a request handler', () => assert.equal(typeof require('./server.cjs'), 'function'));

test('anonymous visitors receive only login; private assets cannot be read directly', async () => {
  const s = setup({ assetDir: '/does-not-exist' });
  const r = await request(s.handler);
  assert.equal(r.statusCode, 200); assert.match(r.body, /Review code/); noPrivate(r); secured(r);
  for (const route of ['/brief.pdf', '/session']) {
    const out = await request(s.handler, route); assert.equal(out.statusCode, 401); noPrivate(out); secured(out);
  }
  for (const route of ['/app.html', '/data.json', '/src/app.js', '/protected_server.cjs', '/.env', '/../app.html', '/%2e%2e/app.html', '/?code=secret', '/brief.pdf?x=1']) {
    const out = await request(s.handler, route); assert.equal(out.statusCode, 404, route); noPrivate(out); secured(out);
  }
});

test('valid code issues host-only secure cookie and serves private HTML/PDF', async () => {
  const s = setup(), r = await login(s);
  assert.equal(r.statusCode, 303); assert.equal(r.headers.location, '/');
  assert.match(r.headers['set-cookie'], /^__Host-fleet_session=/);
  for (const fragment of ['Path=/', 'Max-Age=3600', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(r.headers['set-cookie'].includes(fragment));
  assert.ok(!r.headers['set-cookie'].includes('Domain='));
  assert.ok(!r.body.includes(s.code)); secured(r);
  const cookie = cookieFrom(r), page = await request(s.handler, '/', { cookie });
  assert.equal(page.statusCode, 200); assert.equal(page.body, app); secured(page);
  const expectedHash = crypto.createHash('sha256').update(script).digest('base64');
  assert.ok(page.headers['content-security-policy'].includes("'sha256-" + expectedHash + "'"));
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  const pdf = await request(s.handler, '/brief.pdf', { cookie });
  assert.equal(pdf.statusCode, 200); assert.equal(pdf.headers['content-type'], 'application/pdf'); assert.ok(pdf.body.startsWith('%PDF-')); secured(pdf);
  const session = await request(s.handler, '/session', { cookie });
  assert.equal(session.statusCode, 200); assert.deepEqual(JSON.parse(session.body), { authenticated: true, expiresAt: 1800003600000 });
  for (const route of ['/app.html', '/protected_server.cjs', '/missing', '/brief.pdf?download=1']) assert.equal((await request(s.handler, route, { cookie })).statusCode, 404);
});

test('wrong/empty/duplicate codes never echo input or expose private data', async () => {
  const s = setup();
  const wrong = await login(s, '<script>PRIVATE_ATTACK</script>');
  assert.equal(wrong.statusCode, 401); assert.ok(!wrong.body.includes('PRIVATE_ATTACK')); assert.equal(wrong.headers['set-cookie'], undefined); noPrivate(wrong); secured(wrong);
  assert.equal((await login(s, '')).statusCode, 401);
  const duplicate = await login(s, s.code, { body: 'code=' + s.code + '&code=' + s.code });
  assert.equal(duplicate.statusCode, 401);
  assert.equal((await login(s, s.code, { body: 'code=' + s.code + '&extra=x' })).statusCode, 401);
});

test('tampered signature/payload, malformed and duplicate session cookies fail closed', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  const [name, token] = cookie.split('=');
  const [encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); payload.exp += 3600;
  const bad = [name + '=' + encoded + '.' + (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1), name + '=' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature, name + '=broken', cookie + '; ' + cookie, name + '=' + 'x'.repeat(9000)];
  for (const value of bad) {
    const r = await request(s.handler, '/brief.pdf', { cookie: value }); assert.equal(r.statusCode, 401); noPrivate(r);
  }
});

test('sessions expire at one hour and cannot be replayed on a different host', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  assert.equal((await request(s.handler, '/brief.pdf', { cookie, host: 'another.example.test' })).statusCode, 401);
  s.advance(3599); assert.equal((await request(s.handler, '/session', { cookie })).statusCode, 200);
  s.advance(1); const expired = await request(s.handler, '/session', { cookie });
  assert.equal(expired.statusCode, 401); assert.deepEqual(JSON.parse(expired.body), { authenticated: false }); assert.match(expired.headers['set-cookie'], /Max-Age=0/);
  const page = await request(s.handler, '/', { cookie }); assert.match(page.body, /Review code/); noPrivate(page);
});

test('access-version and signing-secret rotation invalidate existing sessions', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  s.env.DEMO_ACCESS_VERSION = 'test-v2'; assert.equal((await request(s.handler, '/session', { cookie })).statusCode, 401);
  const next = cookieFrom(await login(s));
  s.env.DEMO_SESSION_SECRET = crypto.randomBytes(32).toString('hex'); assert.equal((await request(s.handler, '/session', { cookie: next })).statusCode, 401);
});

test('missing or invalid configuration never serves confidential content', async () => {
  for (const [key, value] of [['DEMO_ACCESS_CODE_HASH', ''], ['DEMO_ACCESS_CODE_HASH', 'not-hex'], ['DEMO_SESSION_SECRET', 'ab'.repeat(31)], ['DEMO_SESSION_SECRET', 'abc'], ['DEMO_ACCESS_VERSION', ''], ['DEMO_ACCESS_VERSION', 'unsafe version']]) {
    const s = setup(); s.env[key] = value;
    for (const route of ['/', '/brief.pdf', '/session']) { const r = await request(s.handler, route); assert.equal(r.statusCode, 503, key); noPrivate(r); secured(r); }
    assert.equal((await login(s)).statusCode, 503);
  }
});

test('login and logout require exact same-origin Origin header', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  for (const origin of [undefined, 'null', 'https://evil.example', 'http://private.example.test', 'https://private.example.test.evil.example']) {
    assert.equal((await login(s, s.code, { headers: { origin } })).statusCode, 403);
    const r = await request(s.handler, '/logout', { method: 'POST', cookie, headers: { origin } }); assert.equal(r.statusCode, 403); assert.equal(r.headers['set-cookie'], undefined);
  }
  assert.equal((await request(s.handler, '/session', { cookie })).statusCode, 200);
});

test('logout clears cookie and browser storage/cache without granting access', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  const r = await request(s.handler, '/logout', { method: 'POST', cookie, headers: { origin: 'https://private.example.test' } });
  assert.equal(r.statusCode, 303); assert.match(r.headers['set-cookie'], /Max-Age=0/); assert.equal(r.headers['clear-site-data'], '"cache", "storage"'); assert.equal(r.headers.location, '/'); secured(r);
});

test('request bodies are bounded by declared and actual byte count', async () => {
  const s = setup();
  assert.equal((await login(s, s.code, { headers: { 'content-length': '2049' } })).statusCode, 413);
  assert.equal((await login(s, s.code, { chunks: [Buffer.alloc(1024, 'a'), Buffer.alloc(1025, 'b')] })).statusCode, 413);
  assert.equal((await login(s, s.code, { headers: { 'content-length': 'NaN' } })).statusCode, 400);
  assert.equal((await login(s, s.code, { headers: { 'content-type': 'application/json' } })).statusCode, 415);
  assert.equal((await login(s, s.code, { headers: { 'content-encoding': 'gzip' } })).statusCode, 415);
});

test('an aborted body fails closed and a later stream error does not crash the process', async () => {
  const s = setup();
  const stream = new Readable({ read() { this.emit('aborted'); this.destroy(new Error('Synthetic client reset')); } });
  const r = await login(s, s.code, { stream });
  assert.equal(r.statusCode, 400); noPrivate(r); secured(r);
  await new Promise(resolve => setImmediate(resolve));
});

test('signed but invalid claim shapes or excessive session lifetime are rejected', async () => {
  const s = setup(), cookie = cookieFrom(await login(s));
  const token = cookie.split('=')[1];
  const original = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const invalid = [
    { ...original, exp: original.exp + 1 },
    { ...original, iat: original.iat + 60, exp: original.exp + 60 },
    { ...original, nonce: 'short' },
    { ...original, extra: 'unexpected' },
    { ...original, host: 'https://other.example.test' }
  ];
  for (const claims of invalid) {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signed = crypto.createHmac('sha256', Buffer.from(s.env.DEMO_SESSION_SECRET, 'hex')).update(encoded).digest('base64url');
    const r = await request(s.handler, '/brief.pdf', { cookie: constants.COOKIE + '=' + encoded + '.' + signed });
    assert.equal(r.statusCode, 401); noPrivate(r);
  }
});

test('best-effort rate limit blocks repeated failures and expires after window', async () => {
  const s = setup();
  for (let i = 0; i < constants.MAX_FAILURES; i++) assert.equal((await login(s, 'wrong')).statusCode, 401);
  const limited = await login(s); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '900');
  assert.equal((await login(s, s.code, { headers: { 'x-forwarded-for': '192.0.2.21' } })).statusCode, 303);
  s.advance(constants.LOGIN_WINDOW_SECONDS); assert.equal((await login(s)).statusCode, 303);
});

test('production export requires HTTPS and Host validation rejects ambiguous input', async () => {
  const s = setup();
  for (const host of ['private.example.test,evil.test', 'user@evil.test', 'evil.test/path', 'evil.test\\path', 'evil.test.', 'a..test', 'evil.test:99999']) assert.equal((await request(s.handler, '/', { host })).statusCode, 400, host);
  assert.equal((await request(s.handler, '/', { headers: { 'x-forwarded-proto': 'http' } })).statusCode, 400);
  const local = setup({ allowLocalHttp: true });
  assert.equal((await request(local.handler, '/', { host: '127.0.0.1:8917', headers: { 'x-forwarded-proto': 'http' } })).statusCode, 200);
  assert.equal((await request(local.handler, '/', { host: 'public.example.test', headers: { 'x-forwarded-proto': 'http' } })).statusCode, 400);
});

test('only explicitly allowed methods/routes exist; robots disallows crawling', async () => {
  const s = setup();
  for (const [route, method] of [['/login', 'GET'], ['/logout', 'GET'], ['/', 'POST'], ['/session', 'POST'], ['/brief.pdf', 'HEAD']]) {
    const r = await request(s.handler, route, { method }); assert.equal(r.statusCode, 405); noPrivate(r); secured(r);
  }
  const r = await request(s.handler, '/robots.txt'); assert.equal(r.statusCode, 200); assert.equal(r.body, 'User-agent: *\nDisallow: /\n');
});

test('unavailable private files and external script assets fail closed after auth', async () => {
  const s = setup({ assetDir: '/does-not-exist' }), cookie = cookieFrom(await login(s));
  for (const route of ['/', '/brief.pdf']) { const r = await request(s.handler, route, { cookie }); assert.equal(r.statusCode, 503); noPrivate(r); secured(r); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-invalid-page-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.html'), '<script src="https://external.example/test.js"></script>');
    const bad = setup({ assetDir: dir }), session = cookieFrom(await login(bad));
    assert.equal((await request(bad.handler, '/', { cookie: session })).statusCode, 503);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
