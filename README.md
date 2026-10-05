# claude-mods

Saját Claude Code mod-ok (function hook pluginek) egy pluginpiacon.

## Telepítés

```
claude plugin marketplace add Szotasz/claude-mods
claude plugin install usage-band@claude-mods
```

Frissítés: `claude plugin update usage-band@claude-mods`, majd `/reload-plugins` (vagy új session).

## Pluginek

### usage-band

Sáv a prompt felett:

```
🤖 Opus 5.5   Ctx ████░░░░░░ 42% 420k/1M   5h ███░░░░░░░ 34% → 16:20   Hét █████████░ 93% → Cs 10:00
```

- modell neve (`/model` váltáskor és turn végén frissül)
- kontextusablak telítettsége
- 5 órás és heti rate-limit, reset időponttal (csak Pro/Max előfizetéssel)
- toast, ha egy limit átlépi a 90%-ot (ablakonként, resetenként egyszer)

Összecsukás: `ctrl+x ctrl+a`.

**Nyelv / Language:** `/config` → `usage-band.language`, vagy a `settings.json`-ban:

```json
"pluginConfigs": { "usage-band": { "language": "en" } }
```

- `auto` (alapértelmezett): magyar, ha a rendszer nyelve (`LANG`) magyar, különben angol
- `hu`: magyar (`Hét`, `Cs 10:00`)
- `en`: English (`Week`, `Thu 10:00`)

**Követelmény:** Claude Code 2.1.289 körüli verzió. A mod-API early access, kiadásról kiadásra változhat.

## Ötletek

Sáv bővítése (`usage-band`):
- figyelmeztetés kontextusablakra (pl. 85%), opcionálisan automatikus `/compact`
- session költsége (`$.session.usage().cost`)
- fast mód jelzése, git branch, aktuális projekt
- beállítható küszöb és megjelenő elemek (`userConfig`)

Új mod-ok:
- **env-guard**: `.env`, kulcsfájlok, `supabase/.temp` szerkesztésének tiltása (`tool.call` → `deny`)
- **prod-guard**: éles Supabase projekt ID-jára vagy `git push origin main`-re megerősítés kérése
- **turn-timer**: hosszú turn végén hang/toast, hogy vissza lehet nézni (`turn.complete`, `$.audio.play`)
- **project-pane**: oldalpanel az aktuális repó Netlify/Vercel deploy állapotával és nyitott PR-jeivel
- **quote**: `/quote` — a kijelölt szöveget idézetként a promptba teszi (`$.ui.selection`)
- **hu-prompt**: a rendszerpromptba magyar válasz- és stílusszabály (`prompt.compose`)

## Fejlesztés

Egy plugin mappája közvetlenül is betölthető:

```
claude --plugin-dir ./plugins/usage-band
```

Ellenőrzés:

```
claude plugin validate plugins/usage-band
claude plugin test plugins/usage-band
```
