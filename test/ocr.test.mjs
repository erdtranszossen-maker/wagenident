// test/ocr.test.mjs — Unit-Tests für die Serverless Function (Azure-Variante)
// Mockt globales fetch und simuliert Azure-Read-Antworten.

// --- Azure-Vision-Mock ---------------------------------------------------
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

// Azure-ENV setzen, damit Function nicht direkt abbricht
process.env.AZURE_VISION_KEY = 'test-key';
process.env.AZURE_VISION_ENDPOINT = 'https://test.cognitiveservices.azure.com';

const handler = (await import('../api/ocr.js')).default;

// --- Mini-Helfer: HTTP-Request gegen Handler simulieren ---
function mockReqRes(method, headers, body) {
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

// Erzeugt eine Azure-Read-API-Antwort aus einem Text
// Eine Zeile pro \n im Text; Wörter werden whitespace-getrennt zerlegt.
function makeAzureMock(text, wordConfidence = 0.95) {
  const lines = text.split('\n').map((lineText, lineIdx) => {
    const words = lineText.split(/\s+/).filter(Boolean).map((w, i) => ({
      text: w,
      confidence: wordConfidence,
      boundingPolygon: [
        { x: i*40, y: lineIdx*30 },
        { x: i*40+30, y: lineIdx*30 },
        { x: i*40+30, y: lineIdx*30+20 },
        { x: i*40, y: lineIdx*30+20 }
      ]
    }));
    return { text: lineText, words };
  });
  return {
    modelVersion: '2024-02-01',
    readResult: {
      stringIndexType: 'TextElements',
      content: text,
      pages: [{ height: 600, width: 800, angle: 0, pageNumber: 1 }],
      styles: [],
      blocks: [{ lines }]
    }
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

console.log('\nFühre OCR-Function-Tests aus (Azure)...\n');

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
  mockVisionResponse = makeAzureMock('DB Cargo\n31 81 6650 286-0\nMax 22,5 t', 0.96);
  mockVisionStatus = 200;
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
  mockVisionResponse = makeAzureMock('Wagen 31 8I 665O 286-O abc', 0.93);
  mockVisionStatus = 200;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertTrue(data.ok);
  assertTrue(data.candidates.some(c => c.digits === '318166502860'),
            `Erwartete Kandidat 318166502860, bekam: ${JSON.stringify(data.candidates)}`);
});

await test('Azure-HTTP-Fehler -> 502 VISION_HTTP_ERROR', async () => {
  mockVisionResponse = { error: { code: 'InvalidImage', message: 'unreadable' } };
  mockVisionStatus = 400;
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

await test('Azure-Antwort ohne Treffer -> ok + keine Kandidaten', async () => {
  mockVisionResponse = makeAzureMock('kein Wagen hier', 0.9);
  mockVisionStatus = 200;
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertTrue(data.ok);
  assertEq(data.candidates, []);
});

await test('Fehlende AZURE-ENV-Variable -> 500 NO_AZURE_KEY', async () => {
  const orig = process.env.AZURE_VISION_KEY;
  delete process.env.AZURE_VISION_KEY;
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, Buffer.from('iVBORw0KGgo=', 'base64'));
  await handler(req, res);
  process.env.AZURE_VISION_KEY = orig;
  assertEq(getResult().statusCode, 500);
  assertTrue(getResult().body.includes('NO_AZURE_KEY'));
});

await test('Azure-URL wird korrekt zusammengesetzt', async () => {
  mockVisionResponse = makeAzureMock('test', 0.9);
  mockVisionStatus = 200;
  lastFetchUrl = null;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  assertTrue(lastFetchUrl && lastFetchUrl.includes('imageanalysis:analyze'), `URL falsch: ${lastFetchUrl}`);
  assertTrue(lastFetchUrl.includes('features=read'), `features fehlt: ${lastFetchUrl}`);
});

console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
