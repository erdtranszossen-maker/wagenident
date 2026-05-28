// app.js — Frontend-Logik der Wagenident-App
import { decideStatus, decideManualEntry, formatUic } from './lib/uic.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const galleryInput = $('galleryInput');
const cameraInput  = $('cameraInput');
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
const downloadPanel= $('downloadPanel');
const downloadLink = $('downloadLink');
const summary      = $('summary');
const sumOk        = $('sumOk');
const sumCheck     = $('sumCheck');
const sumBlock     = $('sumBlock');
const overrideModal= $('overrideModal');
const overrideText = $('overrideText');
const overrideCancel = $('overrideCancel');
const overrideConfirm= $('overrideConfirm');

// ---------- State ----------
const STATE = {
  rows: [],        // { id, datum, digits, formatted, status, reasons, confidence, country, standort, fileName, thumbDataUrl, manualEdited }
  emails: [],
  selectedFiles: [],
  downloadUrl: null,
  overrideCallback: null
};

// ---------- Persistence ----------
function loadPersist() {
  try {
    const raw = localStorage.getItem('wagenident.v1');
    if (raw) {
      const o = JSON.parse(raw);
      STATE.emails = Array.isArray(o.emails) ? o.emails : [];
      if (o.standort) standortEl.value = o.standort;
    }
  } catch {}
}
function savePersist() {
  try {
    localStorage.setItem('wagenident.v1', JSON.stringify({
      emails: STATE.emails,
      standort: standortEl.value
    }));
  } catch {}
}

// ---------- Helpers ----------
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const setStatus = (html, cls) => { statusEl.innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };

// ---------- Email-Verteiler ----------
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

// ---------- File-Auswahl ----------
function refreshFileCount() {
  STATE.selectedFiles = collectSelectedFiles();
  fileCount.textContent = STATE.selectedFiles.length
    ? `${STATE.selectedFiles.length} Bild${STATE.selectedFiles.length===1?'':'er'} ausgewählt`
    : 'Keine Bilder ausgewählt.';
}
function collectSelectedFiles() {
  const map = new Map();
  [...(galleryInput.files || []), ...(cameraInput.files || [])].forEach(f => {
    const key = `${f.name}_${f.size}_${f.lastModified}`;
    if (!map.has(key)) map.set(key, f);
  });
  return [...map.values()];
}
galleryInput.addEventListener('change', refreshFileCount);
cameraInput.addEventListener('change', refreshFileCount);

// ---------- Bildvorverarbeitung: Resize + EXIF Rotation ----------
async function preprocessImage(file) {
  // Versuche createImageBitmap mit EXIF-Rotation
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Fallback: ohne EXIF-Rotation
    bitmap = await createImageBitmap(file);
  }
  const MAX_LONG = 1600;
  const scale = Math.min(1, MAX_LONG / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  // Thumb (klein) fürs UI
  const thumbCanvas = document.createElement('canvas');
  const tScale = Math.min(1, 96 / Math.max(w, h));
  thumbCanvas.width = Math.round(w * tScale);
  thumbCanvas.height = Math.round(h * tScale);
  thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob, thumbDataUrl };
}

// ---------- API-Call ----------
async function callOcr(blob) {
  // Direkt als Binary senden (einfacher und robuster als Multipart)
  const resp = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob
  });
  const data = await resp.json().catch(() => ({ ok:false, error_code:'BAD_JSON' }));
  if (!resp.ok || !data.ok) {
    throw new Error(data.error_code || `HTTP_${resp.status}`);
  }
  return data;
}

// ---------- Verarbeitung pro Bild ----------
async function processOne(file, idx, total) {
  const id = crypto.randomUUID();
  setStatus(`Verarbeite Bild ${idx+1} von ${total}: ${escapeHtml(file.name)}`);
  let thumbDataUrl = '';
  try {
    const { blob, thumbDataUrl: t } = await preprocessImage(file);
    thumbDataUrl = t;
    const data = await callOcr(blob);
    const decision = decideStatus(
      (data.candidates || []).map(c => ({ digits: c.digits, confidence: c.vision_confidence }))
    );
    return makeRow(id, decision, file.name, thumbDataUrl);
  } catch (e) {
    return {
      id,
      datum: today(),
      digits: null,
      formatted: null,
      status: 'blocked',
      reasons: [`Fehler: ${e.message || e}`],
      confidence: null,
      country: null,
      standort: standortEl.value,
      fileName: file.name,
      thumbDataUrl,
      manualEdited: false
    };
  }
}

function makeRow(id, decision, fileName, thumbDataUrl) {
  return {
    id,
    datum: today(),
    digits: decision.digits,
    formatted: decision.formatted,
    status: decision.status,
    reasons: decision.reasons || [],
    confidence: decision.confidence,
    country: decision.country,
    standort: standortEl.value,
    fileName,
    thumbDataUrl,
    manualEdited: false
  };
}

// ---------- Render-Tabelle ----------
function badge(status) {
  if (status === 'auto_ok') return '<span class="badge b-ok">Auto-OK</span>';
  if (status === 'check')   return '<span class="badge b-check">Bitte prüfen</span>';
  return '<span class="badge b-block">Blockiert</span>';
}

function renderRows() {
  if (!STATE.rows.length) {
    resultsBody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">Noch keine Daten.</td></tr>';
    summary.style.display = 'none';
    return;
  }
  resultsBody.innerHTML = STATE.rows.map(r => {
    const val = r.formatted || r.digits || '';
    const reason = r.reasons && r.reasons.length ? `<div class="reason">${escapeHtml(r.reasons.join(' · '))}</div>` : '';
    const country = r.country ? `<div class="reason">${escapeHtml(r.country)}${r.confidence!=null?` · OCR ${(r.confidence*100).toFixed(0)}%`:''}</div>` : '';
    const thumb = r.thumbDataUrl ? `<img class="thumb" src="${r.thumbDataUrl}" alt="">` : '<div class="thumb"></div>';
    return `
      <tr data-id="${r.id}">
        <td>${r.datum}</td>
        <td>
          <input class="num-input" data-id="${r.id}" value="${escapeHtml(val)}" placeholder="manuell eingeben" inputmode="numeric" />
          ${reason}
          ${country}
        </td>
        <td>${escapeHtml(r.standort)}</td>
        <td><div class="file-cell">${thumb}<span class="name" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</span></div></td>
        <td>${badge(r.status)}</td>
      </tr>`;
  }).join('');

  // Inline-Edit
  resultsBody.querySelectorAll('input.num-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.id;
      const row = STATE.rows.find(x => x.id === id);
      if (!row) return;
      const decision = decideManualEntry(inp.value);
      row.digits = decision.digits;
      row.formatted = decision.formatted;
      row.status = decision.status;
      row.reasons = decision.reasons;
      row.confidence = decision.confidence;
      row.country = decision.country;
      row.manualEdited = true;
      renderRows();
      updateSummary();
      updateExportGates();
    });
  });
  updateSummary();
}

function updateSummary() {
  const ok = STATE.rows.filter(r => r.status === 'auto_ok').length;
  const ck = STATE.rows.filter(r => r.status === 'check').length;
  const bl = STATE.rows.filter(r => r.status === 'blocked').length;
  sumOk.textContent = ok; sumCheck.textContent = ck; sumBlock.textContent = bl;
  summary.style.display = STATE.rows.length ? 'grid' : 'none';
  return { ok, ck, bl };
}

function updateExportGates() {
  const hasRows = STATE.rows.length > 0;
  excelBtn.disabled = !hasRows;
  mailBtn.disabled  = !hasRows;
}

// ---------- Auswertung starten ----------
processBtn.addEventListener('click', async () => {
  refreshFileCount();
  if (!STATE.selectedFiles.length) { setStatus('Bitte Bilder auswählen.', 'err'); return; }
  processBtn.disabled = true; excelBtn.disabled = true; mailBtn.disabled = true;
  downloadPanel.style.display = 'none';
  const files = STATE.selectedFiles;
  for (let i = 0; i < files.length; i++) {
    const row = await processOne(files[i], i, files.length);
    STATE.rows.push(row);
    renderRows();
  }
  const { ok, ck, bl } = updateSummary();
  setStatus(`<span class="ok">${ok} Auto-OK</span> · <span class="warn">${ck} bitte prüfen</span> · <span class="err">${bl} blockiert</span>`);
  processBtn.disabled = false;
  updateExportGates();
});

// ---------- Excel-Export ----------
function buildWorkbook() {
  const data = STATE.rows.map(r => ({
    Datum: r.datum,
    Wagennummer: r.formatted || r.digits || '',
    Standort: r.standort,
    Bilddatei: r.fileName,
    Status: r.status === 'auto_ok' ? 'Auto-OK' : r.status === 'check' ? 'Bitte prüfen' : 'Blockiert',
    Land: r.country || '',
    'OCR-Confidence': r.confidence != null ? Math.round(r.confidence*100) + '%' : '',
    Hinweise: (r.reasons||[]).join(' · '),
    'Manuell bearbeitet': r.manualEdited ? 'Ja' : 'Nein'
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{wch:12},{wch:22},{wch:12},{wch:30},{wch:14},{wch:14},{wch:14},{wch:40},{wch:18}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wagennummern');
  const out = XLSX.write(wb, { bookType:'xlsx', type:'array' });
  return new Blob([out], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function prepareDownload() {
  const blob = buildWorkbook();
  if (STATE.downloadUrl) URL.revokeObjectURL(STATE.downloadUrl);
  STATE.downloadUrl = URL.createObjectURL(blob);
  const filename = `wagennummern_${standortEl.value}_${today()}.xlsx`;
  downloadLink.href = STATE.downloadUrl;
  downloadLink.download = filename;
  downloadLink.textContent = filename;
  downloadPanel.style.display = 'block';
  setStatus('Excel-Datei bereit. Auf den Dateinamen tippen zum Speichern.', 'ok');
  downloadPanel.scrollIntoView({ behavior:'smooth', block:'center' });
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

excelBtn.addEventListener('click', () => withBlockedGuard(prepareDownload, 'Excel-Export'));

mailBtn.addEventListener('click', () => withBlockedGuard(() => {
  if (!STATE.emails.length) { setStatus('Bitte mindestens eine E-Mail-Adresse hinzufügen.', 'err'); return; }
  const to = STATE.emails.join(',');
  const subject = encodeURIComponent(`Wagennummern ${standortEl.value} ${today()}`);
  const lines = [
    `Standort: ${standortEl.value}`,
    `Datum: ${today()}`,
    '',
    'Datensätze:',
    ...STATE.rows.map(r => `${r.datum} | ${r.formatted || r.digits || 'NICHT ERKANNT'} | ${r.standort} | ${r.fileName} | ${r.status}`),
    '',
    'Hinweis: Bitte die Excel-Datei aus der App anhängen.'
  ];
  const body = encodeURIComponent(lines.join('\n'));
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  setStatus('Mail-Entwurf wurde vorbereitet.', 'ok');
}, 'Mail-Versand'));

resetBtn.addEventListener('click', () => {
  STATE.rows = [];
  STATE.selectedFiles = [];
  galleryInput.value = '';
  cameraInput.value = '';
  downloadPanel.style.display = 'none';
  renderRows();
  refreshFileCount();
  updateExportGates();
  setStatus('Zurückgesetzt.', 'ok');
});

// ---------- Utility ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Init ----------
loadPersist();
renderEmails();
renderRows();
refreshFileCount();
