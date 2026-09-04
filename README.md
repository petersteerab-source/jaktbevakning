# Jaktbevakning — återbudsplatser hos Stockholms Jaktgårdar

Kollar **var tionde minut** (07–23 svensk tid) om någon av de bevakade
jakterna på jaktgård.se har fått en ledig plats, och larmar när det händer.

Körs i GitHub Actions. Datorn behöver inte vara igång. Kostnad: 0 kr.

Status: **aktiv** sedan 2026-08-18. Från 2026-09-04 hämtas listan via
EduAdmins JSON-API i stället för Playwright — varje kontroll tar sekunder
i stället för en minut.

## Vad som bevakas

Redigera `bevakningar.json` direkt här på GitHub (pennikonen).

```json
[
  { "namn": "Sjöfågeljakt", "ort": "Gålö", "datum": "2026-10-04" },
  { "namn": "Kombijakt på vildsvin, rådjur och dovhjort", "ort": "Gålö", "datum": "2026-10-16" }
]
```

`namn` matchas som delsträng. `ort` och `datum` exakt. Valfritt fält `id`
(EduAdmins event-id) slår mer precist om två jakter annars krockar.

## Hur larmet kommer fram

När en plats öppnar skapas en **GitHub-issue** med titeln
`🎯 PLATS LEDIG: …`, och GitHub mejlar dig. Repot måste stå på
**Watch → All Activity**, annars kommer inget mejl från bot-skapade issues.

### Snabbare push: ntfy.sh (valfritt)

1. Installera [ntfy](https://ntfy.sh) på telefonen.
2. Prenumerera på ett hemligt ämnesnamn, t.ex. `jakt-golo-7f3a`.
3. Lägg ämnet som repo-secret `NTFY_TOPIC`.

Då kommer larmet som push inom sekunder, utöver mejlet.

## Schema

Fyra långa jobb per dygn som loopar internt var 10:e minut:

| | Start (UTC) | Svensk sommartid | Svensk vintertid |
|---|---|---|---|
| Pass 1 | 05:00 | 07:00 | 06:00 |
| Pass 2 | 09:00 | 11:00 | 10:00 |
| Pass 3 | 13:00 | 15:00 | 14:00 |
| Pass 4 | 17:00 | 19:00 | 18:00 |

Varje pass pågår 4,5 timme eller tills klockan passerat 23 svensk tid.
Passen överlappar, så en missad start täcks av nästa.

## Viktigt att veta

- **Repot är Public.** Publika repon har obegränsat med Actions-minuter.
- **GitHub pausar schemalagda workflows** efter 60 dagars inaktivitet.
- **Cron i Actions är best effort.** Därför långa loopar i stället för många korta jobb.
- **Larm skickas bara vid övergången fullbokat → ledig.**
- **"Anmälan öppnas …" räknas inte som ledig plats.** API-fältet
  `applicationOpenDateUtc` jämförs mot klockan.
- Passerade datum hoppas över och rensas ur `state.json`.
- `state.json` skrivs av roboten. Rör den inte.

## Glöm inte det enkla spåret

Bogesund har ett nyhetsbrev för jakter med kort varsel:
<https://www.xn--jaktgrd-ixa.se/bogesund/kort-varsel>
Det täcker inte Gålö.
