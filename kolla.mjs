// Bevakar återbudsplatser hos Stockholms Jaktgårdar (jaktgård.se).
// Sidan renderas med JavaScript (EduAdmin-widget), därför Playwright och inte enkel HTTP-hämtning.
//
// Två lägen:
//   LOOP_MINUTER=0 (standard) → en enda kontroll, avslutar.
//   LOOP_MINUTER=270          → kontrollerar var INTERVALL_MIN minut i 4,5 timme.
// Loopläget finns för att GitHub hoppar över de flesta schemalagda starterna.
// Färre men längre körningar ger fler faktiska kontroller.
//
// FIXTURE=fil.json testar logiken mot sparad data utan webbläsare.

import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const URL = 'https://www.xn--jaktgrd-ixa.se/alla';
const RAD = '.eduadmin-md-div-table-row';
const CELL = '.eduadmin-md-div-table-cell';
const STATE_FIL = 'state.json';

const LOOP_MINUTER = Number(process.env.LOOP_MINUTER || 0);
const INTERVALL_MIN = Number(process.env.INTERVALL_MIN || 10);
const SLUT_TIMME = Number(process.env.SLUT_TIMME || 23);

// Datum och timme ska följa svensk tid, inte UTC. Annars byter "idag" datum
// vid midnatt UTC — alltså kl 02 svensk sommartid — och en jakt samma dag
// skulle hoppas över för tidigt.
const sv = opt => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', ...opt }).format(new Date());
const svensktDatum = () => sv({ year: 'numeric', month: '2-digit', day: '2-digit' });
const svenskTimme = () => Number(sv({ hour: 'numeric', hour12: false }));

// ---------- Hämta tabellen ----------

async function hämtaRader() {
  if (process.env.FIXTURE) {
    return JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
  }

  const { chromium } = await import('playwright');

  // jaktgård.se har enstaka sega minuter. Ett misslyckat försök ska inte
  // fälla hela kontrollen — försök om innan vi ger upp.
  const FORSOK = 3;
  const PAUS_MS = 10_000;
  let sistaFel;

  for (let n = 1; n <= FORSOK; n++) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ locale: 'sv-SE' });
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Bokningssystemet laddas asynkront. Vänta tills tabellen faktiskt har innehåll.
      await page.waitForFunction(sel => document.querySelectorAll(sel).length > 5, RAD, { timeout: 60_000 });

      const rader = await page.$$eval(
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

      if (n > 1) console.log(`   (sidan lästes på försök ${n} av ${FORSOK})`);
      return rader;
    } catch (fel) {
      sistaFel = fel;
      console.log(`   försök ${n}/${FORSOK} misslyckades: ${String(fel.message).split('\n')[0]}`);
      if (n < FORSOK) await new Promise(r => setTimeout(r, PAUS_MS));
    } finally {
      await browser.close();
    }
  }

  throw sistaFel;
}

// ---------- En kontroll ----------

async function enKontroll(bevakningar, tidigare) {
  const rader = await hämtaRader();
  if (rader.length < 5) {
    throw new Error(`Fick bara ${rader.length} rader — sidan laddade troligen inte klart.`);
  }

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

  const idag = svensktDatum();
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

    // Larma bara vid övergången → ledig, annars larmas du varje varv så länge platsen står kvar.
    if (ledig && föregående !== 'ledig') {
      larm.push({ rubrik: `${rad.kurs} — ${b.datum}`, tid: rad.tid, ort: rad.ort, platser: rad.platser });
    }
  }

  return { larm, nyState };
}

// ---------- Larm ----------

function skickaLarm(larm) {
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
  console.log(`\n🔔 ${larm.length} larm: ${rubrik}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `larm=true\nrubrik=${rubrik}\n`);
  }

  // I loopläget skapas issuen härifrån — workflowets steg körs ju först
  // när hela loopen är slut, vilket kan vara timmar senare.
  if (process.env.GH_TOKEN) {
    try {
      execFileSync('gh', ['issue', 'create', '--title', `🎯 ${rubrik}`, '--body-file', 'larm-text.md'], {
        stdio: 'inherit'
      });
      console.log('   issue skapad.');
    } catch (fel) {
      console.error(`   KUNDE INTE SKAPA ISSUE: ${fel.message}`);
    }
  }
}

// ---------- Huvudloop ----------

for (const f of ['larm-rubrik.txt', 'larm-text.md']) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* skrivskyddat filsystem — workflowet checkar ändå ut rent varje körning */
  }
}

const bevakningar = JSON.parse(readFileSync('bevakningar.json', 'utf8'));
let tidigare = existsSync(STATE_FIL) ? JSON.parse(readFileSync(STATE_FIL, 'utf8')) : {};

const slutTid = Date.now() + LOOP_MINUTER * 60_000;
let varv = 0;

while (true) {
  varv++;
  if (LOOP_MINUTER > 0) console.log(`\n--- Varv ${varv}, ${sv({ dateStyle: 'short', timeStyle: 'short' })} ---`);

  try {
    const { larm, nyState } = await enKontroll(bevakningar, tidigare);
    tidigare = nyState;
    writeFileSync(STATE_FIL, JSON.stringify(nyState, null, 2) + '\n');
    if (larm.length) skickaLarm(larm);
    else console.log('Inga nya lediga platser.');
  } catch (fel) {
    // I loopläget ska ett trasigt varv inte fälla körningen — nästa varv
    // kommer om tio minuter. Vid enkelkörning är felet däremot värt ett larm.
    console.error(`Kontrollen misslyckades: ${fel.message}`);
    if (LOOP_MINUTER <= 0) process.exit(1);
  }

  if (LOOP_MINUTER <= 0) break;
  if (Date.now() >= slutTid) {
    console.log('\nLooptiden är slut. Nästa schemalagda körning tar vid.');
    break;
  }
  if (svenskTimme() >= SLUT_TIMME) {
    console.log(`\nKlockan har passerat ${SLUT_TIMME} svensk tid. Avslutar för idag.`);
    break;
  }
  await new Promise(r => setTimeout(r, INTERVALL_MIN * 60_000));
}

if (LOOP_MINUTER > 0) console.log(`\nKlart. ${varv} kontroller genomförda.`);
