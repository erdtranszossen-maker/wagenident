// app.js — Frontend-Logik der Wagenident-App (v2)
import { decideStatus, decideManualEntry } from './lib/uic.js';

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

// ---------- State ----------
// status-Werte intern: 'auto_ok' | 'manual_ok' | 'check' | 'blocked'
// 'auto_ok' + 'manual_ok' = grün (OK)
const STATE = {
  rows: [],
  emails: [],
  selectedFiles: [],
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
      emails: STATE.emails, standort: standortEl.value
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
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

// ---------- Bildvorverarbeitung ----------
// Liefert: { blob (für OCR-Upload), thumbDataUrl (Tabellen-Thumbnail), fullDataUrl (Lightbox) }
async function preprocessImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bitmap = await createImageBitmap(file); }

  const MAX_LONG = 1600;
  const scale = Math.min(1, MAX_LONG / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  // Großvorschau (z.B. max 1200px Längskante) für die Lightbox
  const fullCanvas = document.createElement('canvas');
  const fScale = Math.min(1, 1200 / Math.max(w, h));
  fullCanvas.width = Math.round(w * fScale);
  fullCanvas.height = Math.round(h * fScale);
  fullCanvas.getContext('2d').drawImage(canvas, 0, 0, fullCanvas.width, fullCanvas.height);
  const fullDataUrl = fullCanvas.toDataURL('image/jpeg', 0.82);

  // Tabellen-Thumb klein
  const thumbCanvas = document.createElement('canvas');
  const tScale = Math.min(1, 96 / Math.max(w, h));
  thumbCanvas.width = Math.round(w * tScale);
  thumbCanvas.height = Math.round(h * tScale);
  thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob, thumbDataUrl, fullDataUrl };
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

// ---------- Verarbeitung ----------
async function processOne(file, idx, total) {
  const id = crypto.randomUUID();
  setStatus(`Verarbeite Bild ${idx+1} von ${total}: ${escapeHtml(file.name)}`);
  let thumbDataUrl = '', fullDataUrl = '';
  try {
    const { blob, thumbDataUrl: t, fullDataUrl: f } = await preprocessImage(file);
    thumbDataUrl = t; fullDataUrl = f;
    const data = await callOcr(blob);
    const decision = decideStatus(
      (data.candidates || []).map(c => ({ digits: c.digits, confidence: c.vision_confidence }))
    );
    return makeRow(id, decision, file.name, thumbDataUrl, fullDataUrl);
  } catch (e) {
    return {
      id, datum: today(),
      digits: null, formatted: null,
      status: 'blocked',
      reasons: [`Fehler: ${e.message || e}`],
      confidence: null, country: null,
      standort: standortEl.value,
      fileName: file.name,
      thumbDataUrl, fullDataUrl,
      manualEdited: false
    };
  }
}

function makeRow(id, decision, fileName, thumbDataUrl, fullDataUrl) {
  return {
    id, datum: today(),
    digits: decision.digits,
    formatted: decision.formatted,
    status: decision.status,
    reasons: decision.reasons || [],
    confidence: decision.confidence,
    country: decision.country,
    standort: standortEl.value,
    fileName, thumbDataUrl, fullDataUrl,
    manualEdited: false
  };
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
  manual_ok: 'b-ok',     // gemeinsame grüne Kategorie
  check:     'b-check',
  blocked:   'b-block'
};
function isOk(status) { return status === 'auto_ok' || status === 'manual_ok'; }

// ---------- Render-Tabelle ----------
function statusDropdown(row) {
  // 'Auto-OK' nur wählbar, wenn Validierung das hergibt — sonst deaktiviert.
  // Benutzer kann zwischen den anderen Status frei wählen.
  const opts = [
    { v: 'auto_ok',   t: 'Auto-OK',     disabled: row.status !== 'auto_ok' },
    { v: 'manual_ok', t: 'Manuell-OK',  disabled: false },
    { v: 'check',     t: 'Bitte prüfen',disabled: false },
    { v: 'blocked',   t: 'Blockiert',   disabled: false }
  ];
  return `<select class="status-select" data-id="${row.id}" aria-label="Status ändern">
    ${opts.map(o => `<option value="${o.v}"${o.v===row.status?' selected':''}${o.disabled?' disabled':''}>${o.t}</option>`).join('')}
  </select>`;
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
    const thumb = r.thumbDataUrl
      ? `<img class="thumb thumb-zoom" data-id="${r.id}" src="${r.thumbDataUrl}" alt="Bild vergrößern" title="Bild vergrößern">`
      : '<div class="thumb"></div>';
    const badgeCls = STATUS_CLASS[r.status] || 'b-block';
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
        <td>
          <span class="badge ${badgeCls}">${STATUS_LABEL[r.status] || r.status}</span>
          ${statusDropdown(r)}
        </td>
      </tr>`;
  }).join('');

  // Wagennummer-Edit (Re-Validierung)
  resultsBody.querySelectorAll('input.num-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const row = STATE.rows.find(x => x.id === inp.dataset.id);
      if (!row) return;
      const decision = decideManualEntry(inp.value);
      row.digits = decision.digits;
      row.formatted = decision.formatted;
      row.status = decision.status;       // wird auto_ok/check/blocked
      row.reasons = decision.reasons;
      row.confidence = decision.confidence;
      row.country = decision.country;
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
      const newStatus = sel.value;
      // auto_ok kann der Mensch nicht "erzwingen" — wenn das Dropdown auto_ok zeigt
      // und der Code das nicht hergibt, hatten wir die Option disabled. Wenn der
      // User explizit 'manual_ok' wählt, vermerken wir das.
      row.status = newStatus;
      if (newStatus === 'manual_ok') {
        row.manualEdited = true;
        // Reasons leeren, da der Mensch entschieden hat
        row.reasons = ['Manuell freigegeben'];
      }
      renderRows();
      updateSummary();
      updateExportGates();
    });
  });

  // Thumbnails -> Lightbox
  resultsBody.querySelectorAll('img.thumb-zoom').forEach(img => {
    img.addEventListener('click', () => {
      const row = STATE.rows.find(x => x.id === img.dataset.id);
      if (!row) return;
      openLightbox(row.fullDataUrl || row.thumbDataUrl, row.fileName);
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
  mailBtn.disabled  = !hasRows;
}

// ---------- Lightbox ----------
function openLightbox(src, name) {
  lightboxImg.src = src;
  lightboxImg.alt = name || '';
  lightbox.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  lightbox.classList.remove('show');
  lightboxImg.src = '';
  document.body.style.overflow = '';
}
lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// ---------- Auswertung ----------
processBtn.addEventListener('click', async () => {
  refreshFileCount();
  if (!STATE.selectedFiles.length) { setStatus('Bitte Bilder auswählen.', 'err'); return; }
  processBtn.disabled = true; excelBtn.disabled = true; mailBtn.disabled = true;
  const files = STATE.selectedFiles;
  for (let i = 0; i < files.length; i++) {
    const row = await processOne(files[i], i, files.length);
    STATE.rows.push(row);
    renderRows();
  }
  const { ok, ck, bl } = updateSummary();
  setStatus(`<span class="ok">${ok} OK</span> · <span class="warn">${ck} bitte prüfen</span> · <span class="err">${bl} blockiert</span>`);
  processBtn.disabled = false;
  updateExportGates();
});

// ---------- Excel-Export (zuverlässiger Direkt-Download) ----------
function buildWorkbook() {
  const data = STATE.rows.map(r => ({
    Datum: r.datum,
    Wagennummer: r.formatted || r.digits || '',
    Standort: r.standort,
    Bilddatei: r.fileName,
    Status: STATUS_LABEL[r.status] || r.status,
    Land: r.country || '',
    'OCR-Confidence': r.confidence != null ? Math.round(r.confidence*100) + '%' : '',
    Hinweise: (r.reasons||[]).join(' · '),
    'Manuell bearbeitet': r.manualEdited ? 'Ja' : 'Nein'
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{wch:12},{wch:22},{wch:12},{wch:30},{wch:14},{wch:14},{wch:14},{wch:40},{wch:18}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wagennummern');
  return wb;
}

function triggerDownload() {
  const wb = buildWorkbook();
  const filename = `wagennummern_${standortEl.value}_${today()}.xlsx`;
  // SheetJS hat einen eingebauten Browser-Save, der iOS/Safari korrekt behandelt
  try {
    XLSX.writeFile(wb, filename, { compression: true });
    setStatus(`Excel-Datei „${filename}" gespeichert.`, 'ok');
  } catch (e) {
    // Fallback: Blob + temporären Link, der per Code geklickt wird
    const out = XLSX.write(wb, { bookType:'xlsx', type:'array', compression: true });
    const blob = new Blob([out], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    setStatus(`Excel-Datei „${filename}" wird heruntergeladen.`, 'ok');
  }
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

mailBtn.addEventListener('click', () => withBlockedGuard(() => {
  if (!STATE.emails.length) { setStatus('Bitte mindestens eine E-Mail-Adresse hinzufügen.', 'err'); return; }
  const to = STATE.emails.join(',');
  const subject = encodeURIComponent(`Wagennummern ${standortEl.value} ${today()}`);
  const lines = [
    `Standort: ${standortEl.value}`,
    `Datum: ${today()}`,
    '',
    'Datensätze:',
    ...STATE.rows.map(r => `${r.datum} | ${r.formatted || r.digits || 'NICHT ERKANNT'} | ${r.standort} | ${r.fileName} | ${STATUS_LABEL[r.status]||r.status}`),
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
  renderRows();
  refreshFileCount();
  updateExportGates();
  setStatus('Zurückgesetzt.', 'ok');
});

// ---------- Init ----------
loadPersist();
renderEmails();
renderRows();
refreshFileCount();
