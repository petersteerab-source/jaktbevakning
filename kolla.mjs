// Bevakar återbudsplatser hos Stockholms Jaktgårdar (jaktgård.se).
//
// Data hämtas direkt från EduAdmins JSON-endpoint — ingen webbläsare.
// Playwright finns kvar som reserv om API-svaret slutar se ut som förväntat.
//
// Två lägen:
//   LOOP_MINUTER=0 (standard) → en enda kontroll, avslutar.
//   LOOP_MINUTER=270          → kontrollerar var INTERVALL_MIN minut.
//
// FIXTURE=fil.json testar logiken mot sparad data utan nätverk.

import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BOKNING_URL = 'https://www.xn--jaktgrd-ixa.se/alla';
const PORTAL_NYCKEL = process.env.EDUADMIN_PORTAL || '93dd2d9ce0c9ef53';
const API_URL =
  `https://app.eduadmin.se/webportal/${PORTAL_NYCKEL}/javascript/getInitialPageProps` +
  `?page=listEvents&pathAndQuery=%2Falla&locationHash=%23!eduname%3Dalla&textSearch=`;

const STATE_FIL = 'state.json';
const LOOP_MINUTER = Number(process.env.LOOP_MINUTER || 0);
const INTERVALL_MIN = Number(process.env.INTERVALL_MIN || 10);
const SLUT_TIMME = Number(process.env.SLUT_TIMME || 23);

const sv = opt => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', ...opt }).format(new Date());
const svensktDatum = () => sv({ year: 'numeric', month: '2-digit', day: '2-digit' });
const svenskTimme = () => Number(sv({ hour: 'numeric', hour12: false }));
const svenskNu = () => sv({ dateStyle: 'short', timeStyle: 'short' });

function rensaLarmfiler() {
  for (const f of ['larm-rubrik.txt', 'larm-text.md']) {
    try { rmSync(f, { force: true }); } catch { /* skrivskyddat filsystem */ }
  }
}

function läsState() {
  if (!existsSync(STATE_FIL)) return { _senast: null, jakter: {} };
  const rå = JSON.parse(readFileSync(STATE_FIL, 'utf8'));
  if (rå.jakter) return rå;
  const { _senast, ...rest } = rå;
  return { _senast: _senast ?? null, jakter: rest };
}

function skrivState(state) {
  writeFileSync(STATE_FIL, JSON.stringify(state, null, 2) + '\n');
}

function committaState(orsak) {
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    execFileSync('git', ['config', 'user.name', 'jaktbevakning']);
    execFileSync('git', ['config', 'user.email', 'actions@github.com']);
    execFileSync('git', ['add', STATE_FIL]);
    const dirty = execFileSync('git', ['status', '--porcelain', STATE_FIL], { encoding: 'utf8' }).trim();
    if (!dirty) return;
    execFileSync('git', ['commit', '-m', `state: ${orsak} ${new Date().toISOString().slice(0, 16)}Z`]);
    execFileSync('git', ['pull', '--rebase', '--autostash'], { stdio: 'inherit' });
    execFileSync('git', ['push'], { stdio: 'inherit' });
    console.log('   state.json committad.');
  } catch (fel) {
    console.error(`   kunde inte committa state: ${fel.message}`);
  }
}

async function hämtaViaApi() {
  const svar = await fetch(API_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'jaktbevakning/2 (github.com/petersteerab-source/jaktbevakning)'
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!svar.ok) throw new Error(`EduAdmin HTTP ${svar.status}`);
  const data = await svar.json();
  const items = data?.pageProps?.listItems?.items;
  if (!Array.isArray(items) || items.length < 5) {
    throw new Error(`API-svar saknar listItems (fick ${items?.length ?? 0} rader)`);
  }
  return items.map(normaliseraApiRad);
}

function normaliseraApiRad(item) {
  const datum = Array.isArray(item.displayDate) ? item.displayDate[0] : null;
  const tid = Array.isArray(item.displayDate) ? (item.displayDate[1] || '').trim() : '';
  const öppnar = item.formattedApplicationOpenDate || null;
  const öppnarUtc = item.applicationOpenDateUtc ? Date.parse(item.applicationOpenDateUtc + 'Z') : null;
  const öppningFramtid = Number.isFinite(öppnarUtc) && öppnarUtc > Date.now();
  const fullyBooked = Boolean(item.fullyBooked);
  const platser = item.seatsLeft || '';
  const harPlatser = !fullyBooked && !/inga platser kvar/i.test(platser);
  const gårAttBoka = harPlatser && !öppningFramtid;
  return {
    id: item.id,
    kurs: item.name || '',
    ort: item.city || '',
    datum,
    tid,
    platser,
    öppnar,
    slug: item.courseNameSlug || '',
    ledig: gårAttBoka
  };
}

async function hämtaViaPlaywright() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'sv-SE' });
    await page.goto(BOKNING_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      sel => document.querySelectorAll(sel).length > 5,
      '.eduadmin-md-div-table-row',
      { timeout: 60_000 }
    );
    const rader = await page.$$eval(
      '.eduadmin-md-div-table-row',
      (els, cell) =>
        els
          .map(el =>
            [...el.querySelectorAll(cell)]
              .map(c => c.innerText.trim().replace(/\s+/g, ' '))
              .filter(Boolean)
          )
          .filter(r => r.length > 3),
      '.eduadmin-md-div-table-cell'
    );
    return rader.map(c => {
      const datumCell = c[2] || '';
      const datum = (datumCell.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1] || null;
      const tid = datumCell.replace(/\b20\d{2}-\d{2}-\d{2}\s*/g, '').trim();
      const platser = c.find(x => /plats(er)? kvar/i.test(x)) || '';
      const knapp = (c[c.length - 1] || '').trim();
      const harPlatser = !/inga platser kvar/i.test(platser);
      const gårAttBoka = /^boka$/i.test(knapp);
      return {
        id: null,
        kurs: c[0] || '',
        ort: c[1] || '',
        datum,
        tid,
        platser,
        öppnar: /^anmälan öppnas/i.test(knapp) ? knapp : null,
        slug: '',
        ledig: harPlatser && gårAttBoka
      };
    });
  } finally {
    await browser.close();
  }
}

async function hämtaRader() {
  if (process.env.FIXTURE) {
    const rå = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
    if (Array.isArray(rå) && rå[0] && typeof rå[0].kurs === 'string') return rå;
    if (Array.isArray(rå) && Array.isArray(rå[0])) {
      return rå.map(c => {
        const datumCell = c[2] || '';
        const datum = (datumCell.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1] || null;
        const tid = datumCell.replace(/\b20\d{2}-\d{2}-\d{2}\s*/g, '').trim();
        const platser = c.find(x => /plats(er)? kvar/i.test(x)) || '';
        const knapp = (c[c.length - 1] || '').trim();
        return {
          id: null,
          kurs: c[0] || '',
          ort: c[1] || '',
          datum,
          tid,
          platser,
          öppnar: null,
          slug: '',
          ledig: !/inga platser kvar/i.test(platser) && /^boka$/i.test(knapp)
        };
      });
    }
    throw new Error('FIXTURE har okänt format');
  }

  const FORSOK = 3;
  const PAUS_MS = 8_000;
  let sistaFel;
  for (let n = 1; n <= FORSOK; n++) {
    try {
      const rader = await hämtaViaApi();
      if (n > 1) console.log(`   (API svarade på försök ${n} av ${FORSOK})`);
      return rader;
    } catch (fel) {
      sistaFel = fel;
      console.log(`   API-försök ${n}/${FORSOK} misslyckades: ${String(fel.message).split('\n')[0]}`);
      if (n < FORSOK) await new Promise(r => setTimeout(r, PAUS_MS));
    }
  }

  if (process.env.TILLÅT_PLAYWRIGHT === '1') {
    console.log('   Faller tillbaka på Playwright…');
    return hämtaViaPlaywright();
  }
  throw sistaFel;
}

function matcha(bevakning, rader) {
  if (bevakning.id) {
    const viaId = rader.find(r => r.id === bevakning.id);
    if (viaId) return viaId;
  }
  return rader.find(
    r =>
      r.datum === bevakning.datum &&
      r.kurs.toLowerCase().includes(bevakning.namn.toLowerCase()) &&
      r.ort.toLowerCase().includes(bevakning.ort.toLowerCase())
  );
}

async function enKontroll(bevakningar, tidigare) {
  const rader = await hämtaRader();
  if (rader.length < 5) {
    throw new Error(`Fick bara ${rader.length} rader — avbryter hellre än gissar.`);
  }

  const idag = svensktDatum();
  const larm = [];
  const nyJakter = { ...tidigare.jakter };

  for (const b of bevakningar) {
    const nyckel = `${b.datum}|${b.namn}|${b.ort}`;

    if (b.datum < idag) {
      console.log(`⏭  ${nyckel} — datumet har passerat, hoppar över.`);
      delete nyJakter[nyckel];
      continue;
    }

    const rad = matcha(b, rader);
    if (!rad) {
      console.log(`❓ ${nyckel} — hittades inte i listan.`);
      nyJakter[nyckel] = 'saknas';
      continue;
    }

    const status = rad.ledig ? 'ledig' : 'full';
    const föregående = tidigare.jakter[nyckel];
    nyJakter[nyckel] = status;

    const extra = rad.öppnar && !rad.ledig ? ` (öppnar ${rad.öppnar})` : '';
    console.log(
      `${rad.ledig ? '✅' : '⛔'} ${nyckel} — ${rad.platser || 'okänt'}${extra} (tidigare: ${föregående ?? 'okänt'})`
    );

    if (rad.ledig && föregående !== 'ledig') {
      larm.push({
        rubrik: `${rad.kurs} — ${b.datum}`,
        tid: rad.tid,
        ort: rad.ort,
        platser: rad.platser,
        länk: rad.slug
          ? `https://www.xn--jaktgrd-ixa.se/alla/#!eduname=${rad.slug}`
          : BOKNING_URL
      });
    }
  }

  return {
    larm,
    nyState: {
      _senast: new Date().toISOString(),
      _källa: process.env.FIXTURE ? 'fixture' : 'eduadmin-api',
      jakter: nyJakter
    }
  };
}

async function skickaNtfy(rubrik, brödtext) {
  const ämne = process.env.NTFY_TOPIC;
  if (!ämne) return;
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  try {
    await fetch(`${server}/${ämne}`, {
      method: 'POST',
      headers: {
        Title: rubrik,
        Priority: 'high',
        Tags: 'duck,hunting',
        Click: BOKNING_URL
      },
      body: brödtext
    });
    console.log('   ntfy skickad.');
  } catch (fel) {
    console.error(`   ntfy misslyckades: ${fel.message}`);
  }
}

async function skickaLarm(larm) {
  const rubrik =
    larm.length === 1 ? `PLATS LEDIG: ${larm[0].rubrik}` : `PLATSER LEDIGA: ${larm.length} jakter`;

  const brödtext = [
    'Följande bevakade jakter har fått lediga platser:',
    '',
    ...larm.map(l => `- **${l.rubrik}**, ${l.ort}, ${l.tid} — ${l.platser}`),
    '',
    `Boka här: ${BOKNING_URL}`,
    '',
    `_Kontrollerad ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}_`
  ].join('\n');

  writeFileSync('larm-rubrik.txt', rubrik);
  writeFileSync('larm-text.md', brödtext);
  console.log(`\n🔔 ${larm.length} larm: ${rubrik}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `larm=true\nrubrik=${rubrik}\n`);
  }

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

  await skickaNtfy(rubrik, brödtext.replace(/\*\*/g, ''));
}

rensaLarmfiler();

const bevakningar = JSON.parse(readFileSync('bevakningar.json', 'utf8'));
let tidigare = läsState();

const slutTid = Date.now() + LOOP_MINUTER * 60_000;
let varv = 0;

while (true) {
  varv++;
  if (LOOP_MINUTER > 0) console.log(`\n--- Varv ${varv}, ${svenskNu()} ---`);

  try {
    const { larm, nyState } = await enKontroll(bevakningar, tidigare);
    const ändrad = JSON.stringify(tidigare.jakter) !== JSON.stringify(nyState.jakter);
    tidigare = nyState;
    skrivState(nyState);
    if (ändrad) committaState('ändring');
    if (larm.length) await skickaLarm(larm);
    else console.log('Inga nya lediga platser.');
  } catch (fel) {
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
