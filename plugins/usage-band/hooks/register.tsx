import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Context, Limit } from '../types'

const limits = atom({ plugin: 'usage-band', key: 'limits' } as const, [])
// Ablak + reset párosok, amikre már szóltunk: így egy ablakra resetenként egyszer jön toast.
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, [])
const context = atom({ plugin: 'usage-band', key: 'context' } as const, null)
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)
// Kikapcsolva üres a státuszsor; az eszköztár (tool-hub) is ezt olvassa.
const isOn = atom({ plugin: 'usage-band', key: 'isOn' } as const, true)

const WARN_AT = 90

type Strings = { labels: Record<string, string>; days: string[]; limit: string; command: string; on: string; off: string; usage: string }

const STRINGS: Record<'hu' | 'en', Strings> = {
  hu: {
    labels: { five_hour: '5h', seven_day: 'Hét' },
    days: ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'],
    limit: 'limit',
    command: 'Limit- és kontextussáv be/ki',
    on: 'Limitsáv bekapcsolva.',
    off: 'Limitsáv kikapcsolva.',
    usage: 'Használat: /limitsav [be|ki]',
  },
  en: {
    labels: { five_hour: '5h', seven_day: 'Week' },
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    limit: 'limit',
    command: 'Usage and context bar on/off',
    on: 'Usage bar on.',
    off: 'Usage bar off.',
    usage: 'Usage: /limitsav [on|off]',
  },
}

// A modul minden beállításváltáskor újratöltődik, így elég egyszer, induláskor eldönteni.
let t: Strings = STRINGS.en
const LABELS = (): Record<string, string> => t.labels
const WIDTH = 8

function bar(percent: number): string {
  const filled = Math.min(WIDTH, Math.round((percent / 100) * WIDTH))
  return '█'.repeat(filled) + '░'.repeat(WIDTH - filled)
}

const warnMark = (percent: number) => (percent >= WARN_AT ? ' ⚠' : '')

function resetText(kind: string, resetsAt?: string): string {
  if (resetsAt === undefined) return ''
  const at = new Date(resetsAt)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (kind === 'five_hour') return ` → ${hhmm}`
  return ` → ${t.days[at.getDay()]} ${hhmm}`
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// Csak akkor van mit mutatni, ha már jött válasz, amiből a telítettség kiderül.
function toContext(usage: SessionContextUsage): Context | null {
  if (usage.percent === undefined) return null
  return { percent: usage.percent, tokens: usage.tokens, window: usage.window }
}

async function refreshModel($: EngineInterface): Promise<void> {
  const current = await $.session.model()
  await update($, model, () => current)
}

// A státuszsor sima szöveg (színt nem visz): a 90% fölötti értéket ⚠ jelzi.
async function pushStatus($: EngineInterface): Promise<void> {
  if (!(await read($, isOn))) {
    $.ui.status(undefined)
    return
  }
  const name = await read($, model)
  const ctx = await read($, context)
  const shown = (await read($, limits)).filter(l => l.kind in LABELS())

  const parts: string[] = []
  if (name !== null) parts.push(`🤖 ${name}`)
  if (ctx !== null) {
    const used = ctx.tokens === undefined ? '' : ` ${tokens(ctx.tokens)}/${tokens(ctx.window)}`
    parts.push(`Ctx ${bar(ctx.percent)} ${ctx.percent}%${used}${warnMark(ctx.percent)}`)
  }
  for (const l of shown) {
    const pct = Math.round(l.percentUsed)
    parts.push(`${LABELS()[l.kind]} ${bar(l.percentUsed)} ${pct}%${warnMark(l.percentUsed)}${resetText(l.kind, l.resetsAt)}`)
  }
  $.ui.status(parts.length === 0 ? undefined : parts.join('  │  '))
}

async function warnPast90($: EngineInterface, current: Limit[]): Promise<void> {
  const already = await read($, warned)
  const fresh = current.filter(
    l => l.kind in LABELS() && l.percentUsed >= WARN_AT && !already.includes(`${l.kind}@${l.resetsAt}`),
  )
  if (fresh.length === 0) return

  for (const l of fresh) {
    $.ui.toast(
      `⚠ ${LABELS()[l.kind]} ${t.limit}: ${Math.round(l.percentUsed)}%${resetText(l.kind, l.resetsAt)}`,
      { timeoutMs: 10000 },
    )
  }
  await update($, warned, list => [...list, ...fresh.map(l => `${l.kind}@${l.resetsAt}`)])
}

async function setOn($: EngineInterface, wanted: boolean): Promise<void> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
  await pushStatus($)
}

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Strings> {
  if (setting === 'hu' || setting === 'en') return STRINGS[setting]
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? STRINGS.hu : STRINGS.en
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') t = STRINGS[options.language]

  on('session.start', async ($, e, next) => {
    t = await pickLanguage($, options.language)
    const result = await next(e)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
    await $.command.register({ name: 'limitsav', description: t.command, argumentHint: t === STRINGS.hu ? '[be|ki]' : '[on|off]', immediate: true })
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => toContext(usage.context))
    await warnPast90($, usage.rateLimits)
    await refreshModel($)
    await pushStatus($)
    return result
  })

  on('command.run', { command: 'limitsav' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t.usage }
    await setOn($, wanted)
    return { text: wanted ? t.on : t.off }
  })

  // Az eszköztár gombja parancs nélkül kapcsol (így nem marad parancssor a transcriptben).
  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'limits') await setOn($, e.value.on)
    return done
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await refreshModel($)
    await pushStatus($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const current = toContext(e.context)
      await update($, context, () => current)
    }
    // Turn végén is ránézünk: így az automatikus fallback is látszik.
    await refreshModel($)
    if (e.changed.includes('rateLimits')) {
      const current: Limit[] = e.rateLimits
      await update($, limits, () => current)
      await warnPast90($, current)
    }
    await pushStatus($)
    return next(e)
  })
}
