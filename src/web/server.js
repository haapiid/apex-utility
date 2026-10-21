const http = require('http');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const webAuthService = require('../services/webAuthService');
const { UserError, friendlyError } = require('../services/tradeCommon');
const logger = require('../utils/logger');

// ApeX Pro web server (no framework): static files from webapp/ and a JSON API under /api.
// Security: HttpOnly SameSite=Strict session cookie; state-changing requests need the X-ApeX header and
// a JSON body (a cross-site form can't send either); Origin is checked when present; per-IP rate limits.

const STATIC_ROOT = path.join(__dirname, '..', '..', 'webapp');
// Brand images (logo, favicons) are shared with the landing page instead of copied
const IMG_ROOT = path.join(__dirname, '..', '..', 'website', 'img');
const COOKIE = 'apex_session';
const MAX_BODY = 64 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

// ---------- rate limiting (fixed window per IP and bucket) ----------

const hits = new Map();
function limited(ip, bucket, max, windowMs = 60_000) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > windowMs) {
    hits.set(key, { start: now, n: 1 });
    return false;
  }
  entry.n++;
  return entry.n > max;
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, 60_000).unref();

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// BigInt → string in every JSON response
const json = (value) => JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(json(body));
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim().split('='))
      .filter(([k, v]) => k && v != null)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

function sessionCookie(token, maxAgeSec) {
  const secure = config.web.publicUrl.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || 'unknown';

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([config.web.publicUrl, `http://${req.headers.host}`, `https://${req.headers.host}`]);
  return allowed.has(origin);
}

// ---------- static files ----------

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const root = rel.startsWith('img/') ? IMG_ROOT : STATIC_ROOT;
  const file = path.normalize(path.join(root, rel.startsWith('img/') ? rel.slice(4) : rel));
  if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // Revalidate everything: a deploy must never leave users on stale JS/CSS (the app is small)
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

// ---------- routing ----------

/**
 * routes: [{ method, path: '/api/x/:id', auth: bool, handler(ctx) }]
 * ctx: { req, res, ip, userId, params, query, body, setCookie(value) }
 */
function compile(routes) {
  return routes.map((r) => {
    const keys = [];
    const pattern = new RegExp(`^${r.path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    return { ...r, pattern, keys };
  });
}

function createWebServer(routes) {
  const table = compile(routes);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    try {
      if (limited(ip, 'api', 240)) throw new HttpError(429, 'Too many requests. Slow down a little.');
      const route = table.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'Not found');

      const mutating = req.method !== 'GET';
      if (mutating) {
        if (req.headers['x-apex'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(403, 'Missing request header');
        }
        if (!originAllowed(req)) throw new HttpError(403, 'Bad origin');
      }

      const cookies = parseCookies(req.headers.cookie);
      const userId = webAuthService.sessionUser(cookies[COOKIE]);
      if (route.auth && !userId) throw new HttpError(401, 'Log in first.');

      const match = route.pattern.exec(url.pathname);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = mutating ? await readBody(req) : {};
      const headers = {};
      const result = await route.handler({
        req,
        res,
        ip,
        userId,
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        sessionToken: cookies[COOKIE],
        setCookie: (value) => (headers['Set-Cookie'] = value),
        limited: (bucket, max, windowMs) => limited(ip, bucket, max, windowMs),
      });
      // OAuth hops answer with a redirect instead of JSON
      if (result?.redirect) {
        res.writeHead(302, { Location: result.redirect, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
        return res.end();
      }
      send(res, 200, result ?? { ok: true }, headers);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof UserError) return send(res, 400, { error: err.message });
      logger.error({ path: url.pathname, err: err.message, stack: err.stack }, 'Web API error');
      send(res, 500, { error: friendlyError(err) });
    }
  });
}

module.exports = { createWebServer, HttpError, sessionCookie, COOKIE };
