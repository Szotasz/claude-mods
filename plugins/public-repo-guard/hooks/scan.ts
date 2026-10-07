// Tiszta függvények: a push parancs értelmezése és a kiszivárgó adatok keresése a pusholt változásokban.

export type Push = { dir: string | null; remote: string; src: string; dst: string | null }

const FLAGS_WITH_VALUE = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option', '--signed', '--recurse-submodules'])

function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

// `cd x && git push origin a:b`, `git -C x push -u origin main` → mit pusholunk, hova.
export function parsePush(command: string): Push | null {
  let dir: string | null = null
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const w = words(segment.trim())
    if (w[0] === 'cd' && w[1] !== undefined) dir = w[1]
    const g = w.indexOf('git')
    if (g === -1) continue
    let i = g + 1
    let gitDir = dir
    while (i < w.length && (w[i] ?? '').startsWith('-')) {
      if (w[i] === '-C') {
        gitDir = w[i + 1] ?? null
        i += 2
      } else if (w[i] === '-c') i += 2
      else i += 1
    }
    if (w[i] !== 'push') continue
    const positional: string[] = []
    let dryRun = false
    let deleting = false
    for (let j = i + 1; j < w.length; j++) {
      const a = w[j] ?? ''
      if (a === '--dry-run' || a === '-n') dryRun = true
      else if (a === '--delete' || a === '-d') deleting = true
      else if (FLAGS_WITH_VALUE.has(a)) j++
      else if (!a.startsWith('-')) positional.push(a)
    }
    if (dryRun || deleting) return null
    const remote = positional[0] ?? 'origin'
    const spec = (positional[1] ?? '').replace(/^\+/, '')
    if (spec.startsWith(':')) return null
    const colon = spec.indexOf(':')
    const src = colon === -1 ? spec : spec.slice(0, colon)
    const dst = colon === -1 ? '' : spec.slice(colon + 1)
    return { dir: gitDir, remote, src: src === '' ? 'HEAD' : src, dst: dst === '' ? null : dst.replace(/^refs\/heads\//, '') }
  }
  return null
}

// `gh repo edit --visibility public` és `gh repo create --public`: az egész fát nézzük át.
export function goesPublic(command: string): boolean {
  return /\bgh\s+repo\s+edit\b[^;&|]*--visibility[=\s]+public\b/.test(command) || /\bgh\s+repo\s+create\b[^;&|]*--public\b/.test(command)
}

// git@github.com:owner/name.git, https://github.com/owner/name → owner/name
export function githubRepo(url: string): string | null {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m === null ? null : `${m[1]}/${m[2]}`
}

export type Line = { file: string; line: number; text: string }

// `git log -p` kimenetéből a hozzáadott sorok és a commit üzenetek (file = "commit abc123").
export function addedLines(log: string): Line[] {
  const out: Line[] = []
  let file = ''
  let line = 0
  let inMessage = false
  let commit = ''
  for (const raw of log.split('\n')) {
    if (raw.startsWith('\u001e')) {
      commit = raw.slice(1).trim()
      inMessage = true
      line = 0
      continue
    }
    if (inMessage) {
      if (raw.startsWith('\u001f')) {
        inMessage = false
        continue
      }
      line++
      out.push({ file: `commit ${commit}`, line, text: raw })
      continue
    }
    if (raw.startsWith('diff --git ')) {
      file = /^diff --git a\/.* b\/(.*)$/.exec(raw)?.[1] ?? file
      continue
    }
    if (raw.startsWith('+++ ')) {
      if (raw !== '+++ /dev/null') file = raw.slice(4).replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
    if (hunk !== null) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) })
      line++
    } else if (raw.startsWith(' ')) line++
  }
  return out
}

// `git grep -n` kimenete: rev:file:line:text vagy file:line:text
export function grepLines(output: string, rev: string | null): Line[] {
  const prefix = rev === null ? '' : `${rev}:`
  return output.split('\n').flatMap(raw => {
    const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
    const m = /^(.*?):(\d+):(.*)$/.exec(rest)
    return m === null ? [] : [{ file: m[1] ?? '', line: Number(m[2]), text: m[3] ?? '' }]
  })
}

// Az előszűrő a `git grep`-hez: csak a gyanús sorokat kérjük le.
export const PREFILTER = 'supabase|project[_ -]?(id|ref)|eyJ|sk_|sk-|rk_live|whsec_|wsec_|gh[pousr]_|AKIA|AIza|PRIVATE KEY|xox[baprs]-|re_[A-Za-z0-9]|@|/Users/|/home/'

type Rule = { kind: string; re: RegExp; mask: boolean }

const RULES: Rule[] = [
  { kind: 'supabaseRef', re: /\b([a-z]{20})\.supabase\.(?:co|in)\b/g, mask: true },
  { kind: 'supabaseRef', re: /project[_ -]?(?:id|ref)\W{1,6}([a-z]{20})\b/gi, mask: true },
  { kind: 'supabaseRef', re: /--project-ref[=\s]+([a-z]{20})\b/g, mask: true },
  { kind: 'jwt', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, mask: true },
  { kind: 'privateKey', re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, mask: false },
  { kind: 'apiKey', re: /\b((?:sk|rk)_live_[A-Za-z0-9]{10,}|sk_test_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|wsec_[A-Za-z0-9]{20,})/g, mask: true },
  { kind: 'apiKey', re: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})/g, mask: true },
  { kind: 'apiKey', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, mask: true },
  { kind: 'apiKey', re: /\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})/g, mask: true },
  { kind: 'apiKey', re: /\b(\d{8,10}:AA[A-Za-z0-9_-]{30,})/g, mask: true },
  { kind: 'apiKey', re: /\b(sk_[0-9a-f]{40,})/g, mask: true },
  { kind: 'email', re: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, mask: false },
]

const HARMLESS_EMAIL = /noreply|no-reply|@users\.noreply\.github\.com$|^(git|you|user|name|someone|test|info|email|valaki|pelda)@|@(example|pelda|email|test|domain|ceg|company|something|your-?domain|acme)\.[a-z.]+$/i
// Zajos, generált fájlok: ezekben nem keresünk.
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock)$/

export type Finding = { kind: string; file: string; line: number; value: string; shown: string }

export function maskValue(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}…`
  return `${value.slice(0, 6)}…${value.slice(-2)}`
}

export type Context = {
  home: string | null
  privateRepos: readonly string[]
  watch: readonly string[]
  allow: readonly string[]
  ownEmail: string | null
}

export function scanLines(lines: readonly Line[], ctx: Context): Finding[] {
  const found: Finding[] = []
  const seen = new Set<string>()
  const allow = new Set(ctx.allow.map(a => a.toLowerCase()))
  const add = (kind: string, l: Line, value: string, mask: boolean) => {
    if (allow.has(value.toLowerCase())) return
    const key = `${kind}|${value}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ kind, file: l.file, line: l.line, value, shown: mask ? maskValue(value) : value })
  }

  for (const l of lines) {
    if (SKIP_FILE.test(l.file)) continue
    for (const rule of RULES) {
      for (const m of l.text.matchAll(rule.re)) {
        const value = m[1] ?? ''
        if (rule.kind === 'email' && (HARMLESS_EMAIL.test(value) || value.toLowerCase() === ctx.ownEmail?.toLowerCase())) continue
        add(rule.kind, l, value, rule.mask)
      }
    }
    // Egy sor, ami a Supabase-ről szól, és benne egy 20 kisbetűs azonosító (pl. táblázatban).
    if (/supabase/i.test(l.text)) {
      for (const m of l.text.matchAll(/(?<![A-Za-z0-9.])([a-z]{20})(?![A-Za-z0-9])/g)) {
        add('supabaseRef', l, m[1] ?? '', true)
      }
    }
    if (ctx.home !== null && l.text.includes(`${ctx.home}/`)) add('localPath', l, ctx.home, false)
    const lower = l.text.toLowerCase()
    for (const repo of ctx.privateRepos) {
      if (lower.includes(repo.toLowerCase())) add('privateRepo', l, repo, false)
    }
    for (const w of ctx.watch) {
      if (w !== '' && lower.includes(w.toLowerCase())) add('watched', l, w, true)
    }
  }
  return found
}

// Új vagy módosított .env fájl (a minták kivételével).
export function envFiles(log: string): string[] {
  const files = new Set<string>()
  for (const m of log.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const file = m[1] ?? ''
    if (/(^|\/)\.env(\.[\w-]+)?$/.test(file) && !/\.(example|sample|template|dist)$/.test(file)) files.add(file)
  }
  return [...files]
}
