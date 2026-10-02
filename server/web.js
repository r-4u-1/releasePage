// A tiny web framework on Node's built-in http module — just what this tool needs:
// routes with :params, middleware, JSON bodies, and res.status().json() / send() / sendFile().
const http = require('node:http');
const fs = require('node:fs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function createApp({ bodyLimit = 100 * 1024 } = {}) {
  const middleware = [];
  const routes = [];

  const route = method => (path, ...handlers) => {
    routes.push({ method, parts: path.split('/'), handlers });
  };

  // Matches "/api/apps/:app/tags" against a URL path; returns the params or null.
  function match(r, method, pathname) {
    if (r.method !== method) return null;
    const parts = pathname.split('/');
    if (parts.length !== r.parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (r.parts[i] !== parts[i]) return null;
    }
    return params;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return resolve(undefined);
      let size = 0;
      const chunks = [];
      const onData = c => {
        size += c.length;
        if (size <= bodyLimit) return chunks.push(c);
        // Too big: stop keeping it, let the rest drain, and answer 413.
        req.off('data', onData);
        req.resume();
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      };
      req.on('data', onData);
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : undefined); }
        catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function extend(res) {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    };
    res.send = text => {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(String(text));
    };
    res.sendFile = file => {
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      fs.createReadStream(file)
        .on('open', () => res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream'))
        .on('error', () => { if (!res.headersSent) res.status(404).send('Not found'); })
        .pipe(res);
    };
  }

  // Runs handlers in order; each one either answers or calls next().
  async function run(handlers, req, res) {
    for (const h of handlers) {
      let calledNext = false;
      await h(req, res, () => { calledNext = true; });
      if (!calledNext) return true;
    }
    return false;
  }

  async function handle(req, res) {
    extend(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(url.searchParams);
      if (await run(middleware, req, res)) return;  // a middleware answered (e.g. 403)

      let params = null;
      const r = routes.find(r => (params = match(r, req.method, url.pathname)));
      if (!r) return res.status(404).json({ ok: false, message: 'Not found' });
      req.params = params;
      req.body = await readJson(req);
      await run(r.handlers, req, res);
    } catch (err) {
      const status = err.status || (err instanceof URIError ? 400 : 500);
      if (status === 500) console.error('[server]', err);
      if (!res.headersSent) res.status(status).json({ ok: false, message: status === 500 ? 'Server error' : err.message });
      else res.end();
    }
  }

  return {
    use: fn => middleware.push(fn),
    get: route('GET'),
    post: route('POST'),
    listen: (...args) => http.createServer(handle).listen(...args),
  };
}

module.exports = { createApp };
