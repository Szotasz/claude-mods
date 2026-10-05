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

**Követelmény:** Claude Code 2.1.289 körüli verzió. A mod-API early access, kiadásról kiadásra változhat.

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
