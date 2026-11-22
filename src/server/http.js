// Small HTTP helpers: origin checks, JSON/HTML/JS replies and body reading.
import fs from 'node:fs';
import path from 'node:path';

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

// Security: the board listens on every interface, and Host is the caller's to
// write, so the owner must also arrive on a loopback socket. A local reverse
// proxy can send a loopback Host (a link gateway sends `Host: localhost:PORT`),
// so a request carrying proxy headers is never the tokenless owner. A proxy that
// adds none is covered by the control token runBoard requires for the owner
// while a link is set.
export function isDirectLocalRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = String(req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  return !PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

/** True for 127.0.0.0/8 and ::1, including the IPv4-mapped form a dual-stack socket reports. */
export function isLoopbackAddress(address) {
  const a = String(address || '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// True when an Origin header (if present) belongs to this board's own server.
// Same-origin fetches send no Origin or our own; a foreign Origin is a
// cross-site POST and must not be allowed to open a local file.
export function sameOrigin(req, port, extraHosts = [], extraOrigins = []) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (extraOrigins.includes(u.origin)) return true;
    if (u.port !== String(port)) return false;
    return new Set(['127.0.0.1', 'localhost', ...extraHosts.filter(Boolean)]).has(u.hostname);
  } catch {
    return false;
  }
}

export function sendJson(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function sendHtml(res, body, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;

/**
 * Serves the bytes of an agent-written `data:image/...;base64` URI. Security: the
 * MIME is the agent's, so only image types pass, and the sandbox CSP keeps an SVG
 * opened as its own page from running script on the board's origin.
 * Returns false (nothing written) when the value is not such a URI.
 */
export function sendDataImage(res, dataUri) {
  const m = typeof dataUri === 'string' ? dataUri.match(DATA_IMAGE) : null;
  if (!m) return false;
  res.writeHead(200, {
    'content-type': m[1], 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(Buffer.from(m[2], 'base64'));
  return true;
}

export function sendJs(res, body) {
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// Serves a file from a fixed directory, rejecting any path that escapes it
// (no traversal). Returns false (404 not written) when the file is missing.
export function sendFromDir(res, dir, name, contentType) {
  const target = path.resolve(dir, name);
  if (target !== dir && !target.startsWith(dir + path.sep)) return false;
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    return false;
  }
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Loaded into every custom-HTML iframe so users can hover any element to leave a
// comment (relayKit.annotate.auto). Idempotent with an author-added /kit.js, and
// a no-op when the author opts out via data-relay-annotate="off".
const ANNOTATE_BOOTSTRAP =
  '<script>(function(){function go(){try{window.relayKit&&window.relayKit.annotate&&window.relayKit.annotate.auto();}catch(e){}}' +
  'if(window.relayKit&&window.relayKit.annotate)return go();' +
  "var s=document.createElement('script');s.src='/kit.js';s.onload=go;s.onerror=go;" +
  '(document.head||document.documentElement).appendChild(s);})();<\/script>';

// Insert a snippet right before </body> (else </html>, else append).
function injectBeforeBodyEnd(html, snippet) {
  const lower = html.toLowerCase();
  let idx = lower.lastIndexOf('</body>');
  if (idx === -1) idx = lower.lastIndexOf('</html>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

// Custom-HTML fragments (no <html> tag) get wrapped in a minimal document that
// matches the user's theme, so e.g. "<b>hi</b>" doesn't paint a stark white
// block in dark mode. Full documents are served verbatim — their authors can
// read the ?theme=light|dark query param themselves. The annotate bootstrap is
// omitted for read-only shares so their iframe content has no false comment
// affordances; existing feedback remains visible in the parent comments rail.
export function wrapFragment(content, theme, annotate = true) {
  if (/<html[\s>]/i.test(content)) return annotate ? injectBeforeBodyEnd(content, ANNOTATE_BOOTSTRAP) : content;
  const dark = theme === 'dark';
  const bg = dark ? '#282624' : '#ffffff';
  const fg = dark ? '#edeae4' : '#1c1b19';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:${dark ? 'dark' : 'light'}}body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:${bg};color:${fg}}</style></head><body>${content}${annotate ? ANNOTATE_BOOTSTRAP : ''}</body></html>`;
}
