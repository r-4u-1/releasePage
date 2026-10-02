// A tiny web framework on Node's built-in http module.
//
//   const app = createApp({ before });       before(req) runs first on every request
//   app.get('/api/apps/:app', handler);      :app ends up in req.params.app
//   app.post('/api/release', handler);       JSON bodies end up in req.body
//
// A handler returns an object (sent as JSON), a string (sent as HTML), or nothing
// (it answered itself, e.g. with sendFile). To fail, throw new HttpError(status, message):
// the browser gets { ok: false, message }.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res, file) {
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file)
    .on('error', () => sendJson(res, 404, { ok: false, message: 'Not found' }))
    .pipe(res);
}

// Reads the whole body, but keeps at most `limit` bytes of it.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) reject(new HttpError(413, 'Request body too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJson(req, text) {
  if (!text || !/^application\/json/i.test(req.headers['content-type'] || '')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Finds the route for a method + path, and collects its :params.
function findRoute(routes, method, pathname) {
  const parts = pathname.split('/');
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== parts.length) continue;
    const params = {};
    const matches = route.parts.every((part, i) => {
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(parts[i]);
      return part.startsWith(':') || part === parts[i];
    });
    if (matches) return { handler: route.handler, params };
  }
  return null;
}

function createApp({ bodyLimit = 100 * 1024, before = () => {} } = {}) {
  const routes = [];

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      before(req);
      const route = findRoute(routes, req.method, url.pathname);
      if (!route) throw new HttpError(404, 'Not found');

      req.params = route.params;
      req.query = Object.fromEntries(url.searchParams);
      req.body = parseJson(req, await readBody(req, bodyLimit));

      const result = await route.handler(req, res);
      if (typeof result === 'string') {
        res.setHeader('Content-Type', TYPES['.html']);
        res.end(result);
      } else if (result !== undefined) {
        sendJson(res, 200, result);
      }
    } catch (err) {
      // URIError: a broken %-escape in the address.
      const status = err.status || (err instanceof URIError ? 400 : 500);
      if (status >= 500) console.error('[server]', err.message);
      const message = err instanceof HttpError || status === 400 ? err.message : 'Server error';
      if (res.headersSent) res.end();
      else sendJson(res, status, { ok: false, message });
    }
  }

  const addRoute = method => (routePath, handler) => {
    routes.push({ method, parts: routePath.split('/'), handler });
  };

  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    listen: (...args) => http.createServer(handle).listen(...args),
  };
}

module.exports = { createApp, HttpError, sendFile };
