import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { PREFILTER, addedLines, envFiles, githubRepo, goesPublic, grepLines, parsePush, scanLines } from './scan'
import type { Finding, Line } from './scan'

const isOn = atom({ plugin: 'public-repo-guard', key: 'isOn' } as const, true)

type Lang = 'hu' | 'en'

const KINDS = {
  hu: {
    supabaseRef: 'Supabase projekt-ID',
    jwt: 'JWT / Supabase-kulcs',
    privateKey: 'privát kulcs',
    apiKey: 'API-kulcs',
    email: 'e-mail-cím',
    localPath: 'helyi útvonal',
    privateRepo: 'privát repó neve',
    watched: 'figyelt szöveg',
    envFile: '.env fájl',
  },
  en: {
    supabaseRef: 'Supabase project ID',
    jwt: 'JWT / Supabase key',
    privateKey: 'private key',
    apiKey: 'API key',
    email: 'email address',
    localPath: 'local path',
    privateRepo: 'private repo name',
    watched: 'watched text',
    envFile: '.env file',
  },
} as const

const STRINGS = {
  hu: {
    header: 'Push-őr',
    command: 'Push-őr: nyilvános repóba push előtt titkok, ID-k, e-mailek keresése',
    hint: '[be|ki|figyel <szöveg>]',
    on: 'Push-őr bekapcsolva.',
    off: 'Push-őr kikapcsolva: a pushok ellenőrzés nélkül mennek.',
    watching: (w: string) => `Figyelem mostantól: „${w}”.`,
    usage: 'Használat: /pushor [be|ki|figyel <szöveg>]',
    deny: 'Megtiltom',
    push: 'Pushold így is',
    remember: 'Pushold, jegyezd meg',
    question: (repo: string, n: number, list: string) => `Nyilvános repóba menne (${repo}), és ${n} gyanús dolgot találtam:\n${list}\nMehet?`,
    more: (n: number) => `  … és még ${n}`,
    denied: (repo: string, list: string) =>
      `A public-repo-guard megállította a pusht (${repo} nyilvános), mert ezek kerülnének ki:\n${list}\nTávolítsd el vagy anonimizáld őket, és írd át az érintett commitokat is (a historyban is benne vannak), aztán kérdezd meg a felhasználót, mielőtt újra pusholsz.`,
    dismissed: 'A public-repo-guard megállította a pusht: a felhasználó bezárta a kérdést. Ne pushold újra kérdés nélkül.',
    other: (answer: string) => `A public-repo-guard megállította a pusht; a felhasználó válasza: „${answer}”`,
    failed: 'public-repo-guard: az ellenőrzés nem sikerült, ezért a push nem ment ki. /pushor ki után kézzel engedhető.',
  },
  en: {
    header: 'Push guard',
    command: 'Push guard: look for secrets, IDs and emails before pushing to a public repo',
    hint: '[on|off|figyel <text>]',
    on: 'Push guard on.',
    off: 'Push guard off: pushes go out unchecked.',
    watching: (w: string) => `Now watching for "${w}".`,
    usage: 'Usage: /pushor [on|off|figyel <text>]',
    deny: 'Deny',
    push: 'Push anyway',
    remember: 'Push, remember these',
    question: (repo: string, n: number, list: string) => `This goes to a public repo (${repo}), and I found ${n} suspicious items:\n${list}\nGo ahead?`,
    more: (n: number) => `  … and ${n} more`,
    denied: (repo: string, list: string) =>
      `public-repo-guard stopped the push (${repo} is public) because these would be published:\n${list}\nRemove or anonymise them, rewrite the commits that carry them (they are in the history too), then ask the user before pushing again.`,
    dismissed: 'public-repo-guard stopped the push: the user closed the question. Do not push again without asking.',
    other: (answer: string) => `public-repo-guard stopped the push; the user answered: "${answer}"`,
    failed: 'public-repo-guard: the check failed, so the push did not go out. /pushor off lets it through by hand.',
  },
}

let lang: Lang = 'en'
const t = () => STRINGS[lang]

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

async function strings($: EngineInterface, key: string): Promise<string[]> {
  const value = await $.store.get(key)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// Láthatóság repónként, 10 percig.
const visibility = new Map<string, { at: number; value: string }>()
const VISIBILITY_MS = 10 * 60_000
const PRIVATE_LIST_MS = 24 * 60 * 60_000

async function run($: EngineInterface, argv: string[], cwd: string) {
  return $.process.run(argv, { cwd, timeoutMs: 20_000 })
}

async function visibilityOf($: EngineInterface, repo: string, cwd: string): Promise<string> {
  const hit = visibility.get(repo)
  if (hit !== undefined && Date.now() - hit.at < VISIBILITY_MS) return hit.value
  const r = await run($, ['gh', 'repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], cwd)
  const value = r.exitCode === 0 ? r.stdout.trim().toUpperCase() : 'UNKNOWN'
  visibility.set(repo, { at: Date.now(), value })
  return value
}

// A felhasználó privát repóinak nevei (owner/name és a jellegzetes rövid név), naponta frissítve.
async function privateRepos($: EngineInterface, owner: string, cwd: string): Promise<string[]> {
  const saved = (await $.store.get('privateRepos')) as { at?: number; owner?: string; list?: string[] } | undefined
  let list = saved?.owner === owner && Date.now() - (saved.at ?? 0) < PRIVATE_LIST_MS ? (saved.list ?? []) : null
  if (list === null) {
    const r = await run($, ['gh', 'repo', 'list', owner, '--visibility', 'private', '--limit', '300', '--json', 'nameWithOwner', '-q', '.[].nameWithOwner'], cwd)
    list = r.exitCode === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(s => s !== '') : (saved?.list ?? [])
    if (r.exitCode === 0) await $.store.set('privateRepos', { at: Date.now(), owner, list })
  }
  const bare = list.map(full => full.split('/')[1] ?? '').filter(name => /[-_]/.test(name) || name.length >= 10)
  return [...list, ...bare]
}

function resolveDir(cwd: string, dir: string | null, home: string | null): string {
  if (dir === null) return cwd
  const expanded = home !== null ? dir.replace(/^~(?=\/|$)/, home) : dir
  return expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
}

type Scan = { repo: string; findings: Finding[] }

// Mi menne ki: a távoli ágon még nem lévő commitok (üzenet + hozzáadott sorok), vagy ha nincs mihez mérni, az egész fa.
async function scan($: EngineInterface, command: string): Promise<Scan | null> {
  const push = parsePush(command)
  const flip = goesPublic(command)
  if (push === null && !flip) return null

  const home = (await $.env.get('HOME')) ?? null
  const dir = resolveDir(await $.session.cwd(), push?.dir ?? null, home)
  const remote = push?.remote ?? 'origin'
  const url = /[:/]/.test(remote) ? remote : (await run($, ['git', 'remote', 'get-url', '--push', remote], dir)).stdout.trim()
  const repo = githubRepo(url)
  if (repo === null && url === '') return null
  if (!flip && repo !== null && ['PRIVATE', 'INTERNAL'].includes(await visibilityOf($, repo, dir))) return null

  let lines: Line[]
  let envs: string[]
  const tip = push?.src ?? 'HEAD'
  let base: string | null = null
  if (push !== null && !flip) {
    let dst = push.dst ?? (tip === 'HEAD' ? null : tip.replace(/^refs\/heads\//, ''))
    if (dst === null) dst = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout.trim()
    for (const candidate of [`refs/remotes/${remote}/${dst}`, `refs/remotes/${remote}/HEAD`]) {
      if ((await run($, ['git', 'rev-parse', '--verify', '-q', candidate], dir)).exitCode === 0) {
        base = candidate
        break
      }
    }
  }
  if (base !== null) {
    const log = (await run($, ['git', 'log', '-p', '--no-color', '--no-ext-diff', '--format=%x1e%h%n%B%x1f', `${base}..${tip}`], dir)).stdout
    if (log.trim() === '') return null
    lines = addedLines(log)
    envs = envFiles(log)
  } else {
    const grep = await run($, ['git', 'grep', '-I', '-n', '-i', '-E', PREFILTER, tip], dir)
    lines = grepLines(grep.stdout, tip)
    const tree = (await run($, ['git', 'ls-tree', '-r', '--name-only', tip], dir)).stdout
    envs = envFiles(tree.split('\n').map(f => `+++ b/${f}`).join('\n'))
  }

  const owner = repo?.split('/')[0] ?? null
  const findings = scanLines(lines, {
    home,
    privateRepos: owner === null ? [] : (await privateRepos($, owner, dir)).filter(r => r.toLowerCase() !== repo?.toLowerCase() && r.toLowerCase() !== repo?.split('/')[1]?.toLowerCase()),
    watch: await strings($, 'watch'),
    allow: await strings($, 'allow'),
    ownEmail: (await run($, ['git', 'config', 'user.email'], dir)).stdout.trim() || null,
  })
  const allow = new Set((await strings($, 'allow')).map(a => a.toLowerCase()))
  for (const file of envs) {
    if (!allow.has(file.toLowerCase())) findings.unshift({ kind: 'envFile', file, line: 0, value: file, shown: file })
  }
  return findings.length === 0 ? null : { repo: repo ?? url, findings }
}

function listOf(findings: readonly Finding[], max: number): string {
  const kinds = KINDS[lang]
  const rows = findings.slice(0, max).map(f => {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file
    return `• ${kinds[f.kind as keyof typeof kinds] ?? f.kind}: ${f.shown}  (${where})`
  })
  if (findings.length > max) rows.push(t().more(findings.length - max))
  return rows.join('\n')
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, isOn, () => value)
  await $.store.set('isOn', value)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    lang = await pickLanguage($, options.language)
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)
    await $.command.register({ name: 'pushor', description: t().command, argumentHint: t().hint, immediate: true })
    return next(e)
  })

  on('command.run', { command: 'pushor' }, async ($, e) => {
    const args = e.args.trim()
    const [verb, ...rest] = args.split(/\s+/)
    const arg = (verb ?? '').toLowerCase()
    if (arg === 'figyel' || arg === 'watch') {
      const text = rest.join(' ').trim()
      if (text === '') return { text: t().usage }
      await $.store.set('watch', [...new Set([...(await strings($, 'watch')), text])])
      return { text: t().watching(text) }
    }
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t().usage }
    await setOn($, wanted)
    return { text: wanted ? t().on : t().off }
  })

  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'pushguard') await setOn($, e.value.on)
    return done
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const found = await scan($, e.command)
    if (found === null) return next(e)

    let answer: string
    try {
      answer = await $.ui.ask(t().question(found.repo, found.findings.length, listOf(found.findings, 8)), {
        header: t().header,
        options: [t().deny, t().push, t().remember],
      })
    } catch {
      return { deny: t().dismissed }
    }
    if (answer === t().push) return next(e)
    if (answer === t().remember) {
      await $.store.set('allow', [...new Set([...(await strings($, 'allow')), ...found.findings.map(f => f.value)])])
      return next(e)
    }
    if (answer === t().deny) return { deny: t().denied(found.repo, listOf(found.findings, 40)) }
    return { deny: t().other(answer) }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // Hibánál csak a push és a láthatóság-váltás áll meg; minden más parancs fut tovább.
    try {
      if (parsePush(e.command) === null && !goesPublic(e.command)) return next(e)
    } catch {
      if (!/\bgit\b[^;&|]*\bpush\b|\bgh\s+repo\b/.test(e.command)) return next(e)
    }
    return { deny: t().failed }
  })
}
