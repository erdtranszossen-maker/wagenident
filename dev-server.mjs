// Lokaler Entwicklungs-Server: serviert /public statisch und routet /api/ocr an die Function.
// Vision wird gemockt, wenn GOOGLE_VISION_API_KEY nicht gesetzt ist.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const USE_MOCK = !process.env.GOOGLE_VISION_API_KEY;

// Mock Vision für lokales Testen
if (USE_MOCK) {
  process.env.GOOGLE_VISION_API_KEY = 'mock-key';
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('vision.googleapis.com')) {
      // Liefere einen deterministischen Mock-Response zurück
      const body = JSON.parse(init.body);
      const b64 = body.requests[0].image.content;
      // Wenn das Bild groß genug ist, simulieren wir eine erkannte Nummer
      const text = b64.length > 100 ? '31 81 6650 286-0' : '';
      const mock = {
        responses: [{
          fullTextAnnotation: {
            text,
            pages: text ? [{
              confidence: 0.95,
              blocks: [{ paragraphs: [{ words: text.split(/\s+/).map((w,i) => ({
                confidence: 0.95,
                symbols: w.split('').map(c => ({ text: c })),
                boundingBox: { vertices: [{x:i*40,y:50},{x:i*40+30,y:50},{x:i*40+30,y:70},{x:i*40,y:70}] }
              })) }] }]
            }] : []
          }
        }]
      };
      return { ok: true, status: 200, json: async () => mock, text: async () => JSON.stringify(mock) };
    }
    return origFetch(url, init);
  };
}

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/ocr') {
    const mod = await import('./api/ocr.js');
    // Adapter: Vercel-Style res.status().send() auf raw http.ServerResponse
    const adapted = Object.assign(res, {
      status(code) { res.statusCode = code; return adapted; },
      send(body)   { res.end(body); return adapted; }
    });
    return mod.default(req, adapted);
  }
  // Static
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const full = path.join(PUBLIC, p);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.listen(PORT, () => console.log(`Wagenident dev server on http://localhost:${PORT}${USE_MOCK?' (Vision MOCK aktiv)':''}`));
