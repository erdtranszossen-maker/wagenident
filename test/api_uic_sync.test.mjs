// Sichert ab, dass api/_uic.js und lib/uic.js dieselbe Logik haben.
// Hintergrund: Der Bug "Multi-Line-UIC wird nicht erkannt" entstand, weil
// die Verbesserung im Frontend (lib/uic.js) gemacht wurde, aber das Backend
// (api/_uic.js) weiter die alte zeilenweise Version benutzt hat.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import * as lib from '../lib/uic.js';
import * as api from '../api/_uic.js';

test('lib/uic.js und api/_uic.js exportieren dieselben Funktionsnamen', () => {
  const libExports = Object.keys(lib).sort();
  const apiExports = Object.keys(api).sort();
  assert.deepEqual(apiExports, libExports);
});

test('api/_uic.js findet Multi-Line UIC (Column-Merge)', () => {
  // Original-Bug-Case vom User: AT-Wagen mit UIC über 3 Zeilen
  const text = '31 RIV MC\n81 PL-BRX\n6650 286-0';
  const cands = api.findUicCandidates(text);
  assert.ok(cands.length > 0, 'Es muss mindestens ein Kandidat gefunden werden');
  const valid = cands.find(c => api.validateUic(c).valid);
  assert.ok(valid, `Mindestens ein Kandidat muss eine gültige Prüfziffer haben. Kandidaten: ${cands.join(', ')}`);
  assert.equal(valid, '318166502860');
});

test('lib und api liefern für denselben Input identische Kandidaten', () => {
  const samples = [
    '31 RIV MC\n81 PL-BRX\n6650 286-0',
    '80 D-DB\n3215 123-4 56',
    '31 81 6650 286-0',
    '54 RIV CD\n54 CZ-CD\n2161 123-4',
    'Garbage\nText\nWithout numbers',
  ];
  for (const text of samples) {
    const libCands = lib.findUicCandidates(text);
    const apiCands = api.findUicCandidates(text);
    assert.deepEqual(apiCands, libCands, `Unterschied bei: ${JSON.stringify(text)}`);
  }
});

test('lib und api: decideStatus identisches Verhalten', () => {
  const cases = [
    [{ digits: '318166502860', confidence: 0.95 }],
    [{ digits: '123456789012', confidence: 0.95 }],
    [],
  ];
  for (const c of cases) {
    const a = lib.decideStatus(c);
    const b = api.decideStatus(c);
    assert.equal(b.status, a.status, `Status unterschiedlich für ${JSON.stringify(c)}`);
    assert.equal(b.digits, a.digits);
  }
});
