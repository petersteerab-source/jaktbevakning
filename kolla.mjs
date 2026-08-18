// Bevakar återbudsplatser hos Stockholms Jaktgårdar (jaktgård.se).
// Sidan renderas med JavaScript (EduAdmin-widget), därför Playwright och inte enkel HTTP-hämtning.
//
// Körs normalt utan argument. Sätt FIXTURE=fil.json för att testa logiken
// mot sparad data utan att starta webbläsare.

import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';

// Städa bort larmfiler från en tidigare körning så att workflowet aldrig
// skickar om ett gammalt larm. Misslyckad radering får inte stoppa körningen.
for (const f of ['larm-rubrik.txt', 'larm-text.md']) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* skrivskyddat filsystem — workflowet checkar ändå ut rent varje körning */
  }
}

const URL = 'https://www.xn--jaktgrd-ixa.se/alla';
const RAD = '.eduadmin-md-div-table-row';
const CELL = '.eduadmin-md-div-table-cell';
const STATE_FIL = 'state.json';

const bevakningar = JSON.parse(readFileSync('bevakningar.json', 'utf8'));
const tidigare = existsSync(STATE_FIL) ? JSON.parse(readFileSync(STATE_FIL, 'utf8')) : {};
const idag = new Date().toISOString().slice(0, 10);

// ---------- Hämta tabellen ----------

async function hämtaRader() {
  if (process.env.FIXTURE) {
    return JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'sv-SE' });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Bokningssystemet laddas asynkront. Vänta tills tabellen faktiskt har innehåll.
    await page.waitForFunction(
      sel => document.querySelectorAll(sel).length > 5,
      RAD,
      { timeout: 60_000 }
    );

    return await page.$$eval(
      RAD,
      (els, cell) =>
        els
          .map(el =>
            [...el.querySelectorAll(cell)]
              .map(c => c.innerText.trim().replace(/\s+/g, ' '))
              .filter(Boolean)
          )
          .filter(r => r.length > 3),
      CELL
    );
  } finally {
    await browser.close();
  }
}

const rader = await hämtaRader();

if (rader.length < 5) {
  console.error(`Fick bara ${rader.length} rader — sidan laddade troligen inte klart. Avbryter utan att skriva state.`);
  process.exit(1);
}

// ---------- Tolka raderna ----------

// Cellordning på sajten: [kurs, ort, "datum tid", platser, pris, knapptext]
// Datumcellen kan vara flerdagars: "2026-08-29 09:00 - 2026-08-30 17:00".
// Vi tar FÖRSTA datumet = startdatum, annars matchar en flerdagarskurs fel dag.
const parsade = rader.map(c => {
  const datumCell = c[2] || '';
  const datum = (datumCell.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1] || null;
  const tid = datumCell.replace(/\b20\d{2}-\d{2}-\d{2}\s*/g, '').trim();
  const platser = c.find(x => /plats(er)? kvar/i.test(x)) || '';
  const knapp = (c[c.length - 1] || '').trim();
  return { kurs: c[0] || '', ort: c[1] || '', datum, tid, platser, knapp };
});

// ---------- Jämför mot bevakningslistan ----------

const larm = [];
const nyState = {};

for (const b of bevakningar) {
  const nyckel = `${b.datum}|${b.namn}|${b.ort}`;

  if (b.datum < idag) {
    console.log(`⏭  ${nyckel} — datumet har passerat, hoppar över.`);
    continue;
  }

  const rad = parsade.find(
    r =>
      r.datum === b.datum &&
      r.kurs.toLowerCase().includes(b.namn.toLowerCase()) &&
      r.ort.toLowerCase().includes(b.ort.toLowerCase())
  );

  if (!rad) {
    console.log(`❓ ${nyckel} — hittades inte i listan.`);
    nyState[nyckel] = 'saknas';
    continue;
  }

  // Ledig = platser finns kvar OCH knappen går faktiskt att trycka på.
  // "Anmälan öppnas 2026-09-01" räknas inte som ledig.
  const harPlatser = !/inga platser kvar/i.test(rad.platser);
  const gårAttBoka = /^boka$/i.test(rad.knapp);
  const ledig = harPlatser && gårAttBoka;

  nyState[nyckel] = ledig ? 'ledig' : 'full';

  const föregående = tidigare[nyckel];
  console.log(
    `${ledig ? '✅' : '⛔'} ${nyckel} — ${rad.platser || rad.knapp} (tidigare: ${föregående ?? 'okänt'})`
  );

  // Larma bara vid övergången → ledig, annars mejlas du varannan timme så länge platsen står kvar.
  if (ledig && föregående !== 'ledig') {
    larm.push({
      rubrik: `${rad.kurs} — ${b.datum}`,
      tid: rad.tid,
      ort: rad.ort,
      platser: rad.platser
    });
  }
}

writeFileSync(STATE_FIL, JSON.stringify(nyState, null, 2) + '\n');

// ---------- Skriv larmfiler som workflowet läser ----------

if (larm.length) {
  const rubrik =
    larm.length === 1 ? `PLATS LEDIG: ${larm[0].rubrik}` : `PLATSER LEDIGA: ${larm.length} jakter`;

  const brödtext = [
    'Följande bevakade jakter har fått lediga platser:',
    '',
    ...larm.map(l => `- **${l.rubrik}**, ${l.ort}, ${l.tid} — ${l.platser}`),
    '',
    `Boka här: ${URL}`,
    '',
    `_Kontrollerad ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}_`
  ].join('\n');

  writeFileSync('larm-rubrik.txt', rubrik);
  writeFileSync('larm-text.md', brödtext);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `larm=true\nrubrik=${rubrik}\n`);
  }
  console.log(`\n🔔 ${larm.length} larm: ${rubrik}`);
} else {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'larm=false\n');
  }
  console.log('\nInga nya lediga platser.');
}
