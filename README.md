# Wagenident — UIC-Wagennummern erkennen

Schlanke HTML-App, die Fotos von Güterwagen über Google Cloud Vision auswertet
und 12-stellige UIC-Wagennummern liest. Auto-OK nur bei eindeutigem Treffer
(Format, Prüfziffer, Länder-Whitelist, hohe OCR-Confidence) — sonst manuelle Prüfung.

## Architektur

```
┌────────────────────┐  POST /api/ocr   ┌─────────────────────┐   Vision API   ┌──────────────────┐
│ Statisches HTML/JS │ ───── image ───► │ Vercel Serverless   │ ─────────────► │ Google Vision    │
│ public/            │ ◄──── JSON ───── │ api/ocr.js          │ ◄──── JSON ──── │ DOCUMENT_TEXT    │
└────────────────────┘                  └─────────────────────┘                └──────────────────┘
```

## Projektstruktur

```
wagenident/
  public/
    index.html       — UI
    app.js           — Frontend-Logik
    lib/uic.js       — UIC-Logik (Browser-Kopie)
  api/
    ocr.js           — Serverless Function
    _uic.js          — UIC-Logik (Function-Kopie)
  lib/
    uic.js           — Master der UIC-Logik (Quelle der Wahrheit für Tests)
  test/
    uic.test.mjs     — 34 Unit-Tests zur UIC-Logik
    ocr.test.mjs     —  9 Unit-Tests zur Function (mockt Vision)
  dev-server.mjs     — lokaler Dev-Server mit Vision-Mock
  vercel.json        — Deployment-Konfiguration
  package.json
```

## Lokal testen

```bash
# Tests
node test/uic.test.mjs
node test/ocr.test.mjs

# Dev-Server mit Vision-Mock (liefert immer "31 81 6650 286-0" zurück)
node dev-server.mjs
# Browser öffnen: http://localhost:3000
```

Wenn `GOOGLE_VISION_API_KEY` als ENV gesetzt ist, ruft der Dev-Server die echte API.

## Deployment auf Vercel

### 1. Google Vision API-Key besorgen (einmalig, ~5 Minuten)

1. Auf https://console.cloud.google.com/ einloggen (kostenloses Google-Konto reicht).
2. Oben links neues Projekt anlegen, z. B. `wagenident-prod`.
3. Im Menü **APIs & Services → Library** → "Cloud Vision API" suchen → **Aktivieren**.
4. **APIs & Services → Credentials** → **+ CREATE CREDENTIALS → API key**.
5. Den Key sofort einschränken: **RESTRICT KEY → API restrictions → Cloud Vision API**.
6. Key kopieren (Format: `AIzaSy…`).

**Kosten:** Vision OCR ist die ersten 1000 Aufrufe/Monat kostenlos, danach 1,50 USD pro 1000.
Für realistische Nutzung (ein paar hundert Bilder/Monat) bleibt es im Free-Tier.
Eine Rechnungsadresse ist nötig, damit der Key arbeitet — es entstehen aber keine
laufenden Gebühren, solange ihr unter dem Free-Tier bleibt.

### 2. Vercel-Account anlegen (kostenlos, einmalig)

1. https://vercel.com/signup → mit GitHub-, GitLab- oder E-Mail-Account.
2. Hobby-Plan reicht: 100 GB Bandwidth/Monat, 100k Function-Aufrufe/Monat — alles kostenlos.

### 3. Projekt deployen

**Variante A — über Vercel CLI (einfachster Weg ohne Git):**

```bash
npm i -g vercel
cd wagenident
vercel login          # mit E-Mail bestätigen
vercel                # erstes Mal: ein paar Fragen, alle Defaults bestätigen
```

Beim ersten Deploy fragt Vercel: "Want to override settings?" → **N** (Defaults).
Nach ~30 Sekunden erscheint eine URL `https://wagenident-xxx.vercel.app`.

**Variante B — über GitHub-Repo:**

1. Projekt auf GitHub pushen.
2. Auf vercel.com → "Add New Project" → Repo wählen → Deploy.

### 4. ENV-Variable setzen

```bash
vercel env add GOOGLE_VISION_API_KEY production
# Key einfügen, Enter
vercel --prod         # Production-Deploy mit ENV
```

Alternativ im Vercel-Dashboard: **Project → Settings → Environment Variables**.

### 5. Domain (optional)

Vercel liefert eine kostenlose `wagenident-xxx.vercel.app`-URL.
Eigene Domain kann unter **Project → Settings → Domains** angebunden werden.

## Bedienung

1. **Standort** wählen (Zossen oder Trebbin).
2. **E-Mail-Adressen** hinzufügen (Verteiler ist persistent über LocalStorage).
3. **Bilder auswählen** (Galerie) oder **Kamera** (mobil) — Mehrfachauswahl möglich.
4. **Bilder auswerten** klicken. Status pro Bild:
   - **Auto-OK** (grün): 12-stellig, Prüfziffer korrekt, Länderschlüssel in Whitelist, OCR-Confidence ≥ 90%.
   - **Bitte prüfen** (gelb): gültig, aber Confidence 80-90% oder mehrere ähnlich starke Kandidaten.
   - **Blockiert** (rot): nicht eindeutig — manuelle Eingabe nötig.
5. Bei "Bitte prüfen"/"Blockiert": Wagennummer im Eingabefeld korrigieren → Status wird neu berechnet.
6. **Excel herunterladen** oder **Mail vorbereiten**.
   - Wenn noch blockierte Zeilen offen sind, erscheint ein Bestätigungsdialog (Override).

## Erlaubte Länderschlüssel

| Code | Land |
|------|------|
| 80 | Deutschland |
| 86 | Dänemark |
| 51 | Polen |
| 54 | Tschechien |
| 81 | Österreich |
| 85 | Schweiz |
| 87 | Frankreich |
| 82 | Luxemburg |
| 88 | Belgien |
| 84 | Niederlande |

Anpassbar in `lib/uic.js` → `CFG.ALLOWED_COUNTRY_CODES` (und nach Änderung `cp lib/uic.js public/lib/uic.js && cp lib/uic.js api/_uic.js`).

## Qualitätsanker

- **34 Unit-Tests** auf UIC-Prüfziffer, Normalisierung, Whitelist, Statusentscheidung
- **9 Tests** auf die Serverless Function (Fehlerfälle, Mock-Vision)
- Verifiziert gegen die offiziellen Wikipedia-Beispiele
  (31 81 6650 286-0, 21 81 2471 217-3, 51 80 0843 001-0).

## Datenschutz

- Bilder werden serverseitig **nicht gespeichert** — nur an Vision durchgereicht und nach der Antwort verworfen.
- Logs enthalten weder Bildinhalte noch OCR-Text.
- Excel-Datei wird im Browser erzeugt (SheetJS), kein Server-Upload.
