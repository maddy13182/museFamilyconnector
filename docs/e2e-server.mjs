// Local e2e dev server: serves WS-1's compiled handlers over HTTP on
// 127.0.0.1:8787 using a FRESH in-memory SQLite DB with SETUP_LOCKED=0.
// Requires WS-1's build:  cd server && npm install && npm run build
// Run:  node docs/e2e-server.mjs &   then   HUB=http://127.0.0.1:8787 bash docs/e2e.sh
// (WS-1 may later add `npm run dev`; this harness exists so e2e runs without wrangler.)
import http from 'node:http';
import { handleRequest } from '/home/hatch/workspace/family-hub/server/dist/src/index.js';
import { freshDb, sqliteClient } from '/home/hatch/workspace/family-hub/server/dist/test/sqlite.js';

const db = sqliteClient(freshDb());
const env = { TOKEN_PEPPER: 'e2e-local-pepper-not-a-secret', SETUP_LOCKED: '0' };

const server = http.createServer(async (req, res) => {
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:8787${req.url}`, {
      method: req.method, headers, body,
    });
    const response = await handleRequest(request, db, env);
    const text = await response.text();
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    res.end(text);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'harness_error', message: String((e && e.message) || e) } }));
  }
});

server.listen(8787, '127.0.0.1', () => console.log('e2e server listening on http://127.0.0.1:8787'));
