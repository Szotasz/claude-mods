import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown } from 'claude-code'

import type { Breakdown, Limit, Segment, Task } from '../types'

const breakdown = atom({ plugin: 'usage-header', key: 'breakdown' } as const, null)
const limits = atom({ plugin: 'usage-header', key: 'limits' } as const, [])
// Kikapcsolva a sáv üres; az eszköztár (tool-hub) is ezt olvassa.
const isOn = atom({ plugin: 'usage-header', key: 'isOn' } as const, true)

// A hivatkozásnak szó szerint kell a forrásban állnia (így listázható, mit olvas a mod).
const FOCUS_ON = { plugin: 'focus-mode', key: 'isOn' } as const
const FOCUS_TASKS = { plugin: 'focus-mode', key: 'tasks' } as const

const WARN_AT = 90
const CAUTION_AT = 70
const LABEL = 11

type Lang = 'hu' | 'en'

const STRINGS = {
  hu: {
    context: 'Kontextus',
    limits: 'Limitek',
    windows: { five_hour: '5 óra', seven_day: 'Hét' } as Record<string, string>,
    days: ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'],
    noData: 'még nincs adat (az első válasz után jelenik meg)',
    command: 'Használati sáv a prompt fölött be/ki',
    on: 'Használati sáv bekapcsolva.',
    off: 'Használati sáv kikapcsolva.',
    usage: 'Használat: /hasznalat [be|ki]',
    hint: '[be|ki]',
    names: {
      'System prompt': 'Rendszerprompt',
      'System tools': 'Eszközök',
      'MCP tools': 'MCP eszközök',
      'Custom agents': 'Ágensek',
      'Memory files': 'Memória',
      Skills: 'Skillek',
      'Slash commands': 'Parancsok',
      Messages: 'Üzenetek',
      'Free space': 'Szabad',
      'Autocompact buffer': 'Tömörítési tartalék',
    } as Record<string, string>,
  },
  en: {
    context: 'Context',
    limits: 'Limits',
    windows: { five_hour: '5h', seven_day: 'Week' } as Record<string, string>,
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    noData: 'no data yet (shows after the first response)',
    command: 'Usage band above the prompt on/off',
    on: 'Usage band on.',
    off: 'Usage band off.',
    usage: 'Usage: /hasznalat [on|off]',
    hint: '[on|off]',
    names: {} as Record<string, string>,
  },
}

// A modul minden beállításváltáskor újratöltődik, így elég egyszer, induláskor eldönteni.
let lang: Lang = 'en'
const t = () => STRINGS[lang]

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(n)
}

// A halasztott (igény szerint betöltött) eszközsémák nincsenek az ablakban: kimaradnak.
export function toBreakdown(b: SessionContextBreakdown): Breakdown {
  const segments: Segment[] = []
  for (const c of b.categories) {
    if (c.kind === 'deferred' || c.tokens <= 0) continue
    segments.push({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })
  }
  return { segments, total: b.totalTokens, max: b.rawMaxTokens, percent: b.percentage }
}

// Cellák kategóriánként, legnagyobb maradék szerint kerekítve; ami foglal, legalább egy cellát kap
// (a szabad helyből), hogy minden szín látsszon.
export function cells(segments: Segment[], max: number, width: number): number[] {
  const sum = Math.max(max, segments.reduce((a, s) => a + s.tokens, 0), 1)
  const exact = segments.map(s => (s.tokens / sum) * width)
  const out = exact.map(Math.floor)
  let left = width - out.reduce((a, n) => a + n, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i]! += 1
    left -= 1
  }
  const free = segments.findIndex(s => s.kind === 'free')
  for (const [i, s] of segments.entries()) {
    if (s.kind !== 'used' || out[i]! > 0) continue
    const donor = free >= 0 && out[free]! > 1 ? free : out.indexOf(Math.max(...out))
    if (out[donor]! <= 1) break
    out[donor]! -= 1
    out[i] = 1
  }
  return out
}

const glyph = (kind: Segment['kind']) => (kind === 'used' ? '█' : kind === 'buffer' ? '▒' : '░')

const levelColor = (percent: number) => (percent >= WARN_AT ? 'red' : percent >= CAUTION_AT ? 'yellow' : 'green')

function resetText(kind: string, resetsAt?: string): string {
  if (resetsAt === undefined) return ''
  const at = new Date(resetsAt)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return kind === 'five_hour' ? ` → ${hhmm}` : ` → ${t().days[at.getDay()]} ${hhmm}`
}

// A fókusz mód feliratai és elrendezése (focus-mode/hooks/register.tsx): ebből jön a lista legszélesebb sora.
const FOCUS_TEXT = {
  hu: { title: 'Fókusz mód', done: 'kész', waiting: 'a részfeladatok hamarosan megjelennek…', idle: 'bekapcsolva · /fokusz ki a kikapcsoláshoz' },
  en: { title: 'Focus mode', done: 'done', waiting: 'subtasks will show up shortly…', idle: 'on · /fokusz off to turn it off' },
}

export function focusWidth(list: readonly Task[], columns: number, isWorking: boolean, l: Lang): number {
  const f = FOCUS_TEXT[l]
  if (list.length === 0) return 2 + f.title.length + 1 + (isWorking ? f.waiting : f.idle).length
  const done = list.filter(task => task.status === 'done').length
  const total = Math.round(list.reduce((sum, task) => sum + task.progress, 0) / list.length)
  const header = `◆ ${f.title}  ${done}/${list.length} ${f.done}  `.length + 12 + ` ${total}%`.length
  const titleRoom = Math.max(10, columns - 24)
  const rows = list.map(task => {
    const name = Math.min(task.title.length, titleRoom)
    return task.status === 'in_progress' ? 4 + name + 1 + 8 + ` ${task.progress}%`.length : 4 + name
  })
  return Math.max(header, ...rows)
}

async function refresh($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  await update($, breakdown, prev => (b === undefined ? prev : toBreakdown(b)))
  await update($, limits, () => usage.rateLimits)
}

async function setOn($: EngineInterface, wanted: boolean): Promise<void> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    lang = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
    await $.command.register({ name: 'hasznalat', description: t().command, argumentHint: t().hint, immediate: true })
    await refresh($)
    return result
  })

  on('command.run', { command: 'hasznalat' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t().usage }
    await setOn($, wanted)
    if (wanted) await refresh($)
    return { text: wanted ? t().on : t().off }
  })

  // Az eszköztár gombja parancs nélkül kapcsol (így nem marad parancssor a transcriptben).
  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'header') await setOn($, e.value.on).catch(() => undefined)
    return done
  })

  // Turn végén és limitmozduláskor: a bontás a helyi becslés ('summary'), API-hívás nélkül.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const moved = e.changed.includes('context') || e.changed.includes('rateLimits')
    if (moved && (await read($, isOn))) await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, breakdown)
    const shown = (await read($, limits)).filter(l => l.kind in t().windows)
    const columns = e.props.bodyColumns || e.viewport?.columns || 80
    const width = Math.max(10, Math.min(60, columns - LABEL - 20))

    const label = (text: string) => <Text bold>{text.padEnd(LABEL)}</Text>

    let contextRows
    if (b === null || b.segments.length === 0) {
      contextRows = (
        <Box flexDirection="row">
          {label(t().context)}
          <Text dimColor>{t().noData}</Text>
        </Box>
      )
    } else {
      const counts = cells(b.segments, b.max, width)
      const pct = Math.round(b.percent)
      contextRows = (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {label(t().context)}
            {b.segments.map((s, i) =>
              counts[i]! > 0 ? (
                <Text key={`bar-${i}`} color={s.color} dimColor={s.kind !== 'used'}>
                  {glyph(s.kind).repeat(counts[i]!)}
                </Text>
              ) : null,
            )}
            <Text color={levelColor(pct)} bold>{` ${pct}%`}</Text>
            <Text dimColor>{` ${tokens(b.total)}/${tokens(b.max)}`}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={LABEL}>
            {b.segments.map((s, i) => (
              <Box key={`legend-${i}`} flexDirection="row">
                <Text color={s.color} dimColor={s.kind !== 'used'}>{s.kind === 'used' ? '■ ' : `${glyph(s.kind)} `}</Text>
                <Text dimColor={s.kind !== 'used'}>{`${t().names[s.name] ?? s.name} ${tokens(s.tokens)}`}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const limitWidth = Math.max(6, Math.min(20, Math.floor((columns - LABEL) / 2) - 26))
    const limitRow =
      shown.length === 0 ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {label(t().limits)}
          {shown.map(l => {
            const filled = Math.min(limitWidth, Math.round((l.percentUsed / 100) * limitWidth))
            const color = levelColor(l.percentUsed)
            return (
              <Box key={`limit-${l.kind}`} flexDirection="row">
                <Text>{`${t().windows[l.kind]} `}</Text>
                <Text color={color}>{'█'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(limitWidth - filled)}</Text>
                <Text color={color} bold>{` ${Math.round(l.percentUsed)}%${l.percentUsed >= WARN_AT ? ' ⚠' : ''}`}</Text>
                <Text dimColor>{resetText(l.kind, l.resetsAt)}</Text>
              </Box>
            )
          })}
        </Box>
      )

    // Ha a fókusz mód lista van fölötte, a vonal annak legszélesebb soráig tart, különben a kontextussorig.
    const focusOn = (await $.state.get(FOCUS_ON)).value === true
    const focusList = focusOn ? ((await $.state.get(FOCUS_TASKS)).value ?? []) : []
    const ownWidth = b === null || b.segments.length === 0 ? LABEL + t().noData.length : LABEL + width + 16
    const divider = Math.max(10, Math.min(columns - 1, focusOn ? focusWidth(focusList, columns, e.props.isWorking, lang) : ownWidth))

    // Vonal a sáv tetején: elválasztja a fölötte lévő modoktól (fókusz mód listája, eszköztár).
    return (
      <Box flexDirection="column">
        {below}
        <Text key="divider" dimColor>{'─'.repeat(divider)}</Text>
        {contextRows}
        {limitRow}
      </Box>
    )
  })
}
