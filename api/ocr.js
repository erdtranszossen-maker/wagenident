// api/ocr.js — Vercel Serverless Function
// Nimmt ein Bild entgegen, ruft Azure AI Vision (Read / Image Analysis 4.0) auf,
// extrahiert UIC-Kandidaten und liefert deterministisches JSON zurück.
// ENV: AZURE_VISION_KEY, AZURE_VISION_ENDPOINT
// ----------------------------------------------------------------------------

import { findUicCandidates } from './_uic.js';

export const config = {
  api: {
    bodyParser: false,           // wir lesen den Stream selbst
    sizeLimit: '6mb'
  },
  maxDuration: 20
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB Sicherheitsgrenze
const REQUEST_TIMEOUT_MS = 15000;

// --- CORS (Vercel deploys frontend + function gemeinsam; CORS für lokales Testen) ---
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(payload));
}

// Liest den gesamten Request-Body als Buffer
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES + 64 * 1024) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Minimaler Multipart-Parser, sucht das Feld "image"
function parseMultipart(buf, contentType) {
  const m = contentType && contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const boundaryBuf = Buffer.from(boundary);
  let start = buf.indexOf(boundaryBuf);
  if (start < 0) return null;
  start += boundaryBuf.length;
  while (start < buf.length) {
    // CRLF nach Boundary
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x2d && buf[start + 1] === 0x2d) return null; // "--" = Ende
    // Header-Ende: \r\n\r\n
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0) return null;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const nameMatch = headers.match(/name="([^"]+)"/i);
    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const bodyStart = headerEnd + 4;
    const nextBoundary = buf.indexOf(boundaryBuf, bodyStart);
    if (nextBoundary < 0) return null;
    // Trailing \r\n vor Boundary abziehen
    const bodyEnd = (buf[nextBoundary - 2] === 0x0d && buf[nextBoundary - 1] === 0x0a)
                    ? nextBoundary - 2 : nextBoundary;
    const fieldName = nameMatch ? nameMatch[1] : '';
    if (fieldName === 'image' && filenameMatch) {
      return {
        filename: filenameMatch[1] || 'image',
        contentType: (contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream'),
        data: buf.slice(bodyStart, bodyEnd)
      };
    }
    start = nextBoundary + boundaryBuf.length;
  }
  return null;
}

// --- Azure-Antwort in vereinheitlichtes Format (mit Zeilen + Wort-Konfidenzen) ---
function normalizeAzureResponse(azureData) {
  // Azure Image Analysis 4.0 Read-Output:
  // { readResult: { blocks: [{ lines: [{ text, words: [{ text, confidence, boundingPolygon }] }] }] } }
  const lines = [];
  let fullText = '';
  const blocks = azureData.readResult?.blocks || [];
  for (const block of blocks) {
    for (const line of (block.lines || [])) {
      const lineText = line.text || '';
      if (fullText) fullText += '\n';
      fullText += lineText;
      const words = (line.words || []).map(w => {
        const vs = w.boundingPolygon || [];
        const yMid = vs.length ? (vs.reduce((a,v) => a + (v.y || 0), 0) / vs.length) : 0;
        return { text: w.text || '', confidence: w.confidence ?? 0.9, yMid };
      });
      lines.push({ text: lineText, words });
    }
  }
  return { fullText, lines };
}

// Sammelt pro Zeile Wörter aus der normalisierten Antwort
function collectWordsByLine(normalized) {
  const wordsByLine = new Map();
  for (let i = 0; i < normalized.lines.length; i++) {
    wordsByLine.set(i, normalized.lines[i].words);
  }
  return wordsByLine;
}

/**
 * Verbindet die UIC-Erkennung mit Word-Confidences.
 * Versucht für jeden gefundenen Kandidaten eine Confidence zu schätzen
 * (Durchschnitt der Wort-Confidences in der zugehörigen Zeile, in der die Stellen vorkamen).
 */
function buildCandidates(normalized) {
  const fullText = normalized.fullText || '';
  const allCandidates = findUicCandidates(fullText);
  const wordsByLine = collectWordsByLine(normalized);

  const out = [];
  const seen = new Set();
  for (const digits of allCandidates) {
    if (seen.has(digits)) continue;
    seen.add(digits);
    let bestConf = 0;
    let bestLineText = '';
    for (const [, words] of wordsByLine) {
      const lineText = words.map(w => w.text).join(' ').replace(/\s+/g, ' ');
      const lineDigits = lineText.replace(/\D/g, '');
      if (lineDigits.includes(digits) || hasFuzzyMatch(lineText, digits)) {
        const avg = words.reduce((a, w) => a + (w.confidence || 0), 0) / Math.max(1, words.length);
        if (avg > bestConf) {
          bestConf = avg;
          bestLineText = lineText;
        }
      }
    }
    if (bestConf === 0) {
      // Fallback: konservative Default-Confidence (Azure liefert keine globale)
      bestConf = 0.85;
      bestLineText = '';
    }
    out.push({
      digits,
      raw: bestLineText || formatRawDigits(digits),
      vision_confidence: Number(bestConf.toFixed(4))
    });
  }
  out.sort((a, b) => b.vision_confidence - a.vision_confidence);
  return out;
}

function hasFuzzyMatch(lineText, digits) {
  // Wenn die Zeile OCR-Buchstaben statt Ziffern enthielt, ist .replace(/\D/) zu strikt.
  // Wir normalisieren die Zeile mit denselben Substitutionen und prüfen erneut.
  const subs = { 'O':'0','o':'0','D':'0','Q':'0','I':'1','l':'1','|':'1','Z':'2','z':'2',
                 'E':'3','A':'4','S':'5','s':'5','G':'6','b':'6','T':'7','B':'8','g':'9','q':'9' };
  const fixed = lineText.split('').map(c => subs[c] ?? c).join('').replace(/\D/g, '');
  return fixed.includes(digits);
}

function formatRawDigits(d) {
  if (d.length !== 12) return d;
  return `${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)} ${d.slice(8,11)}-${d.slice(11)}`;
}

// --- Handler -------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); res.status(204).end(); return; }
  if (req.method !== 'POST')    { return json(res, 405, { ok:false, error_code:'METHOD_NOT_ALLOWED' }); }

  const azureKey = process.env.AZURE_VISION_KEY;
  const azureEndpointRaw = process.env.AZURE_VISION_ENDPOINT;
  if (!azureKey) return json(res, 500, { ok:false, error_code:'NO_AZURE_KEY', message:'AZURE_VISION_KEY ist nicht gesetzt' });
  if (!azureEndpointRaw) return json(res, 500, { ok:false, error_code:'NO_AZURE_ENDPOINT', message:'AZURE_VISION_ENDPOINT ist nicht gesetzt' });
  const azureEndpoint = azureEndpointRaw.replace(/\/+$/, '');

  // Body lesen
  let bodyBuf;
  try { bodyBuf = await readBody(req); }
  catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return json(res, 413, { ok:false, error_code:'PAYLOAD_TOO_LARGE' });
    return json(res, 400, { ok:false, error_code:'BODY_READ_FAILED' });
  }

  // Bild extrahieren — entweder multipart oder direkt Binary
  let imageBuf, imageMime;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    const part = parseMultipart(bodyBuf, ct);
    if (!part) return json(res, 400, { ok:false, error_code:'NO_IMAGE_FIELD' });
    imageBuf = part.data;
    imageMime = part.contentType;
  } else if (ct.startsWith('image/')) {
    imageBuf = bodyBuf;
    imageMime = ct;
  } else if (ct.startsWith('application/json')) {
    try {
      const parsed = JSON.parse(bodyBuf.toString('utf8'));
      if (!parsed.image_base64) return json(res, 400, { ok:false, error_code:'NO_IMAGE_FIELD' });
      imageBuf = Buffer.from(parsed.image_base64, 'base64');
      imageMime = parsed.mime || 'image/jpeg';
    } catch {
      return json(res, 400, { ok:false, error_code:'BAD_JSON' });
    }
  } else {
    return json(res, 415, { ok:false, error_code:'UNSUPPORTED_CONTENT_TYPE' });
  }

  if (!imageBuf || imageBuf.length === 0) return json(res, 400, { ok:false, error_code:'EMPTY_IMAGE' });
  if (imageBuf.length > MAX_IMAGE_BYTES) return json(res, 413, { ok:false, error_code:'IMAGE_TOO_LARGE' });

  // --- Azure Read API aufrufen ---
  // language=de: Tipp für lateinische Schrift; features=read: OCR;
  // model-version=latest: bestmögliche Erkennung
  const AZURE_URL = `${azureEndpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read&language=de&model-version=latest`;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let visionResp;
  try {
    visionResp = await fetch(AZURE_URL, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/octet-stream'
      },
      body: imageBuf,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(to);
    if (e.name === 'AbortError') return json(res, 504, { ok:false, error_code:'VISION_TIMEOUT' });
    return json(res, 502, { ok:false, error_code:'VISION_NETWORK_ERROR', message:String(e.message || e) });
  }
  clearTimeout(to);

  if (!visionResp.ok) {
    const text = await visionResp.text().catch(() => '');
    return json(res, 502, { ok:false, error_code:'VISION_HTTP_ERROR', status:visionResp.status, message:text.slice(0, 500) });
  }

  let visionData;
  try { visionData = await visionResp.json(); }
  catch { return json(res, 502, { ok:false, error_code:'VISION_BAD_JSON' }); }

  if (!visionData.readResult) {
    return json(res, 502, { ok:false, error_code:'VISION_EMPTY_RESPONSE' });
  }

  const normalized = normalizeAzureResponse(visionData);
  const candidates = buildCandidates(normalized);
  const fullText = normalized.fullText || '';

  return json(res, 200, {
    ok: true,
    candidates,                                  // [{digits, raw, vision_confidence}]
    full_text_excerpt: fullText.slice(0, 500),   // Debug-Hilfe, keine PII
    image_bytes: imageBuf.length,
    image_mime: imageMime
  });
}
