// test/ocr.test.mjs — Unit-Tests für die Serverless Function
// Mockt globales fetch und simuliert Vision-Antworten.
import http from 'node:http';

// --- Vision-Mock ----------------------------------------------------------
let mockVisionResponse = null;
let mockVisionStatus = 200;
let lastFetchUrl = null;

global.fetch = async (url, init) => {
  lastFetchUrl = url;
  return {
    ok: mockVisionStatus >= 200 && mockVisionStatus < 300,
    status: mockVisionStatus,
    json: async () => mockVisionResponse,
    text: async () => JSON.stringify(mockVisionResponse)
  };
};

// API-Key setzen, damit Function nicht direkt abbricht
process.env.GOOGLE_VISION_API_KEY = 'test-key';

const handler = (await import('../api/ocr.js')).default;

// --- Mini-Helfer: HTTP-Request gegen Handler simulieren ---
function mockReqRes(method, headers, body) {
  // Request als async iterable
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  let consumed = false;
  const req = {
    method,
    headers,
    [Symbol.asyncIterator]: async function*() {
      if (consumed) return;
      consumed = true;
      yield bodyBuf;
    }
  };
  let statusCode = 0;
  let resHeaders = {};
  let resBody = '';
  const res = {
    setHeader: (k, v) => { resHeaders[k] = v; },
    status: (s) => { statusCode = s; return res; },
    send: (b) => { resBody = b; return res; },
    end: () => {}
  };
  return { req, res, getResult: () => ({ statusCode, headers: resHeaders, body: resBody }) };
}

function makeVisionMock(text, wordConfidence = 0.95) {
  // Minimaler Vision-Response, der für unsere Logik reicht
  return {
    responses: [{
      fullTextAnnotation: {
        text,
        pages: [{
          confidence: wordConfidence,
          blocks: [{
            paragraphs: [{
              words: text.split(/\s+/).filter(Boolean).map((w, i) => ({
                confidence: wordConfidence,
                symbols: w.split('').map(c => ({ text: c })),
                boundingBox: { vertices: [{x:i*40,y:50},{x:i*40+30,y:50},{x:i*40+30,y:70},{x:i*40,y:70}] }
              }))
            }]
          }]
        }]
      }
    }]
  };
}

// --- Tests ---------------------------------------------------------------
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg||''}\n  erwartet: ${JSON.stringify(b)}\n  bekommen: ${JSON.stringify(a)}`);
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || 'erwartet truthy'); }

console.log('\nFühre OCR-Function-Tests aus...\n');

await test('OPTIONS -> 204 + CORS', async () => {
  const { req, res, getResult } = mockReqRes('OPTIONS', {}, '');
  await handler(req, res);
  assertEq(getResult().statusCode, 204);
  assertEq(getResult().headers['Access-Control-Allow-Origin'], '*');
});

await test('GET -> 405', async () => {
  const { req, res, getResult } = mockReqRes('GET', {}, '');
  await handler(req, res);
  assertEq(getResult().statusCode, 405);
  assertTrue(getResult().body.includes('METHOD_NOT_ALLOWED'));
});

await test('Fehlender Content-Type -> 415', async () => {
  const { req, res, getResult } = mockReqRes('POST', {}, 'x');
  await handler(req, res);
  assertEq(getResult().statusCode, 415);
});

await test('JSON-Body ohne image_base64 -> 400', async () => {
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'application/json' }, '{}');
  await handler(req, res);
  assertEq(getResult().statusCode, 400);
});

await test('Echte UIC-Nummer erkannt -> ok + candidates', async () => {
  mockVisionResponse = makeVisionMock('DB Cargo\n31 81 6650 286-0\nMax 22,5 t', 0.96);
  mockVisionStatus = 200;
  // 1x1 PNG (gültiges Bild)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const r = getResult();
  assertEq(r.statusCode, 200);
  const data = JSON.parse(r.body);
  assertTrue(data.ok);
  assertTrue(data.candidates.length >= 1);
  assertEq(data.candidates[0].digits, '318166502860');
  assertTrue(data.candidates[0].vision_confidence > 0.9);
});

await test('UIC-Nummer mit OCR-Buchstaben (O statt 0)', async () => {
  mockVisionResponse = makeVisionMock('Wagen 31 8I 665O 286-O abc', 0.93);
  mockVisionStatus = 200;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertTrue(data.ok);
  assertTrue(data.candidates.some(c => c.digits === '318166502860'),
            `Erwartete Kandidat 318166502860, bekam: ${JSON.stringify(data.candidates)}`);
});

await test('Vision-HTTP-Fehler -> 502 VISION_HTTP_ERROR', async () => {
  mockVisionResponse = { error: { message: 'PERMISSION_DENIED' } };
  mockVisionStatus = 403;
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  assertEq(getResult().statusCode, 502);
  assertTrue(getResult().body.includes('VISION_HTTP_ERROR'));
});

await test('Leerer Body -> 400 EMPTY_IMAGE', async () => {
  mockVisionStatus = 200;
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, '');
  await handler(req, res);
  assertEq(getResult().statusCode, 400);
  assertTrue(getResult().body.includes('EMPTY_IMAGE'));
});

await test('Vision-Antwort ohne fullText -> blocked-tauglich (keine Kandidaten)', async () => {
  mockVisionResponse = { responses: [{ fullTextAnnotation: { text: 'kein Wagen hier', pages:[{blocks:[]}] } }] };
  mockVisionStatus = 200;
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertTrue(data.ok);
  assertEq(data.candidates, []);
});

console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
