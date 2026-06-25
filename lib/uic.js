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
  '80': 'Deutschland',
  '86': 'Dänemark',
  '51': 'Polen',
  '54': 'Tschechien',
  '81': 'Österreich',
  '85': 'Schweiz',
  '87': 'Frankreich',
  '82': 'Luxemburg',
  '88': 'Belgien',
  '84': 'Niederlande',
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
  'g': '9', 'q': '9',
};

const DIGIT_SUBSTITUTIONS_RE = new RegExp('[' + Object.keys(DIGIT_SUBSTITUTIONS).join('') + ']', 'g');

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
  const substituted = raw.split('').map(ch => DIGIT_SUBSTITUTIONS[ch] ?? ch).join('');
  const digits = substituted.replace(/\D/g, '');
  if (digits.length === 12) return digits;
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
 * Sucht zeilenweise und zusätzlich über mehrere Zeilen hinweg nach 12-stelligen Mustern.
 * @param {string} text
 * @returns {string[]} Liste von 12-stelligen Ziffernfolgen (dedupliziert, Reihenfolge erhalten)
 */
export function findUicCandidates(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);

  // Regex für UIC-Form mit beliebigen Trennern (Leerzeichen, Bindestrich, kein Trenner)
  const re = /(?<!\d)(\d[\d \-]{10,17}\d)(?!\d)/g;

  // 1. Zeilenweise suchen
  for (const line of lines) {
    const sub = line.replace(DIGIT_SUBSTITUTIONS_RE, ch => DIGIT_SUBSTITUTIONS[ch] ?? ch);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(sub)) !== null) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length === 12 && !seen.has(digits)) {
        seen.add(digits);
        found.push(digits);
      }
    }
  }

  // 2. Mehrzeiliger Merge: Ziffern aus 2–4 aufeinanderfolgenden Zeilen verketten
  for (let window = 2; window <= 4; window++) {
    for (let i = 0; i <= lines.length - window; i++) {
      const mergedDigits = lines
        .slice(i, i + window)
        .map(l => l.replace(/[^0-9]/g, ''))
        .join('');
      if (mergedDigits.length < 12) continue;

      for (let j = 0; j <= mergedDigits.length - 12; j++) {
        const cand = mergedDigits.slice(j, j + 12);
        if (!CFG.ALLOWED_COUNTRY_CODES.includes(cand.slice(2, 4))) continue;
        if (!seen.has(cand)) {
          seen.add(cand);
          found.push(cand);
        }
      }
    }
  }

  return found;
}

/**
 * Validiert eine UIC und liefert Metadaten + Gründe zurück.
 */
export function validateUic(twelveDigits) {
  const reasons = [];
  if (!/^\d{12}$/.test(twelveDigits)) {
    reasons.push('Keine 12-stellige Ziffernfolge');
  }
  const countryCode = twelveDigits.slice(2, 4);
  let country = null;
  if (!CFG.ALLOWED_COUNTRY_CODES.includes(countryCode)) {
    reasons.push(`Ländercode ${countryCode} nicht erlaubt`);
  } else {
    country = COUNTRY_NAMES[countryCode] || null;
  }
  if (!isValidUicChecksum(twelveDigits)) {
    reasons.push('Prüfziffer falsch');
  }
  return { valid: reasons.length === 0, country, reasons };
}

/**
 * Entscheidet Status anhand von Kandidaten aus OCR (digits + confidence).
 * @param {{digits:string, confidence:number}[]} candidates
 */
export function decideStatus(candidates) {
  if (!candidates || !candidates.length) {
    return {
      status: 'blocked',
      digits: null,
      formatted: null,
      reasons: ['Keine Nummer im Bild erkannt'],
      country: null,
      confidence: null,
    };
  }

  // Erst nach Gültigkeit sortieren, dann nach Confidence.
  // Hintergrund: Durch den Mehrzeilen-Merge entstehen oft zusätzliche 12er-Folgen
  // ohne gültige Prüfziffer. Eine echte gültige UIC darf dadurch nicht entwertet werden.
  const annotated = candidates.map(c => ({ ...c, _v: validateUic(c.digits) }));
  const sorted = annotated.sort((a, b) => {
    if (a._v.valid !== b._v.valid) return a._v.valid ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  const top = sorted[0];
  const v = top._v;
  const reasons = [...v.reasons];

  // Mehrdeutigkeit nur zählen, wenn der zweite Kandidat *ebenfalls gültig* ist
  // und seine Confidence dicht an der des Top-Kandidaten liegt.
  const secondValid = sorted.find(s => s !== top && s._v.valid && s.digits !== top.digits);
  if (
    v.valid && secondValid &&
    (top.confidence ?? 0) - (secondValid.confidence ?? 0) < CFG.MIN_AMBIGUITY_GAP
  ) {
    reasons.push('Mehrere ähnlich starke Kandidaten');
  }

  if (!v.valid) {
    return {
      status: 'blocked',
      digits: top.digits,
      formatted: top.digits.length === 12 ? formatUic(top.digits) : top.digits,
      reasons,
      country: v.country,
      confidence: top.confidence,
    };
  }

  if (top.confidence >= CFG.MIN_CONFIDENCE_AUTO && !reasons.length) {
    return {
      status: 'auto_ok',
      digits: top.digits,
      formatted: formatUic(top.digits),
      reasons: [],
      country: v.country,
      confidence: top.confidence,
    };
  }

  if (top.confidence >= CFG.MIN_CONFIDENCE_CHECK) {
    if (!reasons.length) {
      reasons.push(`OCR-Confidence ${(top.confidence * 100).toFixed(0)}% < ${(CFG.MIN_CONFIDENCE_AUTO * 100).toFixed(0)}%`);
    }
    return {
      status: 'check',
      digits: top.digits,
      formatted: formatUic(top.digits),
      reasons,
      country: v.country,
      confidence: top.confidence,
    };
  }

  reasons.push(`OCR-Confidence ${(top.confidence * 100).toFixed(0)}% zu niedrig`);
  return {
    status: 'blocked',
    digits: top.digits,
    formatted: formatUic(top.digits),
    reasons,
    country: v.country,
    confidence: top.confidence,
  };
}

/**
 * Convenience: Validiert eine manuell eingegebene Nummer (Freitext)
 * und gibt Statusentscheidung zurück, als wäre sie mit Confidence 1.0
 */
export function decideManualEntry(rawInput) {
  const digits = normalizeToDigits(rawInput);
  if (!digits) {
    return {
      status: 'blocked',
      digits: null,
      formatted: null,
      reasons: ['Eingabe enthält keine 12 Ziffern'],
      country: null,
      confidence: null,
    };
  }
  return decideStatus([{ digits, confidence: 1.0 }]);
}
