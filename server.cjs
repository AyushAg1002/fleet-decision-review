'use strict';

// Static private review behind a server-side shared-code gate.
// Never put app.html or brief.pdf in a public/static output directory.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const COOKIE = '__Host-fleet_session';
const SESSION_SECONDS = 3600;
const BODY_LIMIT = 2048;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
const MAX_RATE_BUCKETS = 1024;

class RequestError extends Error {
  constructor(status) { super('Request rejected'); this.status = status; }
}

function configFrom(env) {
  const hash = env.DEMO_ACCESS_CODE_HASH;
  const secret = env.DEMO_SESSION_SECRET;
  const version = env.DEMO_ACCESS_VERSION;
  if (typeof hash !== 'string' || !/^[a-f\d]{64}$/i.test(hash) ||
      typeof secret !== 'string' || !/^[a-f\d]{64,256}$/i.test(secret) || secret.length % 2 ||
      typeof version !== 'string' || !/^[A-Za-z\d._-]{1,80}$/.test(version)) return null;
  return { hash: Buffer.from(hash, 'hex'), secret: Buffer.from(secret, 'hex'), version };
}

function requestOrigin(req, allowLocalHttp) {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || raw.length > 260 || !/^[a-z\d.-]+(?::\d{1,5})?$/i.test(raw)) throw new RequestError(400);
  let url;
  try { url = new URL('https://' + raw); } catch { throw new RequestError(400); }
  const hostname = url.hostname;
  if (hostname.endsWith('.') || !hostname.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new RequestError(400);
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  // Vercel terminates TLS and supplies x-forwarded-proto. Do not run this handler
  // behind a proxy that lets clients replace that header.
  const proto = req.socket?.encrypted ? 'https' : req.headers['x-forwarded-proto'];
  if (proto === 'https') return 'https://' + url.host;
  if (allowLocalHttp && local && (proto === undefined || proto === 'http')) return 'http://' + raw.toLowerCase();
  throw new RequestError(400);
}

function strictCsrf(req, origin) {
  if (typeof req.headers.origin !== 'string' || req.headers.origin !== origin) throw new RequestError(403);
}

function cookieValue(req) {
  const raw = req.headers.cookie;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const values = raw.split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '=')).map(s => s.slice(COOKIE.length + 1));
  return values.length === 1 ? values[0] : null;
}

function sign(encoded, secret) { return crypto.createHmac('sha256', secret).update(encoded).digest('base64url'); }

function issueSession(config, origin, now) {
  const payload = { v: config.version, host: origin, iat: now, exp: now + SESSION_SECONDS, nonce: crypto.randomBytes(16).toString('hex') };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + sign(encoded, config.secret);
}

function verifySession(req, config, origin, now) {
  const token = cookieValue(req);
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z\d_-]+$/.test(parts[0]) || !/^[A-Za-z\d_-]{43}$/.test(parts[1])) return null;
  const [encoded, signature] = parts;
  const received = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(sign(encoded, config.secret), 'base64url');
  if (received.length !== expected.length || received.toString('base64url') !== signature || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const p = JSON.parse(bytes.toString('utf8'));
    if (!p || p.v !== config.version || p.host !== origin ||
        !Number.isInteger(p.iat) || p.iat <= 0 || p.iat > now ||
        !Number.isInteger(p.exp) || p.exp !== p.iat + SESSION_SECONDS || p.exp <= now ||
        typeof p.nonce !== 'string' || !/^[a-f\d]{32}$/.test(p.nonce) ||
        Object.keys(p).sort().join(',') !== 'exp,host,iat,nonce,v') return null;
    return p;
  } catch { return null; }
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

function cspFor(html = '') {
  const hashes = [];
  const expression = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = expression.exec(html))) {
    if (/\bsrc\s*=/i.test(match[1])) throw new Error('Private page must use bundled inline scripts');
    const body = match[2].replace(/\r\n?/g, '\n');
    hashes.push("'sha256-" + crypto.createHash('sha256').update(body).digest('base64') + "'");
    if (hashes.length > 32) throw new Error('Too many inline scripts');
  }
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? [...new Set(hashes)].join(' ') : "'none'"}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Content-Security-Policy', cspFor());
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // no-referrer makes native POST forms send Origin:null. same-origin keeps
  // the exact Origin needed by CSRF validation without leaking to other sites.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

function loginPage(failed = false) {
  // No confidential facts, echoed input or application scripts on this page.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Private prototype review</title><style>body{font:17px/1.6 system-ui,sans-serif;background:#f2f5f7;color:#142b3f;margin:0;padding:24px}main{max-width:440px;margin:10vh auto;background:#fff;padding:32px;border:1px solid #d8e0e5;border-radius:12px}h1{font-size:26px;line-height:1.2}label,input,button{display:block;box-sizing:border-box;width:100%}input,button{font:inherit;padding:12px;margin-top:8px;border:1px solid #a7b8c5;border-radius:6px}button{background:#142b3f;color:white;cursor:pointer;margin-top:18px}small{display:block;color:#506371;margin-top:18px}.error{color:#9b2424}</style></head><body><main><h1>Private prototype review</h1><p>Enter the review code supplied by the owner. This grants access for up to one hour on this browser.</p>${failed ? '<p class="error" role="alert">Access could not be granted. Check the code or try again later.</p>' : ''}<form action="/login" method="post" autocomplete="off"><label for="code">Review code</label><input id="code" name="code" type="password" maxlength="256" autocomplete="off" spellcheck="false" required><button type="submit">Open prototype</button></form><small>This demonstration stores any actions you save in this browser only. It does not notify colleagues, dispatch vehicles or enforce operational approval. Sign out when finished; do not use a shared device for confidential notes.</small></main></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && (typeof declared !== 'string' || !/^\d+$/.test(declared))) return reject(new RequestError(400));
    if (declared !== undefined && Number(declared) > BODY_LIMIT) { req.resume(); return reject(new RequestError(413)); }
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > BODY_LIMIT) return finish(new RequestError(413));
      chunks.push(bytes);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const onAborted = () => finish(new RequestError(400));
    const onError = () => finish(new RequestError(400));
    const timer = setTimeout(() => finish(new RequestError(408)), 5000);
    timer.unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
  });
}

function clientBucket(req, secret) {
  // Best effort only. Proxy headers must be set by the trusted hosting edge.
  const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'];
  let address = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  if (!net.isIP(address)) address = req.socket?.remoteAddress || 'unknown';
  return crypto.createHmac('sha256', secret).update(String(address)).digest('hex');
}

function createHandler(options = {}) {
  const env = options.env || process.env;
  const assetDir = options.assetDir || __dirname;
  const clock = options.now || (() => Date.now());
  // This injection is for tests only. The default production export cannot enable HTTP via environment.
  const allowLocalHttp = options.allowLocalHttp === true;
  const failures = new Map();
  let cachedApp = null;
  let cachedPdf = null;

  function sweep(now) {
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
  }
  function fail(key, now) {
    if (!failures.has(key)) {
      if (failures.size >= MAX_RATE_BUCKETS) failures.delete(failures.keys().next().value);
      failures.set(key, { count: 0, until: now + LOGIN_WINDOW_SECONDS });
    }
    failures.get(key).count++;
  }
  function app() {
    if (!cachedApp) {
      const bytes = fs.readFileSync(path.join(assetDir, 'app.html'));
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Invalid private page');
      const text = bytes.toString('utf8');
      cachedApp = { bytes, csp: cspFor(text) };
    }
    return cachedApp;
  }
  function pdf() {
    if (!cachedPdf) {
      const bytes = fs.readFileSync(path.join(assetDir, 'brief.pdf'));
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid private brief');
      cachedPdf = bytes;
    }
    return cachedPdf;
  }

  return async function handler(req, res) {
    // A client can abort while its body is being drained after rejection. Keep
    // the resulting stream error from becoming an uncaught process error.
    req.on('error', () => {});
    securityHeaders(res);
    try {
      const origin = requestOrigin(req, allowLocalHttp);
      const route = req.url;
      const allowed = { '/': 'GET', '/brief.pdf': 'GET', '/login': 'POST', '/logout': 'POST', '/session': 'GET', '/robots.txt': 'GET' };
      if (typeof route !== 'string' || !Object.hasOwn(allowed, route)) return send(res, 404, 'Not found.');
      if (req.method !== allowed[route]) { res.setHeader('Allow', allowed[route]); return send(res, 405, 'Method not allowed.'); }
      if (route === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
      const config = configFrom(env);
      if (!config) return send(res, 503, 'Private review is unavailable. Contact the owner.');
      const now = Math.floor(clock() / 1000);
      if (!Number.isSafeInteger(now) || now <= 0) return send(res, 503, 'Private review is unavailable.');

      if (route === '/login') {
        strictCsrf(req, origin);
        const media = req.headers['content-type'];
        if (typeof media !== 'string' || media.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' ||
            (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) throw new RequestError(415);
        sweep(now);
        const bucket = clientBucket(req, config.secret);
        const record = failures.get(bucket);
        if (record && record.count >= MAX_FAILURES) {
          res.setHeader('Retry-After', String(Math.max(1, record.until - now)));
          req.resume();
          return send(res, 429, 'Too many unsuccessful attempts. Try again later.');
        }
        const form = new URLSearchParams(await readBody(req));
        const codes = form.getAll('code');
        const code = codes[0];
        const wellFormed = codes.length === 1 && [...form.keys()].length === 1 && typeof code === 'string' && code.length > 0 && code.length <= 256;
        const digest = crypto.createHash('sha256').update(wellFormed ? code : '').digest();
        if (!wellFormed || !crypto.timingSafeEqual(digest, config.hash)) {
          fail(bucket, now);
          return send(res, 401, loginPage(true), 'text/html; charset=utf-8');
        }
        failures.delete(bucket);
        res.setHeader('Set-Cookie', sessionCookie(issueSession(config, origin, now), SESSION_SECONDS));
        res.setHeader('Location', '/');
        return send(res, 303, 'Access granted.');
      }

      if (route === '/logout') {
        strictCsrf(req, origin);
        req.resume();
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        res.setHeader('Clear-Site-Data', '"cache", "storage"');
        res.setHeader('Location', '/');
        return send(res, 303, 'Signed out.');
      }

      const session = verifySession(req, config, origin, now);
      if (route === '/session') {
        if (!session) {
          res.setHeader('Set-Cookie', sessionCookie('', 0));
          return send(res, 401, JSON.stringify({ authenticated: false }), 'application/json; charset=utf-8');
        }
        return send(res, 200, JSON.stringify({ authenticated: true, expiresAt: session.exp * 1000 }), 'application/json; charset=utf-8');
      }
      if (!session) {
        if (cookieValue(req)) res.setHeader('Set-Cookie', sessionCookie('', 0));
        if (route === '/') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
        return send(res, 401, 'Access required.');
      }
      if (route === '/') {
        const privateApp = app();
        res.setHeader('Content-Security-Policy', privateApp.csp);
        return send(res, 200, privateApp.bytes, 'text/html; charset=utf-8');
      }
      res.setHeader('Content-Disposition', 'inline; filename="Case_Study_Brief.pdf"');
      return send(res, 200, pdf(), 'application/pdf');
    } catch (error) {
      if (!res.headersSent) return send(res, error instanceof RequestError ? error.status : 503, error instanceof RequestError ? 'Request rejected.' : 'Private review is unavailable.');
      if (!res.writableEnded) res.end();
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.constants = Object.freeze({ COOKIE, SESSION_SECONDS, BODY_LIMIT, LOGIN_WINDOW_SECONDS, MAX_FAILURES, MAX_RATE_BUCKETS });
