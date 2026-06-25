// Lokaler Entwicklungs-Server: serviert /public statisch und routet /api/ocr an die Function.
// Azure und Google werden gemockt, wenn keine Keys gesetzt sind.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const USE_MOCK = !process.env.AZURE_VISION_KEY;

// Mock Azure + Google für lokales Testen
if (USE_MOCK) {
  process.env.AZURE_VISION_KEY = 'mock-key';
  process.env.AZURE_VISION_ENDPOINT = 'https://mock.cognitiveservices.azure.com';
  // Wenn der Tester GOOGLE_VISION_API_KEY nicht setzt, verwenden wir einen Mock-Key,
  // damit die Fallback-Kette getestet werden kann.
  if (!process.env.GOOGLE_VISION_API_KEY) process.env.GOOGLE_VISION_API_KEY = 'mock-google-key';

  // Steuerung über Bildgröße (Body-Länge) für Tests:
  //  - >  200 Byte: Azure liefert valide UIC
  //  - <= 200 Byte: Azure leer → Google liefert UIC (Fallback-Test)
  //  - body enthält ASCII-Marker "NOAZURE"  -> Azure leer
  //  - body enthält ASCII-Marker "NOGOOGLE" -> Google leer
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('imageanalysis:analyze')) {
      const body = init && init.body;
      const bodyLen = body ? (body.length || body.byteLength || 0) : 0;
      const bodyStr = body && body.toString ? body.toString('latin1') : '';
      const azureBlocked = bodyStr.includes('NOAZURE') || bodyLen <= 200;
      const text = azureBlocked ? '' : '31 81 6650 286-0';
      const lines = text ? [{
        text,
        words: text.split(/\s+/).map((w, i) => ({
          text: w,
          confidence: 0.95,
          boundingPolygon: [
            { x: i*40, y: 50 }, { x: i*40+30, y: 50 },
            { x: i*40+30, y: 70 }, { x: i*40, y: 70 }
          ]
        }))
      }] : [];
      const mock = {
        modelVersion: '2024-02-01',
        readResult: {
          stringIndexType: 'TextElements',
          content: text,
          pages: [{ height: 600, width: 800, angle: 0, pageNumber: 1 }],
          styles: [],
          blocks: text ? [{ lines }] : []
        }
      };
      return { ok: true, status: 200, json: async () => mock, text: async () => JSON.stringify(mock) };
    }
    if (typeof url === 'string' && url.includes('vision.googleapis.com')) {
      const body = init && init.body;
      const bodyStr = typeof body === 'string' ? body : '';
      const googleBlocked = bodyStr.includes('NOGOOGLE');
      const text = googleBlocked ? '' : '31 81 6650 286-0';
      const mock = {
        responses: [text ? {
          fullTextAnnotation: { text },
          textAnnotations: [
            { description: text, boundingPoly: { vertices: [{x:0,y:50},{x:300,y:50},{x:300,y:80},{x:0,y:80}] } },
            ...text.split(/\s+/).map((w,i) => ({
              description: w,
              boundingPoly: { vertices: [{x:i*40,y:55},{x:i*40+30,y:55},{x:i*40+30,y:75},{x:i*40,y:75}] }
            }))
          ]
        } : {}]
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
server.listen(PORT, () => console.log(`Wagenident dev server on http://localhost:${PORT}${USE_MOCK?' (Azure MOCK aktiv)':''}`));
