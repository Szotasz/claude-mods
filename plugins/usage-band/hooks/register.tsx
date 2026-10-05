import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Context, Limit } from '../types'

const limits = atom({ plugin: 'usage-band', key: 'limits' } as const, [])
// Ablak + reset párosok, amikre már szóltunk: így egy ablakra resetenként egyszer jön toast.
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, [])
const context = atom({ plugin: 'usage-band', key: 'context' } as const, null)
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)

const WARN_AT = 90

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Hét' }
const WIDTH = 10

function bar(percent: number): string {
  const filled = Math.min(WIDTH, Math.round((percent / 100) * WIDTH))
  return '█'.repeat(filled) + '░'.repeat(WIDTH - filled)
}

function color(percent: number): string {
  return percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'
}

function resetText(kind: string, resetsAt?: string): string {
  if (resetsAt === undefined) return ''
  const at = new Date(resetsAt)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (kind === 'five_hour') return ` → ${hhmm}`
  const days = ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo']
  return ` → ${days[at.getDay()]} ${hhmm}`
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

async function warnPast90($: EngineInterface, current: Limit[]): Promise<void> {
  const already = await read($, warned)
  const fresh = current.filter(
    l => l.kind in LABELS && l.percentUsed >= WARN_AT && !already.includes(`${l.kind}@${l.resetsAt}`),
  )
  if (fresh.length === 0) return

  for (const l of fresh) {
    $.ui.toast(
      `⚠ ${LABELS[l.kind]} limit: ${Math.round(l.percentUsed)}%${resetText(l.kind, l.resetsAt)}`,
      { timeoutMs: 10000 },
    )
  }
  await update($, warned, list => [...list, ...fresh.map(l => `${l.kind}@${l.resetsAt}`)])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => toContext(usage.context))
    await warnPast90($, usage.rateLimits)
    await refreshModel($)
    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await refreshModel($)
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
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = (await read($, limits)).filter(l => l.kind in LABELS)
    const ctx = await read($, context)
    const name = await read($, model)
    if (e.props.hasSurvey || (shown.length === 0 && ctx === null && name === null)) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={3}>
        {name !== null && <Text bold>🤖 {name}</Text>}
        {ctx !== null && (
          <Box key="context" flexDirection="row">
            <Text dimColor>Ctx </Text>
            <Text color={color(ctx.percent)}>{bar(ctx.percent)}</Text>
            <Text bold> {ctx.percent}%</Text>
            <Text dimColor>
              {ctx.tokens === undefined ? '' : ` ${tokens(ctx.tokens)}/${tokens(ctx.window)}`}
            </Text>
          </Box>
        )}
        {shown.map(l => (
          <Box key={l.kind} flexDirection="row">
            <Text dimColor>{LABELS[l.kind]} </Text>
            <Text color={color(l.percentUsed)}>{bar(l.percentUsed)}</Text>
            <Text bold> {Math.round(l.percentUsed)}%</Text>
            <Text dimColor>{resetText(l.kind, l.resetsAt)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
