// test/ocr.test.mjs — Unit-Tests für die Serverless Function
// Azure als Haupt-OCR, Google als Fallback. Beide Anbieter werden über fetch gemockt.

let mockAzureResponse = null;
let mockAzureStatus = 200;
let mockGoogleResponse = null;
let mockGoogleStatus = 200;
let lastFetchUrls = [];

global.fetch = async (url, init) => {
  lastFetchUrls.push(url);
  if (typeof url === 'string' && url.includes('imageanalysis:analyze')) {
    return {
      ok: mockAzureStatus >= 200 && mockAzureStatus < 300,
      status: mockAzureStatus,
      json: async () => mockAzureResponse,
      text: async () => JSON.stringify(mockAzureResponse)
    };
  }
  if (typeof url === 'string' && url.includes('vision.googleapis.com')) {
    return {
      ok: mockGoogleStatus >= 200 && mockGoogleStatus < 300,
      status: mockGoogleStatus,
      json: async () => mockGoogleResponse,
      text: async () => JSON.stringify(mockGoogleResponse)
    };
  }
  throw new Error('Unexpected URL: ' + url);
};

process.env.AZURE_VISION_KEY = 'test-azure';
process.env.AZURE_VISION_ENDPOINT = 'https://test.cognitiveservices.azure.com';
process.env.GOOGLE_VISION_API_KEY = 'test-google';

const handler = (await import('../api/ocr.js')).default;

function mockReqRes(method, headers, body) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  let consumed = false;
  const req = {
    method, headers,
    [Symbol.asyncIterator]: async function*() { if (consumed) return; consumed = true; yield bodyBuf; }
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

// Azure-Mock-Antwort
function makeAzureMock(text, conf = 0.95) {
  const lines = text.split('\n').map((lineText, lineIdx) => {
    const words = lineText.split(/\s+/).filter(Boolean).map((w, i) => ({
      text: w,
      confidence: conf,
      boundingPolygon: [
        { x: i*40, y: lineIdx*30 }, { x: i*40+30, y: lineIdx*30 },
        { x: i*40+30, y: lineIdx*30+20 }, { x: i*40, y: lineIdx*30+20 }
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

// Google-Mock-Antwort
function makeGoogleMock(text) {
  const annotations = [{ description: text, boundingPoly: { vertices: [{x:0,y:0},{x:100,y:0},{x:100,y:30},{x:0,y:30}] } }];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    annotations.push({ description: w, boundingPoly: { vertices: [{x:0,y:50},{x:50,y:50},{x:50,y:80},{x:0,y:80}] } });
  }
  return {
    responses: [{
      textAnnotations: annotations,
      fullTextAnnotation: { text }
    }]
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  // State zurücksetzen vor jedem Test
  mockAzureResponse = null; mockAzureStatus = 200;
  mockGoogleResponse = null; mockGoogleStatus = 200;
  lastFetchUrls = [];
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg||''}\n  erwartet: ${JSON.stringify(b)}\n  bekommen: ${JSON.stringify(a)}`);
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || 'erwartet truthy'); }

console.log('\nFühre OCR-Function-Tests aus (Azure + Google-Fallback)...\n');

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
});

await test('Fehlender Content-Type -> 415', async () => {
  const { req, res, getResult } = mockReqRes('POST', {}, 'x');
  await handler(req, res);
  assertEq(getResult().statusCode, 415);
});

await test('Azure findet UIC -> source=azure, kein Google-Aufruf', async () => {
  mockAzureResponse = makeAzureMock('DB Cargo\n31 81 6650 286-0\nMax 22,5 t');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertEq(getResult().statusCode, 200);
  assertTrue(data.ok);
  assertEq(data.source, 'azure');
  assertEq(data.candidates[0].digits, '318166502860');
  assertEq(data.attempts.length, 1, 'kein Google-Fallback erwartet');
  const googleCalls = lastFetchUrls.filter(u => u.includes('googleapis')).length;
  assertEq(googleCalls, 0);
});

await test('Azure leer -> Google-Fallback findet UIC -> source=google', async () => {
  mockAzureResponse = makeAzureMock('nur Rauschen hier');
  mockGoogleResponse = makeGoogleMock('33 80 4713 069-9');
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertEq(getResult().statusCode, 200);
  assertTrue(data.ok, 'ok=true erwartet');
  assertEq(data.source, 'google');
  assertEq(data.candidates[0].digits, '338047130699');
  assertEq(data.attempts.length, 2);
  assertEq(data.attempts[0].source, 'azure');
  assertEq(data.attempts[1].source, 'google');
});

await test('Azure HTTP-Fehler -> Google springt ein', async () => {
  mockAzureResponse = { error: { code: 'InvalidImage' } };
  mockAzureStatus = 400;
  mockGoogleResponse = makeGoogleMock('21 81 2471 217-3');
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertEq(getResult().statusCode, 200);
  assertEq(data.source, 'google');
  assertEq(data.candidates[0].digits, '218124712173');
  assertEq(data.attempts[0].ok, false);
  assertEq(data.attempts[1].ok, true);
});

await test('Beide leer -> ok mit leerer candidates-Liste', async () => {
  mockAzureResponse = makeAzureMock('nur text');
  mockGoogleResponse = makeGoogleMock('nichts hier');
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertEq(getResult().statusCode, 200);
  assertTrue(data.ok);
  assertEq(data.candidates, []);
  assertEq(data.attempts.length, 2);
});

await test('Azure HTTP-Fehler + Google fehlt -> 502 mit attempts', async () => {
  mockAzureResponse = { error: { code: 'Unauthorized' } };
  mockAzureStatus = 401;
  const orig = process.env.GOOGLE_VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  process.env.GOOGLE_VISION_API_KEY = orig;
  assertEq(getResult().statusCode, 502);
  const data = JSON.parse(getResult().body);
  assertEq(data.error_code, 'AZURE_HTTP_ERROR');
  assertTrue(Array.isArray(data.attempts));
});

await test('Leerer Body -> 400 EMPTY_IMAGE', async () => {
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, '');
  await handler(req, res);
  assertEq(getResult().statusCode, 400);
  assertTrue(getResult().body.includes('EMPTY_IMAGE'));
});

await test('Fehlender AZURE_VISION_KEY -> 500 NO_AZURE_KEY', async () => {
  const orig = process.env.AZURE_VISION_KEY;
  delete process.env.AZURE_VISION_KEY;
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, Buffer.from('iVBORw0KGgo=', 'base64'));
  await handler(req, res);
  process.env.AZURE_VISION_KEY = orig;
  assertEq(getResult().statusCode, 500);
  assertTrue(getResult().body.includes('NO_AZURE_KEY'));
});

await test('UIC mit OCR-Buchstaben (O statt 0) wird erkannt', async () => {
  mockAzureResponse = makeAzureMock('31 8I 665O 286-O');
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const { req, res, getResult } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const data = JSON.parse(getResult().body);
  assertTrue(data.ok);
  assertTrue(data.candidates.some(c => c.digits === '318166502860'));
});

await test('Azure-URL benutzt model-version=latest, KEIN language', async () => {
  mockAzureResponse = makeAzureMock('test');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const { req, res } = mockReqRes('POST', { 'content-type': 'image/png' }, png);
  await handler(req, res);
  const azureCall = lastFetchUrls.find(u => u.includes('imageanalysis:analyze'));
  assertTrue(azureCall, 'kein Azure-Call');
  assertTrue(azureCall.includes('model-version=latest'), `model-version fehlt: ${azureCall}`);
  assertTrue(!azureCall.includes('language='), `language sollte fehlen: ${azureCall}`);
});

console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
