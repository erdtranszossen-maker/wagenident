// api/ocr.js — Vercel Serverless Function
// Nimmt ein Bild entgegen, ruft Azure AI Vision auf.
// Wenn Azure keine gültige UIC-Kandidaten liefert, wird Google Vision als
// Fallback parallel/sekundär angefragt. Liefert deterministisches JSON mit
// Trefferquelle ("azure" oder "google") und Roh-Text zur Diagnose zurück.
// ENV: AZURE_VISION_KEY, AZURE_VISION_ENDPOINT, GOOGLE_VISION_API_KEY
// ----------------------------------------------------------------------------

import { findUicCandidates } from './_uic.js';

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '6mb'
  },
  maxDuration: 25
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB Sicherheitsgrenze
const REQUEST_TIMEOUT_MS = 18000;

// --- CORS ---------------------------------------------------------------
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

// --- Body-Lesen --------------------------------------------------------
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES + 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// --- Multipart-Parser (für "image"-Feld) -------------------------------
function parseMultipart(buf, contentType) {
  const m = contentType && contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const boundaryBuf = Buffer.from(boundary);
  let start = buf.indexOf(boundaryBuf);
  if (start < 0) return null;
  start += boundaryBuf.length;
  while (start < buf.length) {
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x2d && buf[start + 1] === 0x2d) return null;
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0) return null;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const nameMatch = headers.match(/name="([^"]+)"/i);
    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const bodyStart = headerEnd + 4;
    const nextBoundary = buf.indexOf(boundaryBuf, bodyStart);
    if (nextBoundary < 0) return null;
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

// --- Azure-Antwort normalisieren ----------------------------------------
function normalizeAzureResponse(azureData) {
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

// --- Google-Vision-Antwort normalisieren -------------------------------
function normalizeGoogleResponse(googleData) {
  const r0 = googleData.responses?.[0];
  const fullText = r0?.fullTextAnnotation?.text || '';
  const lines = [];
  // Wir extrahieren Zeilen aus textAnnotations (Google liefert je nach Modus
  // unterschiedliche Strukturen). Fallback: ganzer Text als eine Zeile.
  const tas = r0?.textAnnotations || [];
  if (tas.length > 0) {
    // tas[0] = ganzer Text, tas[1..] = einzelne Wörter
    for (let i = 1; i < tas.length; i++) {
      const t = tas[i];
      const verts = t.boundingPoly?.vertices || [];
      const yMid = verts.length ? verts.reduce((a,v) => a + (v.y || 0), 0) / verts.length : 0;
      lines.push({
        text: t.description || '',
        words: [{ text: t.description || '', confidence: 0.9, yMid }]
      });
    }
  }
  if (lines.length === 0 && fullText) {
    lines.push({
      text: fullText,
      words: [{ text: fullText, confidence: 0.85, yMid: 0 }]
    });
  }
  return { fullText, lines };
}

// --- Kandidaten aus normalisiertem Format mit Confidence-Schätzung ------
function buildCandidates(normalized) {
  const fullText = normalized.fullText || '';
  const allCandidates = findUicCandidates(fullText);
  const out = [];
  const seen = new Set();
  for (const digits of allCandidates) {
    if (seen.has(digits)) continue;
    seen.add(digits);
    let bestConf = 0;
    let bestLineText = '';
    let bestYMid = 0;
    for (const line of normalized.lines) {
      const lineText = (line.words || []).map(w => w.text).join(' ').replace(/\s+/g, ' ');
      const lineDigits = lineText.replace(/\D/g, '');
      if (lineDigits.includes(digits) || hasFuzzyMatch(lineText, digits)) {
        const ws = line.words || [];
        const avg = ws.reduce((a, w) => a + (w.confidence || 0), 0) / Math.max(1, ws.length);
        if (avg > bestConf) {
          bestConf = avg;
          bestLineText = lineText;
          bestYMid = ws.reduce((a, w) => a + (w.yMid || 0), 0) / Math.max(1, ws.length);
        }
      }
    }
    if (bestConf === 0) { bestConf = 0.85; }
    out.push({
      digits,
      raw: bestLineText || formatRawDigits(digits),
      vision_confidence: Number(bestConf.toFixed(4)),
      y_mid: bestYMid
    });
  }
  out.sort((a, b) => b.vision_confidence - a.vision_confidence);
  return out;
}

function hasFuzzyMatch(lineText, digits) {
  const subs = { 'O':'0','o':'0','D':'0','Q':'0','I':'1','l':'1','|':'1','Z':'2','z':'2',
                 'E':'3','A':'4','S':'5','s':'5','G':'6','b':'6','T':'7','B':'8','g':'9','q':'9' };
  const fixed = lineText.split('').map(c => subs[c] ?? c).join('').replace(/\D/g, '');
  return fixed.includes(digits);
}

function formatRawDigits(d) {
  if (d.length !== 12) return d;
  return `${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)} ${d.slice(8,11)}-${d.slice(11)}`;
}

// --- Azure-Aufruf -------------------------------------------------------
async function callAzure(imageBuf, azureEndpoint, azureKey) {
  // Wir lassen den language-Hinweis bewusst weg — für reine Ziffern liefert
  // Azure mit "auto" oft bessere Ergebnisse.
  const url = `${azureEndpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read&model-version=latest`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/octet-stream'
      },
      body: imageBuf,
      signal: controller.signal
    });
    clearTimeout(to);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error_code: 'AZURE_HTTP_ERROR', status: resp.status, message: text.slice(0, 500) };
    }
    const data = await resp.json().catch(() => null);
    if (!data || !data.readResult) return { ok: false, error_code: 'AZURE_EMPTY_RESPONSE' };
    const normalized = normalizeAzureResponse(data);
    const candidates = buildCandidates(normalized);
    return { ok: true, candidates, fullText: normalized.fullText };
  } catch (e) {
    clearTimeout(to);
    if (e.name === 'AbortError') return { ok: false, error_code: 'AZURE_TIMEOUT' };
    return { ok: false, error_code: 'AZURE_NETWORK_ERROR', message: String(e.message || e) };
  }
}

// --- Google-Vision-Aufruf (Fallback) -----------------------------------
async function callGoogle(imageBuf, googleKey) {
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(googleKey)}`;
  const body = {
    requests: [{
      image: { content: imageBuf.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
      imageContext: { languageHints: ['de', 'en'] }
    }]
  };
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(to);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error_code: 'GOOGLE_HTTP_ERROR', status: resp.status, message: text.slice(0, 500) };
    }
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, error_code: 'GOOGLE_EMPTY_RESPONSE' };
    const normalized = normalizeGoogleResponse(data);
    const candidates = buildCandidates(normalized);
    return { ok: true, candidates, fullText: normalized.fullText };
  } catch (e) {
    clearTimeout(to);
    if (e.name === 'AbortError') return { ok: false, error_code: 'GOOGLE_TIMEOUT' };
    return { ok: false, error_code: 'GOOGLE_NETWORK_ERROR', message: String(e.message || e) };
  }
}

// --- Validitätstest: lohnt sich ein Fallback? ---------------------------
// Wenn Azure mindestens einen 12-stelligen Kandidaten findet, ist das schon
// ein guter Treffer (UIC-Prüfziffer wird im Frontend nochmal geprüft).
function hasUsableHit(result) {
  return result.ok && Array.isArray(result.candidates) && result.candidates.length > 0;
}

// --- Handler ------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); res.status(204).end(); return; }
  if (req.method !== 'POST')    { return json(res, 405, { ok:false, error_code:'METHOD_NOT_ALLOWED' }); }

  const azureKey = process.env.AZURE_VISION_KEY;
  const azureEndpointRaw = process.env.AZURE_VISION_ENDPOINT;
  const googleKey = process.env.GOOGLE_VISION_API_KEY;
  if (!azureKey) return json(res, 500, { ok:false, error_code:'NO_AZURE_KEY' });
  if (!azureEndpointRaw) return json(res, 500, { ok:false, error_code:'NO_AZURE_ENDPOINT' });
  const azureEndpoint = azureEndpointRaw.replace(/\/+$/, '');

  let bodyBuf;
  try { bodyBuf = await readBody(req); }
  catch (e) {
    if (e.message === 'PAYLOAD_TOO_LARGE') return json(res, 413, { ok:false, error_code:'PAYLOAD_TOO_LARGE' });
    return json(res, 400, { ok:false, error_code:'BODY_READ_FAILED' });
  }

  let imageBuf, imageMime;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    const part = parseMultipart(bodyBuf, ct);
    if (!part) return json(res, 400, { ok:false, error_code:'NO_IMAGE_FIELD' });
    imageBuf = part.data; imageMime = part.contentType;
  } else if (ct.startsWith('image/')) {
    imageBuf = bodyBuf; imageMime = ct;
  } else if (ct.startsWith('application/json')) {
    try {
      const parsed = JSON.parse(bodyBuf.toString('utf8'));
      if (!parsed.image_base64) return json(res, 400, { ok:false, error_code:'NO_IMAGE_FIELD' });
      imageBuf = Buffer.from(parsed.image_base64, 'base64');
      imageMime = parsed.mime || 'image/jpeg';
    } catch { return json(res, 400, { ok:false, error_code:'BAD_JSON' }); }
  } else {
    return json(res, 415, { ok:false, error_code:'UNSUPPORTED_CONTENT_TYPE' });
  }
  if (!imageBuf || imageBuf.length === 0) return json(res, 400, { ok:false, error_code:'EMPTY_IMAGE' });
  if (imageBuf.length > MAX_IMAGE_BYTES) return json(res, 413, { ok:false, error_code:'IMAGE_TOO_LARGE' });

  // --- Schritt 1: Azure aufrufen ---
  const azureResult = await callAzure(imageBuf, azureEndpoint, azureKey);
  const attempts = [{
    source: 'azure',
    ok: azureResult.ok,
    candidates: azureResult.candidates || [],
    fullText: azureResult.fullText || '',
    error: azureResult.ok ? null : { code: azureResult.error_code, status: azureResult.status, message: azureResult.message }
  }];

  // --- Schritt 2: Falls Azure leer/Fehler → Google-Fallback ---
  let finalSource = 'azure';
  let finalCandidates = azureResult.candidates || [];
  let finalFullText = azureResult.fullText || '';

  if (!hasUsableHit(azureResult) && googleKey) {
    const googleResult = await callGoogle(imageBuf, googleKey);
    attempts.push({
      source: 'google',
      ok: googleResult.ok,
      candidates: googleResult.candidates || [],
      fullText: googleResult.fullText || '',
      error: googleResult.ok ? null : { code: googleResult.error_code, status: googleResult.status, message: googleResult.message }
    });
    if (hasUsableHit(googleResult)) {
      finalSource = 'google';
      finalCandidates = googleResult.candidates;
      finalFullText = googleResult.fullText;
    }
  }

  // Wenn Azure-Aufruf komplett gescheitert ist und auch Google nicht hilft:
  // dennoch 200 zurückgeben mit leeren Kandidaten + Fehler-Hinweis, damit
  // das Frontend einen "Blockiert"-Zustand mit Roh-Text anzeigen kann.
  // Aber: harte Konfig-Fehler (kein Key) wurden oben schon abgefangen.
  if (!azureResult.ok && finalCandidates.length === 0) {
    // Azure-Fehler war wahrscheinlich technisch (4xx/5xx) — wir liefern den ersten Fehler durch.
    if (azureResult.error_code && azureResult.error_code !== 'AZURE_EMPTY_RESPONSE') {
      return json(res, 502, {
        ok: false,
        error_code: azureResult.error_code,
        status: azureResult.status,
        message: azureResult.message,
        attempts
      });
    }
  }

  return json(res, 200, {
    ok: true,
    source: finalSource,                       // "azure" oder "google"
    candidates: finalCandidates,               // beste Liste
    full_text_excerpt: finalFullText.slice(0, 1500),
    attempts,                                  // Diagnose: alle versuche
    image_bytes: imageBuf.length,
    image_mime: imageMime
  });
}
