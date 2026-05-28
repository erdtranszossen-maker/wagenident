// api/ocr.js — Vercel Serverless Function
// Nimmt ein Bild entgegen, ruft Google Cloud Vision (DOCUMENT_TEXT_DETECTION) auf,
// extrahiert UIC-Kandidaten und liefert deterministisches JSON zurück.
// ENV: GOOGLE_VISION_API_KEY
// ----------------------------------------------------------------------------

import { findUicCandidates } from './_uic.js';

export const config = {
  api: {
    bodyParser: false,           // wir lesen den Stream selbst
    sizeLimit: '6mb'
  },
  maxDuration: 20
};

const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
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

// Sammelt pro Wort eine Confidence aus der Vision-Antwort
function collectWordConfidences(response) {
  const wordsByLine = new Map();
  const pages = response.fullTextAnnotation?.pages || [];
  for (const page of pages) {
    for (const block of (page.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        // Wir gruppieren Wörter zeilenweise per y-Mittelpunkt
        const wordsWithY = [];
        for (const word of (para.words || [])) {
          const sym = (word.symbols || []).map(s => s.text || '').join('');
          const confidence = word.confidence ?? para.confidence ?? block.confidence ?? 0;
          const vs = word.boundingBox?.vertices || [];
          const yMid = vs.length ? (vs.reduce((a,v) => a + (v.y || 0), 0) / vs.length) : 0;
          wordsWithY.push({ text: sym, confidence, yMid });
        }
        // einfache Zeilen-Bildung: nach yMid (gerundet auf 8px) gruppieren
        for (const w of wordsWithY) {
          const lineKey = Math.round(w.yMid / 8);
          if (!wordsByLine.has(lineKey)) wordsByLine.set(lineKey, []);
          wordsByLine.get(lineKey).push(w);
        }
      }
    }
  }
  return wordsByLine;
}

/**
 * Verbindet die UIC-Erkennung mit Word-Confidences.
 * Versucht für jeden gefundenen Kandidaten eine Confidence zu schätzen
 * (Durchschnitt der Wort-Confidences in der zugehörigen Zeile, in der die Stellen vorkamen).
 */
function buildCandidates(visionResponse) {
  const fullText = visionResponse.fullTextAnnotation?.text || '';
  const allCandidates = findUicCandidates(fullText);
  const wordsByLine = collectWordConfidences(visionResponse);

  // Map: digits -> beste Confidence
  const out = [];
  const seen = new Set();
  for (const digits of allCandidates) {
    if (seen.has(digits)) continue;
    seen.add(digits);
    // Suche Zeile(n), die die Ziffernfolge enthält
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
      // Fallback: globale Confidence
      bestConf = visionResponse.fullTextAnnotation?.pages?.[0]?.confidence || 0;
      bestLineText = '';
    }
    out.push({
      digits,
      raw: bestLineText || formatRawDigits(digits),
      vision_confidence: Number(bestConf.toFixed(4))
    });
  }
  // Sortiere nach Confidence absteigend
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

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return json(res, 500, { ok:false, error_code:'NO_API_KEY', message:'GOOGLE_VISION_API_KEY ist nicht gesetzt' });

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

  // Vision aufrufen
  const visionBody = {
    requests: [{
      image: { content: imageBuf.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['de', 'en'] }
    }]
  };

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let visionResp;
  try {
    visionResp = await fetch(`${VISION_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visionBody),
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

  const r0 = visionData.responses?.[0];
  if (!r0) return json(res, 502, { ok:false, error_code:'VISION_EMPTY_RESPONSE' });
  if (r0.error) return json(res, 502, { ok:false, error_code:'VISION_API_ERROR', message: r0.error.message || 'unknown' });

  const candidates = buildCandidates(r0);
  const fullText = r0.fullTextAnnotation?.text || '';

  return json(res, 200, {
    ok: true,
    candidates,                                  // [{digits, raw, vision_confidence}]
    full_text_excerpt: fullText.slice(0, 500),   // Debug-Hilfe, keine PII
    image_bytes: imageBuf.length,
    image_mime: imageMime
  });
}
