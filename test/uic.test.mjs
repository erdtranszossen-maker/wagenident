// Unit-Tests für lib/uic.js — Node 20+ (ESM)
import {
  uicCheckDigit, isValidUicChecksum, formatUic,
  normalizeToDigits, findUicCandidates, validateUic, decideStatus, decideManualEntry, CFG
} from '../lib/uic.js';

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || ''}\n  erwartet: ${JSON.stringify(b)}\n  bekommen: ${JSON.stringify(a)}`);
  }
}
function truthy(v, msg) { if (!v) throw new Error(msg || 'erwartet truthy'); }
function falsy(v, msg) { if (v) throw new Error(msg || 'erwartet falsy'); }

// ---------- Prüfziffer: verifizierte Beispiele ----------
// Wikipedia DE: 31 81 665 0 286-0 -> Prüfziffer 9? Nein: Quelle gibt 0 an.
// "Wagennummer: 31 81 665 0 286-0" -- die letzte 0 nach dem Bindestrich ist die Prüfziffer.
// Die 11 Stellen sind "31816650286" -> erwartete Prüfziffer 0.
test('Prüfziffer DE-Beispiel 31816650286 -> 0', () => {
  eq(uicCheckDigit('31816650286'), 0);
});

// Wikipedia EN Beispiel 1: 2 1 8 1 2 4 7 1 2 1 7 -> 3
test('Prüfziffer EN-Beispiel 21812471217 -> 3', () => {
  eq(uicCheckDigit('21812471217'), 3);
});

// Wikipedia EN Beispiel 2: 5 1 8 0 0 8 4 3 0 0 1 -> 0
test('Prüfziffer EN-Beispiel 51800843001 -> 0', () => {
  eq(uicCheckDigit('51800843001'), 0);
});

// tramways.at Beispiel: 1 0 4 4 5 0 1 3 ... -> 3 (Lok-Schema, 8 Stellen, hier nicht 11)
// Stattdessen prüfen wir isValidUicChecksum mit den drei Beispielen:
test('isValidUicChecksum: korrekte 12-Stelligen', () => {
  truthy(isValidUicChecksum('318166502860'));
  truthy(isValidUicChecksum('218124712173'));
  truthy(isValidUicChecksum('518008430010'));
});

test('isValidUicChecksum: falsche Prüfziffer wird abgelehnt', () => {
  falsy(isValidUicChecksum('318166502861'));
  falsy(isValidUicChecksum('218124712174'));
});

test('Prüfziffer: Edge-Cases mit hohen Quersummen', () => {
  // 99999999999 -> jede Stelle 9, Multiplikatoren 2,1,2,1,... -> Produkte 18,9,18,9,18,9,18,9,18,9,18
  // Quersummen: 9,9,9,9,9,9,9,9,9,9,9 = 99 -> nextTen=100 -> 1
  eq(uicCheckDigit('99999999999'), 1);
  // 00000000000 -> Summe 0 -> nextTen=0 -> 0
  eq(uicCheckDigit('00000000000'), 0);
});

test('uicCheckDigit wirft bei falscher Länge', () => {
  let threw = false;
  try { uicCheckDigit('123'); } catch { threw = true; }
  truthy(threw);
});

// ---------- formatUic ----------
test('formatUic: korrekte Formatierung', () => {
  eq(formatUic('318166502860'), '31 81 6650 286-0');
  eq(formatUic('518008430010'), '51 80 0843 001-0');
});

test('formatUic: bei ungültiger Länge gibt Input zurück', () => {
  eq(formatUic('123'), '123');
});

// ---------- normalizeToDigits ----------
test('normalizeToDigits: bereits sauber', () => {
  eq(normalizeToDigits('31 81 6650 286-0'), '318166502860');
  eq(normalizeToDigits('318166502860'), '318166502860');
});

test('normalizeToDigits: OCR-typische Verwechslungen', () => {
  eq(normalizeToDigits('3I 8I 665O 286-O'), '318166502860'); // I->1, O->0
  eq(normalizeToDigits('5l 8O O843 OOl-O'), '518008430010'); // l->1, O->0
});

test('normalizeToDigits: zu kurz -> null', () => {
  eq(normalizeToDigits('1234'), null);
  eq(normalizeToDigits(''), null);
  eq(normalizeToDigits(null), null);
});

test('normalizeToDigits: zu lang -> bevorzugt Whitelist-Länder', () => {
  // 13 Ziffern, die zweite 12er-Folge beginnt mit DE-Code 80? Test mit Pufferziffer vorn
  // "9318166502860" -> erste 12 = "931816650286" (Land 18 nicht in Whitelist),
  // zweite 12 = "318166502860" (Land 81 in Whitelist) -> sollte diese liefern
  eq(normalizeToDigits('9318166502860'), '318166502860');
});

// ---------- findUicCandidates ----------
test('findUicCandidates: Einzeltext mit einer Nummer', () => {
  const r = findUicCandidates('Wagen 31 81 6650 286-0 unterwegs');
  eq(r, ['318166502860']);
});

test('findUicCandidates: mehrere Zeilen, mehrere Nummern', () => {
  const r = findUicCandidates('31 81 6650 286-0\nfoo\n51 80 0843 001-0');
  eq(r, ['318166502860', '518008430010']);
});

test('findUicCandidates: ohne Trennzeichen', () => {
  const r = findUicCandidates('318166502860');
  truthy(r.includes('318166502860'));
});

test('findUicCandidates: mit OCR-Buchstaben in einer Zeile', () => {
  const r = findUicCandidates('3I 8I 665O 286-O');
  truthy(r.includes('318166502860'));
});

test('findUicCandidates: leerer Text -> []', () => {
  eq(findUicCandidates(''), []);
  eq(findUicCandidates(null), []);
});

// ---------- validateUic ----------
test('validateUic: DE gültig', () => {
  const v = validateUic('318166502860');
  truthy(v.valid);
  eq(v.country, 'Österreich'); // 81 = AT
  eq(v.reasons, []);
});

test('validateUic: erlaubte Länder ok (518008430010 -> Stellen 3-4 = 80 = DE)', () => {
  const v = validateUic('518008430010');
  truthy(v.valid);
  eq(v.country, 'Deutschland');
});

test('validateUic: Polen-Beispiel (Stellen 3-4 = 51)', () => {
  // Konstruiere XX 51 XXXX XXX-C: 11 Stellen, Prüfziffer berechnen
  const eleven = '33510123456';
  const cd = uicCheckDigit(eleven);
  const v = validateUic(eleven + cd);
  truthy(v.valid);
  eq(v.country, 'Polen');
});

test('validateUic: Länderschlüssel außerhalb Whitelist', () => {
  // Stellen 3-4 = 70 (nicht in Whitelist)
  // Format: XX 70 XXXX XXX-C
  const eleven = '12701234567';
  const cd = uicCheckDigit(eleven);
  const v = validateUic(eleven + cd);
  falsy(v.valid);
  truthy(v.reasons.some(r => r.includes('70')));
});

test('validateUic: Prüfziffer falsch', () => {
  const v = validateUic('318166502861');
  falsy(v.valid);
  truthy(v.reasons.includes('Prüfziffer falsch'));
});

// ---------- decideStatus ----------
test('decideStatus: hohe Confidence + gültig -> auto_ok', () => {
  const r = decideStatus([{ digits: '318166502860', confidence: 0.97 }]);
  eq(r.status, 'auto_ok');
  eq(r.formatted, '31 81 6650 286-0');
  eq(r.country, 'Österreich');
});

test('decideStatus: mittlere Confidence + gültig -> check', () => {
  const r = decideStatus([{ digits: '318166502860', confidence: 0.85 }]);
  eq(r.status, 'check');
  truthy(r.reasons.length > 0);
});

test('decideStatus: niedrige Confidence -> blocked', () => {
  const r = decideStatus([{ digits: '318166502860', confidence: 0.50 }]);
  eq(r.status, 'blocked');
});

test('decideStatus: Prüfziffer falsch -> blocked auch bei hoher Confidence', () => {
  const r = decideStatus([{ digits: '318166502861', confidence: 0.99 }]);
  eq(r.status, 'blocked');
  truthy(r.reasons.includes('Prüfziffer falsch'));
});

test('decideStatus: Mehrdeutigkeit -> nicht auto_ok', () => {
  const r = decideStatus([
    { digits: '318166502860', confidence: 0.93 },
    { digits: '518008430010', confidence: 0.91 }
  ]);
  // gap = 0.02 < 0.05 -> reason "Mehrere ähnlich starke Kandidaten" -> status check (weil valid)
  eq(r.status, 'check');
  truthy(r.reasons.some(x => x.includes('ähnlich')));
});

test('decideStatus: keine Kandidaten -> blocked', () => {
  const r = decideStatus([]);
  eq(r.status, 'blocked');
});

// ---------- decideManualEntry ----------
test('decideManualEntry: gültige Eingabe formatiert -> auto_ok', () => {
  const r = decideManualEntry('31 81 6650 286-0');
  eq(r.status, 'auto_ok');
});

test('decideManualEntry: ungültige Prüfziffer -> blocked', () => {
  const r = decideManualEntry('31 81 6650 286-1');
  eq(r.status, 'blocked');
});

test('decideManualEntry: zu kurz -> blocked', () => {
  const r = decideManualEntry('123');
  eq(r.status, 'blocked');
});

// ---------- Realistische OCR-Szenarien ----------
test('Szenario: Vision-Text mit Rauschen', () => {
  const txt = 'DB Cargo\n31 81 6650 286-0\nMax. 22,5 t\nLänge ü.P. 14,04 m';
  const cands = findUicCandidates(txt);
  truthy(cands.includes('318166502860'));
  const r = decideStatus(cands.map(d => ({ digits: d, confidence: 0.95 })));
  eq(r.status, 'auto_ok');
});

test('Szenario: zwei Wagen auf einem Bild -> Mehrdeutigkeit', () => {
  const txt = '31 81 6650 286-0\n51 80 0843 001-0';
  const cands = findUicCandidates(txt);
  eq(cands.length, 2);
  // beide mit hoher Confidence -> Mehrdeutigkeit
  const r = decideStatus([
    { digits: cands[0], confidence: 0.95 },
    { digits: cands[1], confidence: 0.93 }
  ]);
  eq(r.status, 'check');
});

// ---------- Test-Runner ----------
console.log(`\nFühre ${tests.length} Tests aus...\n`);
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}`);
    console.log(`      ${e.message}`);
  }
}
console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
