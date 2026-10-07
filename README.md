# claude-mods

Saját Claude Code mod-ok (function hook pluginek) egy pluginpiacon.

## Telepítés

```
claude plugin marketplace add Szotasz/claude-mods
claude plugin install usage-band@claude-mods
claude plugin install project-pane@claude-mods
claude plugin install snake-pane@claude-mods
```

Frissítés: `claude plugin update usage-band@claude-mods`, majd `/reload-plugins` (vagy új session).

## Pluginek

### usage-band

A státuszsorba (a prompt alá) írja:

```
🤖 Opus 5.5  │  Ctx ███░░░░░ 42% 420k/1M  │  5h ███░░░░░ 34% → 16:20  │  Hét ███████░ 93% ⚠ → Cs 10:00
```

- modell neve (`/model` váltáskor és turn végén frissül)
- kontextusablak telítettsége
- 5 órás és heti rate-limit, reset időponttal (csak Pro/Max előfizetéssel)
- ⚠ 90% felett, és egy toast, amikor egy limit átlépi (ablakonként, resetenként egyszer)

**Nyelv / Language:** `/config` → `usage-band.language`, vagy a `settings.json`-ban:

```json
"pluginConfigs": { "usage-band": { "language": "en" } }
```

- `auto` (alapértelmezett): magyar, ha a rendszer nyelve (`LANG`) magyar, különben angol
- `hu`: magyar (`Hét`, `Cs 10:00`)
- `en`: English (`Week`, `Thu 10:00`)

**Követelmény:** Claude Code 2.1.289 körüli verzió. A mod-API early access, kiadásról kiadásra változhat.

### project-pane

Oldalpanel az aktuális git repóhoz. Magától megnyílik, ha a session git repóban indul és a terminál legalább 144 oszlop széles (miután egyszer `/project`-tel megnyitottad, 110 is elég); keskenyebb ablaknál egy toast szól, hogy vár. Bármikor: `/project`.

```
acme/shop                          ↻ most [ Frissítés ]
GIT
🌿 develop  ↑0 ↓0  · 7 módosított fájl
utolsó commit: 57704fe · 7 hónapja — Fix checkout flow
⚠ a main 13 committal előrébb jár, te a develop branch-en vagy
Előbb commitold a módosításokat, vagy tedd félre őket:
[ Stash + szinkron ]
DEPLOY (Netlify)
✔ ready  main  3 perce
PULL REQUESTEK
✔ #142 Stripe webhook retry  · approved
CI (GitHub Actions)
✘ netlify-deploy-verify  main · 5 napja      [ Kérdezd Claude-ot ]
SUPABASE
abcdefghijklmnopqrst · Acme Shop · eu-west-3
18 migráció · utolsó: 018_add_orders_rls.sql
GitHub  Netlify  Supabase
```

- **Szinkron gomb** (`s`): csak fast-forward, soha nem merge-öl, rebase-el vagy töröl.
  - a branch lemaradt az upstreamtől → `git pull --ff-only`
  - másik branchen vagy, és az alapértelmezett (main) előrébb jár → `git switch main` + `git merge --ff-only origin/main`
  - commitolatlan módosítás esetén csak „Stash + szinkron” van: `git stash push -u`, vissza: `git stash pop`
  - ha elakad, a hibát Claude-nak szóló kérdésként a promptba teszi
- **Frissítés** (`r`): 60 mp-enként és minden turn végén; `git fetch` 5 percenként.
- **Kérdezd Claude-ot** (`a`): a legutóbbi elbukott CI-futásról kérdést tesz a promptba.
- Toast, ha a session alatt elbukik egy Netlify deploy vagy CI-futás.

Adatforrások (a CLI-k saját bejelentkezésével, a plugin tokent nem olvas):

| Szekció | Forrás | Ha hiányzik |
|---|---|---|
| Git | `git` | — |
| PR, CI | `gh` (`gh auth login`) | tipp a panelen |
| Deploy | `netlify` CLI + `.netlify/state.json` | `npm i -g netlify-cli && netlify login` |
| Supabase | `supabase/.temp/project-ref`, `supabase/migrations`, `supabase projects list` | `supabase login` az állapothoz |

Beállítás (`/config`): `project-pane.language` (`auto`/`hu`/`en`), `project-pane.autoOpen` (alapból be).

### snake-pane

Kígyó játék az oldalpanelben, amíg Claude dolgozik.

```
⏳ Claude dolgozik…
Pont: 4  Rekord: 17
╭──────────────────────────────────────╮
│                                      │
│          ████████                    │
│                ██      ●             │
╰──────────────────────────────────────╯
p: szünet · r: újra
w: ↑ a: ← s: ↓ d: → p: szünet r: új
```

- Promptküldéskor magától megnyílik (ha ebben a sessionben bezártad, már nem; `/jatek` mindig nyitja). `/jatek ki` kikapcsolja, az eszköztárban (`/eszkozok`) is kapcsolható.
- Irányítás: kattints a táblára, utána nyilak / `wasd` / `hjkl`, szóköz vagy `p` szünet, `r` új játék. Vagy `ctrl+x tab` a panelre, és a `w a s d p r` gombok.
- A turn végén a futó játék szünetel („Claude végzett”), hogy visszatérj a munkához.
- A pontszámmal gyorsul; a rekordot sessionök között megőrzi.
- A játék a rajzoló szálon fut (`Client` surface modul), nem terheli a sessiont.

## Ötletek

project-pane bővítése:
- Vercel deploy-ok (`vercel ls`)
- remote Supabase migrációk összevetése a lokálissal
- több repó egy panelen

Státuszsor bővítése (`usage-band`):
- figyelmeztetés kontextusablakra (pl. 85%), opcionálisan automatikus `/compact`
- session költsége (`$.session.usage().cost`)
- fast mód jelzése, git branch, aktuális projekt
- beállítható küszöb és megjelenő elemek (`userConfig`)

Új mod-ok:
- **env-guard**: `.env`, kulcsfájlok, `supabase/.temp` szerkesztésének tiltása (`tool.call` → `deny`)
- **prod-guard**: éles Supabase projekt ID-jára vagy `git push origin main`-re megerősítés kérése
- **turn-timer**: hosszú turn végén hang/toast, hogy vissza lehet nézni (`turn.complete`, `$.audio.play`)
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
