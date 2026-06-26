// app.js — Wagenident Frontend v4
// Neu: Auto-Crop Mittelstreifen, Azure→Google-Fallback-Auswertung,
//       Standard-Mailverteiler (localStorage), OCR-Details-Modal,
//       Bounding-Box-Tie-Breaker für Mittelzone.
import { decideStatus, decideManualEntry } from './lib/uic.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const galleryInput = $('galleryInput');
const cameraInput  = $('cameraInput');
const cameraAddInput = $('cameraAddInput');
const cameraDoneBtn  = $('cameraDoneBtn');
const cameraTray     = $('cameraTray');
const trayCount      = $('trayCount');
const trayThumbs     = $('trayThumbs');
const fileCount    = $('fileCount');
const processBtn   = $('processBtn');
const excelBtn     = $('excelBtn');
const mailBtn      = $('mailBtn');
const resetBtn     = $('resetBtn');
const resultsBody  = $('resultsBody');
const statusEl     = $('status');
const standortEl   = $('standort');
const emailInput   = $('emailInput');
const addEmailBtn  = $('addEmailBtn');
const emailChips   = $('emailChips');
const emailEmpty   = $('emailEmpty');
const summary      = $('summary');
const sumOk        = $('sumOk');
const sumCheck     = $('sumCheck');
const sumBlock     = $('sumBlock');
const overrideModal= $('overrideModal');
const overrideText = $('overrideText');
const overrideCancel = $('overrideCancel');
const overrideConfirm= $('overrideConfirm');
const lightbox     = $('lightbox');
const lightboxImg  = $('lightboxImg');
const lightboxClose= $('lightboxClose');
const lightboxEdit = $('lightboxEdit');
const lightboxNumInput = $('lightboxNumInput');
const lightboxStatus = $('lightboxStatus');
const lightboxConfirm = $('lightboxConfirm');
// ID der Zeile, deren Bild aktuell in der Lightbox angezeigt wird (für Inline-Edit)
let lightboxRowId = null;

// Standard-Verteiler
const loadStdBtn   = $('loadStdBtn');
const saveStdBtn   = $('saveStdBtn');
const clearStdBtn  = $('clearStdBtn');
const stdStatus    = $('stdStatus');

// OCR-Details-Modal
const detailsModal = $('detailsModal');
const detailsSource= $('detailsSource');
const detailsImg   = $('detailsImg');
const detailsRaw   = $('detailsRaw');
const detailsCands = $('detailsCands');
const detailsClose = $('detailsClose');

// ---------- Konstanten ----------
const STORAGE_BASE  = 'wagenident.v1';
const STORAGE_STD   = 'wagenident.std.emails';
const CROP_TOP      = 0.30;   // 30–70 % Mittelstreifen
const CROP_BOTTOM   = 0.70;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;  // 4 MB
const JPEG_Q_DEFAULT = 0.92;
const JPEG_Q_FALLBACK = [0.85, 0.78, 0.7, 0.6, 0.5];

// ---------- State ----------
const STATE = {
  rows: [],
  emails: [],
  selectedFiles: [],
  cameraFiles: [],
  overrideCallback: null,
  excelDownloaded: false,   // Gate für Schritt 3 (Mail vorbereiten)
};

// ---------- Persistence ----------
function loadPersist() {
  try {
    const raw = localStorage.getItem(STORAGE_BASE);
    if (raw) {
      const o = JSON.parse(raw);
      STATE.emails = Array.isArray(o.emails) ? o.emails : [];
      if (o.standort) standortEl.value = o.standort;
    }
  } catch {}
}
function savePersist() {
  try {
    localStorage.setItem(STORAGE_BASE, JSON.stringify({
      emails: STATE.emails, standort: standortEl.value
    }));
  } catch {}
}
function getStandardEmails() {
  try {
    const raw = localStorage.getItem(STORAGE_STD);
    if (!raw) return null;
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}
function setStandardEmails(list) {
  try { localStorage.setItem(STORAGE_STD, JSON.stringify(list)); } catch {}
}
function clearStandardEmails() {
  try { localStorage.removeItem(STORAGE_STD); } catch {}
}
function updateStdStatus() {
  const std = getStandardEmails();
  if (!std || std.length === 0) {
    stdStatus.textContent = 'Kein Standard-Verteiler hinterlegt.';
    loadStdBtn.disabled = true;
    clearStdBtn.disabled = true;
  } else {
    stdStatus.textContent = `Standard-Verteiler: ${std.length} Adresse${std.length===1?'':'n'} (${std.slice(0,2).join(', ')}${std.length>2?' …':''}).`;
    loadStdBtn.disabled = false;
    clearStdBtn.disabled = false;
  }
}

// ---------- Helpers ----------
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const setStatus = (html, cls) => { statusEl.innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fileCountLabel(n) {
  return n === 0 ? 'Keine Bilder ausgewählt.' : `${n} Bild${n===1?'':'er'} ausgewählt`;
}

// ---------- E-Mail-Verteiler ----------
function renderEmails() {
  emailChips.innerHTML = STATE.emails.map((m,i)=>`
    <span class="chip">${escapeHtml(m)} <button type="button" data-i="${i}" aria-label="Entfernen">✕</button></span>
  `).join('');
  emailEmpty.style.display = STATE.emails.length ? 'none' : 'block';
  emailChips.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    STATE.emails.splice(Number(b.dataset.i), 1);
    savePersist();
    renderEmails();
  }));
}
addEmailBtn.addEventListener('click', () => {
  const v = emailInput.value.trim();
  if (!validEmail(v)) { setStatus('Bitte eine gültige E-Mail-Adresse eingeben.', 'err'); return; }
  if (!STATE.emails.includes(v)) STATE.emails.push(v);
  emailInput.value = '';
  savePersist();
  renderEmails();
  setStatus('E-Mail hinzugefügt.', 'ok');
});
emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEmailBtn.click(); } });
standortEl.addEventListener('change', savePersist);

// Standard-Verteiler
loadStdBtn.addEventListener('click', () => {
  const std = getStandardEmails();
  if (!std || !std.length) { setStatus('Kein Standard-Verteiler vorhanden.', 'err'); return; }
  // Merge: doppelte vermeiden
  let added = 0;
  std.forEach(m => { if (!STATE.emails.includes(m)) { STATE.emails.push(m); added++; } });
  savePersist();
  renderEmails();
  setStatus(`Standard-Verteiler geladen — ${added} neue Adresse${added===1?'':'n'} übernommen.`, 'ok');
});
saveStdBtn.addEventListener('click', () => {
  if (!STATE.emails.length) { setStatus('Verteiler ist leer — kein Standard speicherbar.', 'err'); return; }
  setStandardEmails(STATE.emails.slice());
  updateStdStatus();
  setStatus(`Standard-Verteiler gespeichert (${STATE.emails.length} Adresse${STATE.emails.length===1?'':'n'}).`, 'ok');
});
clearStdBtn.addEventListener('click', () => {
  clearStandardEmails();
  updateStdStatus();
  setStatus('Standard-Verteiler gelöscht.', 'ok');
});

// ---------- File-Auswahl ----------
function refreshFileCount() {
  STATE.selectedFiles = collectSelectedFiles();
  fileCount.textContent = fileCountLabel(STATE.selectedFiles.length);
}
function collectSelectedFiles() {
  const map = new Map();
  const gallery = [...(galleryInput.files || [])];
  const camera = STATE.cameraFiles.map(c => c.file);
  [...gallery, ...camera].forEach(f => {
    const key = `${f.name}_${f.size}_${f.lastModified}`;
    if (!map.has(key)) map.set(key, f);
  });
  return [...map.values()];
}
galleryInput.addEventListener('change', refreshFileCount);

// ---------- Kamera-Sammelmodus ----------
async function addCameraFile(file) {
  if (!file) return;
  let thumbUrl = '';
  try {
    const bm = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    const s = Math.min(1, 96 / Math.max(bm.width, bm.height));
    c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s);
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
    if (bm.close) bm.close();
    thumbUrl = c.toDataURL('image/jpeg', 0.7);
  } catch {}
  const ts = Date.now();
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
  const safe = new File([file], `kamera_${ts}${ext}`, { type: file.type || 'image/jpeg', lastModified: ts });
  STATE.cameraFiles.push({ file: safe, thumbUrl, ts });
  renderCameraTray();
  refreshFileCount();
}
function renderCameraTray() {
  const n = STATE.cameraFiles.length;
  trayCount.textContent = String(n);
  cameraTray.classList.toggle('show', n > 0);
  trayThumbs.innerHTML = STATE.cameraFiles.map((c, i) => `
    <div class="tray-thumb">
      <img src="${c.thumbUrl}" alt="Kamera-Foto ${i+1}">
      <button type="button" data-i="${i}" aria-label="Entfernen">✕</button>
    </div>`).join('');
  trayThumbs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    STATE.cameraFiles.splice(Number(b.dataset.i), 1);
    renderCameraTray();
    refreshFileCount();
  }));
}
cameraInput.addEventListener('change', async () => {
  const f = cameraInput.files && cameraInput.files[0];
  if (f) await addCameraFile(f);
  cameraInput.value = '';
});
cameraAddInput.addEventListener('change', async () => {
  const f = cameraAddInput.files && cameraAddInput.files[0];
  if (f) await addCameraFile(f);
  cameraAddInput.value = '';
});
cameraDoneBtn.addEventListener('click', () => {
  if (STATE.cameraFiles.length === 0) { setStatus('Noch keine Kamera-Aufnahmen.', 'err'); return; }
  processBtn.click();
});

// ---------- Bildverarbeitung ----------
// Liest die Datei in ein ImageBitmap mit korrekter EXIF-Orientierung.
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return await createImageBitmap(file); }
}

// Zeichnet bitmap auf ein neues Canvas (vollformat, 1:1).
function bitmapToCanvas(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return c;
}

// Crop des Mittelstreifens (vertikal 30–70 %). Liefert ein neues Canvas.
function cropMiddle(srcCanvas) {
  const h = srcCanvas.height;
  const y0 = Math.round(h * CROP_TOP);
  const y1 = Math.round(h * CROP_BOTTOM);
  const ch = Math.max(1, y1 - y0);
  const cw = srcCanvas.width;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(srcCanvas, 0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

// Canvas → JPEG-Blob mit progressiver Qualitätsreduktion, falls > 4 MB.
async function canvasToJpegBlob(canvas, qStart = JPEG_Q_DEFAULT) {
  const tryEncode = (q) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
  let blob = await tryEncode(qStart);
  if (!blob) return null;
  if (blob.size <= MAX_UPLOAD_BYTES) return blob;
  for (const q of JPEG_Q_FALLBACK) {
    blob = await tryEncode(q);
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
  }
  return blob; // letzter Versuch, evtl. immer noch zu groß
}

// Canvas → DataURL für UI (klein, für Modal-Vorschau).
function canvasToDataUrl(canvas, maxLong = 900, q = 0.82) {
  const w = canvas.width, h = canvas.height;
  const s = Math.min(1, maxLong / Math.max(w, h));
  if (s >= 1) return canvas.toDataURL('image/jpeg', q);
  const small = document.createElement('canvas');
  small.width = Math.round(w * s); small.height = Math.round(h * s);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL('image/jpeg', q);
}

// Komplette Bildvorbereitung:
// → fullCanvas (Originalformat, 1:1), cropCanvas (Mittelstreifen),
//   thumbDataUrl (Tabelle), fullDataUrl (Lightbox), cropDataUrl (Details-Modal)
async function preprocessImage(file) {
  const bitmap = await loadBitmap(file);
  const fullCanvas = bitmapToCanvas(bitmap);
  const cropCanvas = cropMiddle(fullCanvas);
  if (bitmap.close) bitmap.close();

  // Thumbnail klein
  const thumbCanvas = document.createElement('canvas');
  const tScale = Math.min(1, 96 / Math.max(fullCanvas.width, fullCanvas.height));
  thumbCanvas.width = Math.max(1, Math.round(fullCanvas.width * tScale));
  thumbCanvas.height = Math.max(1, Math.round(fullCanvas.height * tScale));
  thumbCanvas.getContext('2d').drawImage(fullCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);

  const fullDataUrl = canvasToDataUrl(fullCanvas, 1400, 0.82);
  const cropDataUrl = canvasToDataUrl(cropCanvas, 1400, 0.85);

  return { fullCanvas, cropCanvas, thumbDataUrl, fullDataUrl, cropDataUrl };
}

// ---------- API ----------
async function callOcr(blob) {
  const resp = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob
  });
  const data = await resp.json().catch(() => ({ ok:false, error_code:'BAD_JSON' }));
  if (!resp.ok || !data.ok) throw new Error(data.error_code || `HTTP_${resp.status}`);
  return data;
}

// ---------- Tie-Breaker für Bounding-Box-Mittelzone ----------
// Eingabe: rohe candidate-Liste mit { digits, raw, vision_confidence, y_mid }.
// Wenn y_mid bekannt ist und die Mehrheit der Bilder im Crop bei 0.3–0.7 lag,
// präferieren wir Kandidaten mit y_mid in der Mitte des Crops.
// Wir geben die sortierte Liste zurück: zentrale Kandidaten zuerst.
function sortCandidatesByCenterPreference(candidates, imageHeight) {
  if (!candidates || candidates.length < 2) return candidates || [];
  if (!imageHeight || imageHeight <= 0) return candidates;
  const centerLow = imageHeight * 0.35;
  const centerHigh = imageHeight * 0.65;
  const scored = candidates.map(c => {
    const yMid = (typeof c.y_mid === 'number') ? c.y_mid : null;
    let inCenter = 0;
    if (yMid != null) {
      inCenter = (yMid >= centerLow && yMid <= centerHigh) ? 1 : 0;
    }
    return { c, inCenter, conf: c.vision_confidence ?? 0 };
  });
  scored.sort((a, b) => (b.inCenter - a.inCenter) || (b.conf - a.conf));
  return scored.map(s => s.c);
}

// ---------- Verarbeitung pro Bild ----------
async function processOne(file, idx, total) {
  const id = crypto.randomUUID();
  setStatus(`Verarbeite Bild ${idx+1} von ${total}: ${escapeHtml(file.name)}`);

  let prepared;
  try { prepared = await preprocessImage(file); }
  catch (e) {
    return blockedRow(id, file.name, `Bild konnte nicht gelesen werden: ${e.message || e}`);
  }
  const { fullCanvas, cropCanvas, thumbDataUrl, fullDataUrl, cropDataUrl } = prepared;

  // Versuch 1: Crop senden (Mittelstreifen)
  let usedStrategy = 'crop';
  let usedImageDataUrl = cropDataUrl;
  let ocrData = null;
  let cropError = null;

  try {
    const cropBlob = await canvasToJpegBlob(cropCanvas, JPEG_Q_DEFAULT);
    if (!cropBlob) throw new Error('CROP_ENCODE_FAILED');
    ocrData = await callOcr(cropBlob);
  } catch (e) { cropError = e; }

  const cropHadHit = ocrData && Array.isArray(ocrData.candidates) && ocrData.candidates.length > 0;

  // Versuch 2: Wenn Crop nichts brachte → Vollbild senden
  if (!cropHadHit) {
    try {
      const fullBlob = await canvasToJpegBlob(fullCanvas, JPEG_Q_DEFAULT);
      if (!fullBlob) throw new Error('FULL_ENCODE_FAILED');
      const fullData = await callOcr(fullBlob);
      if (fullData && Array.isArray(fullData.candidates) && fullData.candidates.length > 0) {
        ocrData = fullData;
        usedStrategy = 'full';
        usedImageDataUrl = fullDataUrl;
      } else if (!ocrData) {
        // Crop war Fehler, Vollbild liefert wenigstens leeres ok-Result
        ocrData = fullData;
        usedStrategy = 'full';
        usedImageDataUrl = fullDataUrl;
      }
    } catch (e) {
      if (!ocrData) {
        return blockedRow(id, file.name, `OCR-Fehler: ${e.message || e}`, {
          thumbDataUrl, fullDataUrl, cropDataUrl,
          attempts: [], source: null, usedStrategy: 'full', usedImageDataUrl: fullDataUrl
        });
      }
    }
  }

  // OCR-Daten auswerten
  const sortedCands = sortCandidatesByCenterPreference(
    ocrData.candidates || [],
    usedStrategy === 'crop' ? cropCanvas.height : fullCanvas.height
  );
  const decisionInput = sortedCands.map(c => ({ digits: c.digits, confidence: c.vision_confidence }));
  const decision = decideStatus(decisionInput);

  const sourcePill = buildSourcePillLabel(ocrData.source, usedStrategy);

  return {
    id, datum: today(),
    digits: decision.digits, formatted: decision.formatted,
    status: decision.status, reasons: decision.reasons || [],
    confidence: decision.confidence, country: decision.country,
    standort: standortEl.value,
    fileName: file.name,
    thumbDataUrl, fullDataUrl, cropDataUrl,
    manualEdited: false,
    // Diagnose
    sourcePill,
    ocrSource: ocrData.source || null,
    usedStrategy,
    usedImageDataUrl,
    rawText: ocrData.full_text_excerpt || '',
    candidates: sortedCands,
    attempts: ocrData.attempts || []
  };
}

function blockedRow(id, fileName, reason, extra = {}) {
  return {
    id, datum: today(),
    digits: null, formatted: null,
    status: 'blocked',
    reasons: [reason],
    confidence: null, country: null,
    standort: standortEl.value,
    fileName,
    thumbDataUrl: extra.thumbDataUrl || '',
    fullDataUrl: extra.fullDataUrl || '',
    cropDataUrl: extra.cropDataUrl || '',
    manualEdited: false,
    sourcePill: null,
    ocrSource: null,
    usedStrategy: extra.usedStrategy || null,
    usedImageDataUrl: extra.usedImageDataUrl || '',
    rawText: '',
    candidates: [],
    attempts: extra.attempts || []
  };
}

function buildSourcePillLabel(source, strategy) {
  if (source === 'google') return 'Google Vision';
  if (source === 'azure') {
    return strategy === 'crop' ? 'Azure (Crop)' : 'Azure (Vollbild)';
  }
  return null;
}

// ---------- Status-Labels ----------
const STATUS_LABEL = {
  auto_ok:   'Auto-OK',
  manual_ok: 'Manuell-OK',
  check:     'Bitte prüfen',
  blocked:   'Blockiert'
};
const STATUS_CLASS = {
  auto_ok:   'b-ok',
  manual_ok: 'b-ok',
  check:     'b-check',
  blocked:   'b-block'
};
function isOk(status) { return status === 'auto_ok' || status === 'manual_ok'; }

// ---------- Render-Tabelle ----------
function statusDropdown(row) {
  const opts = [];
  if (row.status === 'auto_ok') {
    opts.push({ v: 'auto_ok', t: 'Auto-OK (automatisch)', disabled: true });
  }
  opts.push(
    { v: 'manual_ok', t: 'Manuell-OK',   disabled: false },
    { v: 'check',     t: 'Bitte prüfen', disabled: false },
    { v: 'blocked',   t: 'Blockiert',    disabled: false }
  );
  return `<select class="status-select" data-id="${row.id}" aria-label="Status ändern">
    ${opts.map(o => `<option value="${o.v}"${o.v===row.status?' selected':''}${o.disabled?' disabled':''}>${o.t}</option>`).join('')}
  </select>`;
}

function renderRows() {
  if (!STATE.rows.length) {
    resultsBody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">Noch keine Daten.</td></tr>';
    summary.style.display = 'none';
    return;
  }
  resultsBody.innerHTML = STATE.rows.map(r => {
    const val = r.formatted || r.digits || '';
    // Status-Hinweis bleibt unter Wagennummer (z. B. "Prüfziffer falsch", "Manuell freigegeben").
    const reason = r.reasons && r.reasons.length ? `<div class="reason">${escapeHtml(r.reasons.join(' · '))}</div>` : '';

    // --- OCR-Infos-Spalte (neu, rechts vom Datum): nur für Admins/Diagnose ---
    const ocrCountryLine = r.country
      ? `<div class="ocr-line">${escapeHtml(r.country)}${r.confidence!=null?` · OCR ${(r.confidence*100).toFixed(0)}%`:''}</div>`
      : (r.confidence!=null ? `<div class="ocr-line">OCR ${(r.confidence*100).toFixed(0)}%</div>` : '');
    const sourcePill = r.sourcePill ? `<span class="source-pill">${escapeHtml(r.sourcePill)}</span>` : '';
    const detailsBtn = (r.rawText || r.candidates?.length || r.attempts?.length || r.usedImageDataUrl)
      ? `<button type="button" class="details-btn" data-id="${r.id}">OCR-Details</button>` : '';
    const ocrActions = (sourcePill || detailsBtn)
      ? `<div class="ocr-actions">${sourcePill}${detailsBtn}</div>` : '';
    const ocrCell = (ocrCountryLine || ocrActions) ? `${ocrCountryLine}${ocrActions}` : '<span style="color:var(--muted)">—</span>';

    const thumb = r.thumbDataUrl
      ? `<img class="thumb thumb-zoom" data-id="${r.id}" src="${r.thumbDataUrl}" alt="Bild vergrößern" title="Bild vergrößern">`
      : '<div class="thumb"></div>';
    const badgeCls = STATUS_CLASS[r.status] || 'b-block';
    return `
      <tr data-id="${r.id}">
        <td class="col-status">
          <span class="badge ${badgeCls}">${STATUS_LABEL[r.status] || r.status}</span>
          ${statusDropdown(r)}
        </td>
        <td class="col-num">
          <input class="num-input" data-id="${r.id}" value="${escapeHtml(val)}" placeholder="manuell eingeben" inputmode="numeric" autocomplete="off" />
          ${reason}
        </td>
        <td class="col-img">${thumb}</td>
        <td class="col-loc">${escapeHtml(r.standort)}<div class="reason" style="font-size:11px" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</div></td>
        <td class="col-date">${r.datum}</td>
        <td class="col-ocr">${ocrCell}</td>
      </tr>`;
  }).join('');

  // Wagennummer-Edit:
  //  - 'input'  : Roh-Eingabe sofort in STATE festhalten, damit sie nicht verloren geht,
  //               wenn der Nutzer zwischendurch auf das Bild klickt oder die Tabelle re-rendert.
  //  - 'change' : volle Validierung + Re-Render.
  resultsBody.querySelectorAll('input.num-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const row = STATE.rows.find(x => x.id === inp.dataset.id);
      if (!row) return;
      row.formatted = inp.value;  // Roh-Anzeige, kein Re-Render
      row.manualEdited = true;
    });
    inp.addEventListener('change', () => {
      const row = STATE.rows.find(x => x.id === inp.dataset.id);
      if (!row) return;
      const decision = decideManualEntry(inp.value);
      row.digits = decision.digits;
      row.formatted = decision.formatted || inp.value;  // Roh-Eingabe behalten, wenn (noch) ungültig
      row.status = decision.status === 'auto_ok' ? 'manual_ok' : decision.status;
      row.reasons = decision.reasons;
      row.country = decision.country;
      row.confidence = 0;
      row.manualEdited = true;
      renderRows();
      updateSummary();
      updateExportGates();
    });
  });

  // Status-Dropdown
  resultsBody.querySelectorAll('select.status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const row = STATE.rows.find(x => x.id === sel.dataset.id);
      if (!row) return;
      row.status = sel.value;
      if (sel.value === 'manual_ok') {
        row.manualEdited = true;
        row.reasons = ['Manuell freigegeben'];
      }
      renderRows();
      updateSummary();
      updateExportGates();
    });
  });

  // Thumbnails → Lightbox
  resultsBody.querySelectorAll('img.thumb-zoom').forEach(img => {
    img.addEventListener('click', () => {
      const row = STATE.rows.find(x => x.id === img.dataset.id);
      if (!row) return;
      openLightbox(row.fullDataUrl || row.thumbDataUrl, row.fileName, row.id);
    });
  });

  // Details-Buttons
  resultsBody.querySelectorAll('button.details-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = STATE.rows.find(x => x.id === btn.dataset.id);
      if (row) openDetails(row);
    });
  });

  updateSummary();
}

function updateSummary() {
  const ok = STATE.rows.filter(r => isOk(r.status)).length;
  const ck = STATE.rows.filter(r => r.status === 'check').length;
  const bl = STATE.rows.filter(r => r.status === 'blocked').length;
  sumOk.textContent = ok; sumCheck.textContent = ck; sumBlock.textContent = bl;
  summary.style.display = STATE.rows.length ? 'grid' : 'none';
  return { ok, ck, bl };
}
function updateExportGates() {
  const hasRows = STATE.rows.length > 0;
  excelBtn.disabled = !hasRows;
  // Mail bleibt klickbar; das Excel-Gate triggert beim Klick einen Hinweis.
  // (So merkt der Nutzer, dass er Schritt 2 übersprungen hat, und kann bewusst weitermachen.)
  mailBtn.disabled  = !hasRows;
  // visuelles Aria-Hint: 'aria-disabled' zeigt UI-Aufmerksamkeit, ohne Klicks zu blockieren
  if (hasRows && !STATE.excelDownloaded) {
    mailBtn.setAttribute('aria-disabled', 'true');
    mailBtn.title = 'Bitte zuerst Schritt 2 ausführen: Excel herunterladen.';
  } else {
    mailBtn.removeAttribute('aria-disabled');
    mailBtn.title = '';
  }
}

// ---------- Lightbox ----------
// Variante B: Lightbox enthält Bild + Wagennummer-Edit-Feld der geklickten Zeile direkt darunter.
// Beim Fokus auf das Edit-Feld schrumpft das Bild (Klasse 'editing'), damit das Feld bei
// aufklappender iOS-Tastatur sichtbar bleibt.
function renderLightboxStatus(row) {
  if (!row) { lightboxStatus.textContent = ''; lightboxStatus.className = 'lightbox-status'; return; }
  const reasons = (row.reasons && row.reasons.length) ? row.reasons.join(' · ') : '';
  lightboxStatus.textContent = reasons;
  lightboxStatus.className = 'lightbox-status';
  if (row.status === 'blocked' || (reasons && /falsch|ungültig|blockiert/i.test(reasons))) {
    lightboxStatus.classList.add('bad');
  } else if (row.status === 'manual_ok' || row.status === 'auto_ok') {
    lightboxStatus.classList.add('ok');
  }
}
function openLightbox(src, name, rowId) {
  lightboxImg.src = src;
  lightboxImg.alt = name || '';
  lightbox.classList.add('show');
  lightbox.classList.remove('editing');
  lightboxRowId = rowId || null;
  // Edit-Bereich nur zeigen, wenn eine echte Tabellenzeile dahinter steht (nicht bei Beispielfotos)
  if (rowId) {
    const row = STATE.rows.find(x => x.id === rowId);
    if (row) {
      lightboxEdit.style.display = '';
      lightboxNumInput.value = row.formatted || row.digits || '';
      renderLightboxStatus(row);
      // Bestätigen-Button bei blockierten ODER "Bitte prüfen"-Zeilen anzeigen
      // (schneller Freigabe-Workflow für alle Zeilen, die manuelle Sichtprüfung brauchen)
      if (row.status === 'blocked' || row.status === 'check') lightboxConfirm.classList.add('show');
      else lightboxConfirm.classList.remove('show');
    } else {
      lightboxEdit.style.display = 'none';
      lightboxConfirm.classList.remove('show');
    }
  } else {
    lightboxEdit.style.display = 'none';
    lightboxConfirm.classList.remove('show');
  }
}
function closeLightbox() {
  lightbox.classList.remove('show');
  lightbox.classList.remove('editing');
  lightboxImg.src = '';
  lightboxRowId = null;
  lightboxEdit.style.display = 'none';
  lightboxConfirm.classList.remove('show');
}
lightboxClose.addEventListener('click', closeLightbox);
// Kein Backdrop-Klick-Close: Auf iOS führen Layout-Shifts beim Öffnen/Schließen der
// Tastatur dazu, dass Touch-Endpunkte auf dem schwarzen Hintergrund landen und die
// Lightbox versehentlich schließen, während der Nutzer die Wagennummer bearbeitet.
// Schließen geht nur über den X-Button oder ESC.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeLightbox(); closeDetails(); } });

// Bestätigen-Button: setzt Status auf manual_ok (gleiche Logik wie Dropdown-Auswahl 'manual_ok')
// und schließt die Lightbox sofort, damit der Nutzer schnell zur nächsten Zeile kann.
lightboxConfirm.addEventListener('click', () => {
  if (!lightboxRowId) return;
  const row = STATE.rows.find(x => x.id === lightboxRowId);
  if (!row) return;
  row.status = 'manual_ok';
  row.manualEdited = true;
  row.reasons = ['Manuell freigegeben'];
  renderRows();
  updateSummary();
  updateExportGates();
  closeLightbox();
});

// Lightbox-Wagennummer-Edit: gleiche Logik wie Tabellen-Input ('input' = roh, 'change' = validieren)
lightboxNumInput.addEventListener('focus', () => { lightbox.classList.add('editing'); });
lightboxNumInput.addEventListener('blur',  () => { lightbox.classList.remove('editing'); });
lightboxNumInput.addEventListener('input', () => {
  if (!lightboxRowId) return;
  const row = STATE.rows.find(x => x.id === lightboxRowId);
  if (!row) return;
  row.formatted = lightboxNumInput.value;
  row.manualEdited = true;
  // Tabellen-Input synchron halten, ohne Re-Render
  const tableInput = document.querySelector(`input.num-input[data-id="${lightboxRowId}"]`);
  if (tableInput && tableInput.value !== lightboxNumInput.value) tableInput.value = lightboxNumInput.value;
});
lightboxNumInput.addEventListener('change', () => {
  if (!lightboxRowId) return;
  const row = STATE.rows.find(x => x.id === lightboxRowId);
  if (!row) return;
  const decision = decideManualEntry(lightboxNumInput.value);
  row.digits = decision.digits;
  row.formatted = decision.formatted || lightboxNumInput.value;
  row.status = decision.status === 'auto_ok' ? 'manual_ok' : decision.status;
  row.reasons = decision.reasons;
  row.country = decision.country;
  row.confidence = 0;
  row.manualEdited = true;
  renderRows();
  updateSummary();
  updateExportGates();
  // Status-Anzeige in der Lightbox aktualisieren
  renderLightboxStatus(row);
});

// ---------- OCR-Details-Modal ----------
function openDetails(row) {
  // Source-Pills: bevorzugt finale Auswahl + alle Versuche
  const pills = [];
  if (row.sourcePill) pills.push(`<span class="source-pill">Aktiv: ${escapeHtml(row.sourcePill)}</span>`);
  (row.attempts || []).forEach(a => {
    const ok = a.ok ? '✓' : '✗';
    const label = `${a.source === 'azure' ? 'Azure' : 'Google'} ${ok}${a.error?.code ? ` (${a.error.code})` : ''}${typeof a.candidates?.length === 'number' ? ` · ${a.candidates.length} Treffer` : ''}`;
    pills.push(`<span class="source-pill">${escapeHtml(label)}</span>`);
  });
  detailsSource.innerHTML = pills.join(' ');

  detailsImg.src = row.usedImageDataUrl || row.cropDataUrl || row.fullDataUrl || '';
  detailsImg.alt = row.fileName || '';

  detailsRaw.textContent = row.rawText && row.rawText.trim()
    ? row.rawText
    : '— (kein Roh-Text vom OCR vorhanden)';

  if (row.candidates && row.candidates.length) {
    const lines = row.candidates.map((c, i) => {
      const conf = c.vision_confidence != null ? `${(c.vision_confidence*100).toFixed(0)}%` : '—';
      const y = c.y_mid != null ? `y≈${Math.round(c.y_mid)}` : '';
      return `${i+1}. ${c.digits || '(?)'} — Roh: ${c.raw || ''} — OCR: ${conf} ${y}`;
    });
    detailsCands.textContent = lines.join('\n');
  } else {
    detailsCands.textContent = '— (keine Zifferngruppen gefunden)';
  }
  detailsModal.classList.add('show');
}
function closeDetails() {
  detailsModal.classList.remove('show');
}
detailsClose.addEventListener('click', closeDetails);
detailsModal.addEventListener('click', (e) => { if (e.target === detailsModal) closeDetails(); });

// ---------- Auswertung ----------
processBtn.addEventListener('click', async () => {
  refreshFileCount();
  if (!STATE.selectedFiles.length) { setStatus('Bitte Bilder auswählen.', 'err'); return; }
  // Neue Auswertung: Excel-Gate zurücksetzen (Datensätze haben sich geändert)
  STATE.excelDownloaded = false;
  processBtn.disabled = true; excelBtn.disabled = true; mailBtn.disabled = true;
  const files = STATE.selectedFiles;
  for (let i = 0; i < files.length; i++) {
    const row = await processOne(files[i], i, files.length);
    STATE.rows.push(row);
    renderRows();
  }
  STATE.cameraFiles = [];
  renderCameraTray();
  galleryInput.value = '';
  refreshFileCount();
  const { ok, ck, bl } = updateSummary();
  setStatus(`<span class="ok">${ok} OK</span> · <span class="warn">${ck} bitte prüfen</span> · <span class="err">${bl} blockiert</span>`);
  processBtn.disabled = false;
  updateExportGates();
});

// ---------- Excel-Export ----------
// Spaltenreihenfolge (laut Anforderung):
//  Wagennummer, Standort, Datum, Land, Status, Hinweise,
//  OCR-Confidence, Manuell bearbeitet, OCR-Quelle, Bilddatei
function buildWorkbook() {
  const data = STATE.rows.map(r => ({
    Wagennummer: r.formatted || r.digits || '',
    Standort: r.standort,
    Datum: r.datum,
    Land: r.country || '',
    Status: STATUS_LABEL[r.status] || r.status,
    Hinweise: (r.reasons || []).join(' · '),
    'OCR-Confidence': r.confidence != null ? Math.round(r.confidence * 100) + '%' : '',
    'Manuell bearbeitet': r.manualEdited ? 'Ja' : 'Nein',
    'OCR-Quelle': r.sourcePill || '',
    Bilddatei: r.fileName,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  // Spaltenbreiten in derselben Reihenfolge
  ws['!cols'] = [
    { wch: 22 }, // Wagennummer
    { wch: 14 }, // Standort
    { wch: 12 }, // Datum
    { wch: 14 }, // Land
    { wch: 14 }, // Status
    { wch: 40 }, // Hinweise
    { wch: 14 }, // OCR-Confidence
    { wch: 18 }, // Manuell bearbeitet
    { wch: 16 }, // OCR-Quelle
    { wch: 30 }, // Bilddatei
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wagennummern');
  return wb;
}
function triggerDownload() {
  const wb = buildWorkbook();
  const filename = `wagennummern_${standortEl.value}_${today()}.xlsx`;
  try {
    XLSX.writeFile(wb, filename, { compression: true });
    setStatus(`Excel-Datei „${filename}" gespeichert.`, 'ok');
  } catch (e) {
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    setStatus(`Excel-Datei „${filename}" wird heruntergeladen.`, 'ok');
  }
  // Excel-Gate öffnet sich -> Mail darf freigeschaltet werden
  STATE.excelDownloaded = true;
  updateExportGates();
}
function withBlockedGuard(action, kind) {
  const blocked = STATE.rows.filter(r => r.status === 'blocked').length;
  if (blocked === 0) { action(); return; }
  overrideText.textContent = `Es gibt noch ${blocked} blockierte Zeile${blocked===1?'':'n'} ohne sichere Erkennung. ${kind} trotzdem fortsetzen?`;
  overrideModal.classList.add('show');
  STATE.overrideCallback = action;
}
overrideCancel.addEventListener('click', () => { overrideModal.classList.remove('show'); STATE.overrideCallback = null; });
overrideConfirm.addEventListener('click', () => {
  overrideModal.classList.remove('show');
  const cb = STATE.overrideCallback; STATE.overrideCallback = null;
  if (cb) cb();
});
excelBtn.addEventListener('click', () => withBlockedGuard(triggerDownload, 'Excel-Export'));

// ---------- Mail-Vorbereitung mit Excel-Gate ----------
// Mail-Body benutzt dieselbe Spaltenreihenfolge wie die Excel-Datei,
// damit der Empfänger beides leicht abgleichen kann.
function buildMailBody() {
  const header = ['Wagennummer','Standort','Datum','Land','Status','Hinweise','OCR-Confidence','Manuell','OCR-Quelle','Bilddatei'];
  const rows = STATE.rows.map(r => [
    r.formatted || r.digits || 'NICHT ERKANNT',
    r.standort,
    r.datum,
    r.country || '',
    STATUS_LABEL[r.status] || r.status,
    (r.reasons || []).join(' · '),
    r.confidence != null ? Math.round(r.confidence * 100) + '%' : '',
    r.manualEdited ? 'Ja' : 'Nein',
    r.sourcePill || '',
    r.fileName,
  ].join(' | '));
  const lines = [
    `Standort: ${standortEl.value}`,
    `Datum: ${today()}`,
    '',
    'Datensätze:',
    header.join(' | '),
    ...rows,
    '',
    'Hinweis: Bitte die Excel-Datei aus der App anhängen.'
  ];
  return lines.join('\n');
}
function sendMail() {
  if (!STATE.emails.length) { setStatus('Bitte mindestens eine E-Mail-Adresse hinzufügen.', 'err'); return; }
  const to = STATE.emails.join(',');
  const subject = encodeURIComponent(`Wagennummern ${standortEl.value} ${today()}`);
  const body = encodeURIComponent(buildMailBody());
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  setStatus('Mail-Entwurf wurde vorbereitet.', 'ok');
}
mailBtn.addEventListener('click', () => withBlockedGuard(() => {
  // Wichtig: Mail erst nach Excel-Download. Wenn nicht heruntergeladen,
  // öffnen wir einen Bestätigungs-Dialog. Wird er bestätigt, wird die Mail trotzdem gesendet.
  if (!STATE.excelDownloaded) {
    overrideText.textContent = 'Die Excel-Datei wurde noch nicht heruntergeladen. Mail trotzdem vorbereiten? Wir empfehlen, zuerst Schritt 2 (Excel herunterladen) auszuführen, damit der Empfänger die Datei anhängen kann.';
    overrideModal.classList.add('show');
    STATE.overrideCallback = sendMail;
    return;
  }
  sendMail();
}, 'Mail-Vorbereitung'));

// ---------- Reset ----------
resetBtn.addEventListener('click', () => {
  STATE.rows = [];
  STATE.selectedFiles = [];
  STATE.cameraFiles = [];
  STATE.excelDownloaded = false;
  galleryInput.value = '';
  cameraInput.value = '';
  if (cameraAddInput) cameraAddInput.value = '';
  renderCameraTray();
  renderRows();
  refreshFileCount();
  updateExportGates();
  setStatus('Zurückgesetzt.', 'ok');
});

// ---------- Beispielfotos: Klick öffnet Lightbox ----------
document.querySelectorAll('.example img[data-example]').forEach(img => {
  img.addEventListener('click', () => {
    openLightbox(img.src, img.alt);
  });
});

// ---------- Feedback-Button ----------
(() => {
  const fb = document.getElementById('feedbackBtn');
  if (!fb) return;
  const to = 'j-bleich@gmx.net';
  const subject = 'Feedback WagenIdent App';
  const body = [
    'Hi,',
    '',
    'Ich erbitte folgende Änderung in der WagenIdent App:',
    '',
    '',
  ].join('\n');
  fb.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
})();

// ---------- Test-Hooks (nur für automatische Tests; in Produktion harmlos) ----------
if (typeof window !== 'undefined') {
  // Wird ausschließlich vom E2E-Test gelesen. Schreibender Zugriff aus der UI
  // ist nicht nötig und nicht vorgesehen.
  window.__wagenident = Object.freeze({
    get STATE() { return STATE; },
    renderRows,
    buildWorkbook,
    updateExportGates,
  });
}

// ---------- Init ----------
loadPersist();
renderEmails();
renderRows();
refreshFileCount();
updateStdStatus();
