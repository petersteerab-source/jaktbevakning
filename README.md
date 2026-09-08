# Jaktbevakning — återbudsplatser hos Stockholms Jaktgårdar

Kollar **varannan timme** om någon av de bevakade jakterna på jaktgård.se har
fått en ledig plats, och larmar när det händer. Körs i GitHub Actions — datorn
behöver inte vara igång.

Status: **aktiv**. Första körningen gjordes 2026-08-18 och satte utgångsläget.

## Vad som bevakas

Redigera `bevakningar.json` direkt här på GitHub (pennikonen) — ändringen slår
igenom vid nästa körning.

```json
[
  { "namn": "Vakjakt på råbock", "ort": "Bogesund", "datum": "2026-08-20" },
  { "namn": "Sjöfågeljakt",      "ort": "Gålö",     "datum": "2026-08-30" },
  { "namn": "Sjöfågeljakt",      "ort": "Gålö",     "datum": "2026-10-04" }
]
```

`namn` matchas som delsträng, så "Sjöfågeljakt" träffar "Sjöfågeljakt - Gålö".
`datum` måste vara startdatumet exakt som det står i listan på sajten.

## Hur larmet kommer fram

När en plats öppnar skapas en **GitHub-issue** med titeln
`🎯 PLATS LEDIG: Vakjakt på råbock - Bogesund — 2026-08-20`, och GitHub mejlar
dig automatiskt. Inga lösenord eller SMTP-inställningar behövs.

Vill du ha mejl direkt från Gmail i stället finns ett förberett block längst ned
i `.github/workflows/bevaka.yml` — ta bort kommentarstecknen och lägg in två
secrets (`GMAIL_ADRESS`, `GMAIL_APPLOSENORD`). App-lösenord skapas på
<https://myaccount.google.com/apppasswords>.

## Schema

Cron `0 5-21/2 * * *` (UTC) = 9 körningar per dygn:

| | Timmar |
|---|---|
| Svensk sommartid | 07, 09, 11, 13, 15, 17, 19, 21, 23 |
| Svensk vintertid | 06, 08, 10, 12, 14, 16, 18, 20, 22 |

Du kan alltid trycka **Run workflow** under fliken Actions för att kolla direkt.

## Viktigt att veta

- **Repot är Public.** Publika repon har obegränsat med Actions-minuter. Gör det
  inte privat — 9 körningar om dagen à ~1 minut äter snabbt upp gratiskvoten.
- **GitHub pausar schemalagda workflows** i repon utan aktivitet på 60 dagar.
  Du får ett mejl innan det sker; tryck bara "Enable workflow" igen.
- **Cron i Actions är inte exakt.** Vid hög belastning kan en körning bli
  försenad några minuter eller hoppas över.
- **Larm skickas bara vid övergången fullbokat → ledig**, inte varje körning så
  länge platsen står kvar. Tas platsen och kommer tillbaka larmar det igen.
- **"Anmälan öppnas 2026-09-01" räknas inte som ledig plats.** Den texten
  betyder att bokningen inte har öppnat än, även om det står platser kvar.
- Passerade datum hoppas över automatiskt.
- `state.json` skrivs av roboten efter varje körning. Rör den inte.

## Glöm inte det enkla spåret

Bogesund har ett nyhetsbrev enbart för jakter med kort varsel, inklusive
återbudsplatser: <https://www.xn--jaktgrd-ixa.se/bogesund/kort-varsel>
Anmäl dig där också — det kostar inget. Det täcker dock inte Gålö.
