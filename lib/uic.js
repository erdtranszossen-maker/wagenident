// uic.js — UIC-Wagennummer: Normalisierung, Prüfziffer, Validierung, Statusentscheidung
// Reines ES-Modul, ohne Abhängigkeiten. Läuft im Browser und in Node.
// ---------------------------------------------------------------------------

export const CFG = {
  // Erlaubte UIC-Ländercodes (Stellen 3-4)
  // DE 80, DK 86, PL 51, CZ 54, AT 81, CH 85, FR 87, LU 82, BE 88, NL 84
  ALLOWED_COUNTRY_CODES: ['80', '86', '51', '54', '81', '85', '87', '82', '88', '84'],
  MIN_CONFIDENCE_AUTO: 0.90,
  MIN_CONFIDENCE_CHECK: 0.80,
  // Mindestabstand zum nächstbesten Kandidaten, damit Auto-OK möglich ist
  MIN_AMBIGUITY_GAP: 0.05,
};

const COUNTRY_NAMES = {
  '80': 'Deutschland', '86': 'Dänemark', '51': 'Polen', '54': 'Tschechien',
  '81': 'Österreich', '85': 'Schweiz',   '87': 'Frankreich', '82': 'Luxemburg',
  '88': 'Belgien',    '84': 'Niederlande'
};

// Häufige OCR-Verwechslungen, nur für Zeichen, die an Ziffernpositionen
// stehen sollen. Wird NICHT global auf den gesamten Text angewendet.
const DIGIT_SUBSTITUTIONS = {
  'O': '0', 'o': '0', 'D': '0', 'Q': '0',
  'I': '1', 'l': '1', '|': '1', '!': '1',
  'Z': '2', 'z': '2',
  'E': '3',
  'A': '4',
  'S': '5', 's': '5',
  'G': '6', 'b': '6',
  'T': '7',
  'B': '8',
  'g': '9', 'q': '9'
};

/**
 * Berechnet die UIC-Selbstkontrollziffer (Luhn-mod-10 mit Wechselgewichten 2,1,...,2)
 * für die ersten 11 Stellen.
 * @param {string} elevenDigits - genau 11 Ziffern als String
 * @returns {number} 0-9
 */
export function uicCheckDigit(elevenDigits) {
  if (!/^\d{11}$/.test(elevenDigits)) {
    throw new Error('uicCheckDigit erwartet genau 11 Ziffern');
  }
  // Multiplikatoren: Position 1 (links) bekommt *2, Position 2 *1, usw.
  // Das ist äquivalent zu "von rechts mit 2,1,2,1,..." weil die Prüfziffer
  // selbst (Position 12) mit *2 multipliziert würde — wir berechnen sie aber.
  // Für 11 Stellen ergibt sich Muster [2,1,2,1,2,1,2,1,2,1,2].
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = Number(elevenDigits[i]);
    const m = (i % 2 === 0) ? 2 : 1;
    const product = d * m;
    // Quersumme des Produkts (z.B. 16 -> 1+6 = 7)
    sum += (product >= 10) ? (Math.floor(product / 10) + (product % 10)) : product;
  }
  const nextTen = Math.ceil(sum / 10) * 10;
  return nextTen - sum;
}

/**
 * Prüft, ob 12-stellige Nummer eine gültige UIC-Prüfziffer hat.
 */
export function isValidUicChecksum(twelveDigits) {
  if (!/^\d{12}$/.test(twelveDigits)) return false;
  const expected = uicCheckDigit(twelveDigits.slice(0, 11));
  return expected === Number(twelveDigits[11]);
}

/**
 * Formatiert 12 Ziffern als "XX XX XXXX XXX-X".
 */
export function formatUic(twelveDigits) {
  if (!/^\d{12}$/.test(twelveDigits)) return twelveDigits;
  return `${twelveDigits.slice(0,2)} ${twelveDigits.slice(2,4)} ${twelveDigits.slice(4,8)} ${twelveDigits.slice(8,11)}-${twelveDigits.slice(11)}`;
}

/**
 * Maskenbasierte Normalisierung: nimmt einen Rohstring (z.B. "31 81 6650 286-O")
 * und versucht, ihn in eine 12-stellige Ziffernfolge zu überführen.
 * Substitutionen werden nur auf Zeichen angewendet, die im Buchstaben-Mapping liegen.
 * Trennzeichen werden entfernt.
 * @param {string} raw
 * @returns {string|null} 12-stellige Ziffernfolge oder null
 */
export function normalizeToDigits(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Substitutionen Buchstabe -> Ziffer
  const substituted = raw.split('').map(ch => DIGIT_SUBSTITUTIONS[ch] ?? ch).join('');
  // Nur Ziffern behalten
  const digits = substituted.replace(/\D/g, '');
  if (digits.length === 12) return digits;
  // Versuche, eine 12er-Folge innerhalb längerer Folgen zu finden
  if (digits.length > 12) {
    // bevorzuge die erste 12er-Folge, die mit erlaubtem Länderschlüssel beginnt
    for (let i = 0; i <= digits.length - 12; i++) {
      const cand = digits.slice(i, i + 12);
      if (CFG.ALLOWED_COUNTRY_CODES.includes(cand.slice(2, 4))) return cand;
    }
    return digits.slice(0, 12);
  }
  return null;
}

/**
 * Extrahiert UIC-Kandidaten aus Freitext (z.B. Vision full text).
 * Sucht zeilenweise nach 12-stelligen Mustern mit/ohne Trennzeichen.
 * @param {string} text
 * @returns {string[]} Liste von 12-stelligen Ziffernfolgen (dedupliziert, Reihenfolge erhalten)
 */
export function findUicCandidates(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  // Regex für UIC-Form mit beliebigen Trennern (Leerzeichen, Bindestrich, kein Trenner)
  const re = /(?<![\d])(\d{2})[\s\-–—]*(\d{2})[\s\-–—]*(\d{4})[\s\-–—]*(\d{3})[\s\-–—]*(\d)(?![\d])/g;
  for (const line of lines) {
    // 1) Direkt strenge Form
    let m;
    while ((m = re.exec(line)) !== null) {
      const d = m[1] + m[2] + m[3] + m[4] + m[5];
      if (!seen.has(d)) { seen.add(d); found.push(d); }
    }
    // 2) Maskenbasierte Normalisierung pro Zeile (falls OCR Buchstaben einsetzte)
    const norm = normalizeToDigits(line);
    if (norm && !seen.has(norm)) { seen.add(norm); found.push(norm); }
  }
  // 3) Fallback: gesamte Vorlage normalisieren
  if (!found.length) {
    const norm = normalizeToDigits(text);
    if (norm) found.push(norm);
  }
  return found;
}

/**
 * Vollständige Validierung einer 12-stelligen UIC-Nummer.
 * @returns {{valid:boolean, reasons:string[], country:string|null}}
 */
export function validateUic(twelveDigits) {
  const reasons = [];
  if (!/^\d{12}$/.test(twelveDigits)) {
    return { valid: false, reasons: ['Nicht 12 Stellen'], country: null };
  }
  const country = twelveDigits.slice(2, 4);
  const countryOk = CFG.ALLOWED_COUNTRY_CODES.includes(country);
  if (!countryOk) reasons.push(`Länderschlüssel ${country} nicht in Whitelist`);
  const checksumOk = isValidUicChecksum(twelveDigits);
  if (!checksumOk) reasons.push('Prüfziffer falsch');
  return {
    valid: countryOk && checksumOk,
    reasons,
    country: COUNTRY_NAMES[country] || null
  };
}

/**
 * Trifft die finale Statusentscheidung aus einer Kandidatenliste + Confidence.
 * @param {Array<{digits:string, confidence:number}>} candidates - sortiert nach Confidence absteigend
 * @returns {{status:'auto_ok'|'check'|'blocked', digits:string|null, formatted:string|null, reasons:string[], country:string|null, confidence:number|null}}
 */
export function decideStatus(candidates) {
  if (!candidates || !candidates.length) {
    return { status: 'blocked', digits: null, formatted: null,
             reasons: ['Keine Nummer im Bild erkannt'], country: null, confidence: null };
  }

  // Sortiere defensiv
  const sorted = [...candidates].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const top = sorted[0];
  const second = sorted[1];

  const v = validateUic(top.digits);
  const reasons = [...v.reasons];

  // Mehrdeutigkeit: zweiter Kandidat zu nah dran?
  if (second && (top.confidence - second.confidence) < CFG.MIN_AMBIGUITY_GAP
              && second.digits !== top.digits) {
    reasons.push('Mehrere ähnlich starke Kandidaten');
  }

  if (!v.valid) {
    return {
      status: 'blocked',
      digits: top.digits,
      formatted: top.digits.length === 12 ? formatUic(top.digits) : top.digits,
      reasons,
      country: v.country,
      confidence: top.confidence
    };
  }

  // valid: jetzt Confidence-Stufen
  if (top.confidence >= CFG.MIN_CONFIDENCE_AUTO && !reasons.length) {
    return {
      status: 'auto_ok',
      digits: top.digits,
      formatted: formatUic(top.digits),
      reasons: [],
      country: v.country,
      confidence: top.confidence
    };
  }
  if (top.confidence >= CFG.MIN_CONFIDENCE_CHECK) {
    if (!reasons.length) reasons.push(`OCR-Confidence ${(top.confidence*100).toFixed(0)}% < ${(CFG.MIN_CONFIDENCE_AUTO*100).toFixed(0)}%`);
    return {
      status: 'check',
      digits: top.digits,
      formatted: formatUic(top.digits),
      reasons,
      country: v.country,
      confidence: top.confidence
    };
  }
  reasons.push(`OCR-Confidence ${(top.confidence*100).toFixed(0)}% zu niedrig`);
  return {
    status: 'blocked',
    digits: top.digits,
    formatted: formatUic(top.digits),
    reasons,
    country: v.country,
    confidence: top.confidence
  };
}

/**
 * Convenience: Validiert eine manuell eingegebene Nummer (Freitext)
 * und gibt Statusentscheidung zurück, als wäre sie mit Confidence 1.0 erkannt worden.
 */
export function decideManualEntry(rawInput) {
  const digits = normalizeToDigits(rawInput);
  if (!digits) {
    return { status: 'blocked', digits: null, formatted: null,
             reasons: ['Eingabe enthält keine 12 Ziffern'], country: null, confidence: null };
  }
  return decideStatus([{ digits, confidence: 1.0 }]);
}
