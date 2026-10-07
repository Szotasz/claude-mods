import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { LOOK_IN, actionRisk, isRef, refsIn, short, supabaseAction, supabaseCli } from './classify'
import type { Risk } from './classify'

const isOn = atom({ plugin: 'supabase-guard', key: 'isOn' } as const, true)

type Lang = 'hu' | 'en'

const STRINGS = {
  hu: {
    header: 'Supabase-őr',
    command: 'Supabase-őr be/ki: rossz projektre menő és romboló Supabase-hívások megállítása',
    on: 'Supabase-őr bekapcsolva.',
    off: 'Supabase-őr kikapcsolva: a Supabase-hívások ellenőrzés nélkül futnak.',
    usage: 'Használat: /supaor [be|ki]',
    deny: 'Megtiltom',
    once: 'Engedélyezem',
    session: 'Engedem a session végéig',
    bind: 'Ez a mappa projektje',
    mismatch: (what: string, target: string, folder: string, own: string) =>
      `${what} a(z) ${target} projekten — de ez a mappa (${folder}) a(z) ${own} projekthez tartozik. Engeded?`,
    unknown: (what: string, target: string, folder: string) =>
      `${what} a(z) ${target} projekten. Ehhez a mappához (${folder}) nem találtam Supabase-projektet. Engeded?`,
    destructive: (what: string, target: string) => `Romboló művelet a(z) ${target} projekten: ${what}. Engeded?`,
    readNote: (target: string, own: string) =>
      `Figyelem (supabase-guard): ez a hívás a(z) ${target} projektet olvasta, de az aktuális mappa projektje ${own}. Ellenőrizd, hogy a jó projektről vonsz-e le következtetést.`,
    denied: (what: string) =>
      `A supabase-guard megállította (${what}): a felhasználó nem engedélyezte. Ne próbáld meg más úton; kérdezd meg, mit szeretne, vagy használd a mappához tartozó projektet.`,
    dismissed: (what: string) => `A supabase-guard megállította (${what}): a felhasználó bezárta a kérdést. Ne futtasd újra kérdés nélkül.`,
    other: (answer: string) => `A supabase-guard megállította; a felhasználó válasza: „${answer}”`,
    bound: (folder: string, ref: string) => `Megjegyeztem: a(z) ${folder} mappa projektje ${short(ref)}.`,
  },
  en: {
    header: 'Supabase',
    command: 'Supabase guard on/off: stop Supabase calls to the wrong project and destructive ones',
    on: 'Supabase guard on.',
    off: 'Supabase guard off: Supabase calls run unchecked.',
    usage: 'Usage: /supaor [on|off]',
    deny: 'Deny',
    once: 'Allow once',
    session: 'Allow for this session',
    bind: "It is this folder's project",
    mismatch: (what: string, target: string, folder: string, own: string) =>
      `${what} on project ${target}, but this folder (${folder}) belongs to ${own}. Allow it?`,
    unknown: (what: string, target: string, folder: string) =>
      `${what} on project ${target}. I found no Supabase project for this folder (${folder}). Allow it?`,
    destructive: (what: string, target: string) => `Destructive action on project ${target}: ${what}. Allow it?`,
    readNote: (target: string, own: string) =>
      `Note (supabase-guard): this call read project ${target}, but the current folder's project is ${own}. Make sure you draw conclusions about the right project.`,
    denied: (what: string) =>
      `Stopped by supabase-guard (${what}): the user did not allow it. Do not try another route; ask them what they want, or use this folder's project.`,
    dismissed: (what: string) => `Stopped by supabase-guard (${what}): the user closed the question. Do not run it again without asking.`,
    other: (answer: string) => `Stopped by supabase-guard; the user answered: "${answer}"`,
    bound: (folder: string, ref: string) => `Noted: the project of ${folder} is ${short(ref)}.`,
  },
}

let lang: Lang = 'en'
const t = () => STRINGS[lang]

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

// Session szintű engedélyek (`ref|kockázat`): újratöltéskor elfelejtődnek, ez szándékos.
const allowed = new Set<string>()
// Mappánkénti gyorsítótár, hogy ne olvassuk minden hívásnál a fájlokat.
const cache = new Map<string, { at: number; refs: string[] }>()
const CACHE_MS = 60_000

type Bindings = Record<string, string[]>
type Names = Record<string, string>

async function storeObject<T extends object>($: EngineInterface, key: string): Promise<T> {
  const value = await $.store.get(key)
  return (typeof value === 'object' && value !== null ? value : {}) as T
}

// A mappa projektje: a supabase CLI link, a .env fájlok URL-jei, a CLAUDE.md (ha egyetlen ref-et említ), és amit a felhasználó megerősített.
async function expected($: EngineInterface): Promise<{ root: string; refs: string[] }> {
  const cwd = await $.session.cwd()
  const root = (await $.session.repo())?.root ?? cwd
  const hit = cache.get(root)
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return { root, refs: hit.refs }

  const refs = new Set<string>((await storeObject<Bindings>($, 'bindings'))[root] ?? [])
  for (const dir of new Set([root, cwd])) {
    for (const file of LOOK_IN) {
      const path = `${dir}/${file}`
      if (!(await $.fs.exists(path))) continue
      const found = refsIn(await $.fs.read(path))
      if (file === 'CLAUDE.md' && found.length !== 1) continue
      for (const ref of found) refs.add(ref)
    }
  }
  const list = [...refs]
  cache.set(root, { at: Date.now(), refs: list })

  // Megjegyezzük, melyik ref melyik mappáé, hogy máshol is néven nevezhessük.
  if (list.length > 0) {
    const names = await storeObject<Names>($, 'names')
    const folder = basename(root)
    if (list.some(ref => names[ref] !== folder)) {
      await $.store.set('names', { ...names, ...Object.fromEntries(list.map(ref => [ref, folder])) })
    }
  }
  return { root, refs: list }
}

async function label($: EngineInterface, ref: string): Promise<string> {
  const name = (await storeObject<Names>($, 'names'))[ref]
  return name === undefined ? ref : `${name} (${short(ref)})`
}

type Verdict = { allow: true; note?: string } | { allow: false; reason: string }

async function judge($: EngineInterface, ref: string | null, risk: Risk, what: string): Promise<Verdict> {
  if (!(await read($, isOn))) return { allow: true }
  const { root, refs } = await expected($)
  const folder = basename(root)
  const known = refs.length > 0
  const mismatch = known && ref !== null && !refs.includes(ref)

  if (risk === 'read') {
    if (!mismatch || ref === null) return { allow: true }
    const own = (await Promise.all(refs.map(r => label($, r)))).join(', ')
    return { allow: true, note: t().readNote(await label($, ref), own) }
  }

  const key = `${ref ?? '?'}|${risk}`
  if (allowed.has(key)) return { allow: true }
  const target = ref === null ? '?' : await label($, ref)

  let question: string
  let options: string[]
  if (mismatch) {
    const own = (await Promise.all(refs.map(r => label($, r)))).join(', ')
    question = t().mismatch(what, target, folder, own)
    options = risk === 'destructive' ? [t().deny, t().once] : [t().deny, t().once, t().bind]
  } else if (risk === 'destructive') {
    question = t().destructive(what, target)
    options = [t().deny, t().once]
  } else if (!known && ref !== null) {
    question = t().unknown(what, target, folder)
    options = [t().deny, t().once, t().session, t().bind]
  } else {
    return { allow: true }
  }

  let answer: string
  try {
    answer = await $.ui.ask(question, { header: t().header, options })
  } catch {
    return { allow: false, reason: t().dismissed(what) }
  }
  if (answer === t().once) return { allow: true }
  if (answer === t().session) {
    allowed.add(key)
    return { allow: true }
  }
  if (answer === t().bind && ref !== null) {
    const bindings = await storeObject<Bindings>($, 'bindings')
    await $.store.set('bindings', { ...bindings, [root]: [...new Set([...(bindings[root] ?? []), ref])] })
    cache.delete(root)
    $.ui.toast(t().bound(folder, ref))
    return { allow: true }
  }
  if (answer === t().deny) return { allow: false, reason: t().denied(what) }
  return { allow: false, reason: t().other(answer) }
}

function describe(action: string, input: Record<string, unknown>): string {
  const sql = typeof input.query === 'string' ? input.query.replace(/\s+/g, ' ').trim() : ''
  const name = typeof input.name === 'string' ? ` ${input.name}` : ''
  if (sql === '') return `${action}${name}`
  return `${action}${name}: ${sql.length > 120 ? `${sql.slice(0, 119)}…` : sql}`
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
    await $.command.register({
      name: 'supaor',
      description: t().command,
      argumentHint: lang === 'hu' ? '[be|ki]' : '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'supaor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t().usage }
    await setOn($, wanted)
    return { text: wanted ? t().on : t().off }
  })

  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'supabase') await setOn($, e.value.on)
    return done
  })

  // Supabase MCP eszközök (bármelyik szerveren, aminek a nevében szerepel a „supabase”).
  on('tool.call', async ($, e, next) => {
    const action = supabaseAction(e.tool)
    if (action === null) return next(e)
    const input = e as unknown as Record<string, unknown>
    const ref = isRef(input.project_id) ? input.project_id : null
    const what = describe(action, input)
    const verdict = await judge($, ref, actionRisk(action, input), what)
    if (!verdict.allow) return { deny: verdict.reason }
    const result = await next(e)
    if (verdict.note === undefined || result.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), verdict.note] }
  }).catch(($, e, next) => (next.called || supabaseAction(e.tool) === null ? next(e) : { deny: 'supabase-guard: the check failed, so the call was stopped.' }))

  // A supabase CLI a Bash-ban.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cli = supabaseCli(e.command)
    if (cli === null || cli.risk === 'read') return next(e)
    const verdict = await judge($, cli.ref, cli.risk, `supabase ${cli.what}`)
    if (!verdict.allow) return { deny: verdict.reason }
    return next(e)
  }).catch(($, e, next) => (next.called || supabaseCli(e.command) === null ? next(e) : { deny: 'supabase-guard: the check failed, so the command was stopped.' }))
}
