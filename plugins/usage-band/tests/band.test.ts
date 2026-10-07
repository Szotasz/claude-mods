import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2026-10-09T08:00:00Z' },
]

const HU = { options: { language: 'hu' } }

// A motor helyett: a measure-t visszhangozza, a modellnevet megadja, a státuszsort és a toastokat gyűjti.
function engine(on: On, modelName = 'Opus') {
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  mock.store(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.model', () => ({ value: modelName }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  return { status, toasts, last: () => status.at(-1) }
}

test('a státuszsorban a modell, a kontextus és mindkét limit', HU, async ($, on) => {
  const s = engine(on, 'Opus 5.5 (1M context)')
  await $.session.measure({
    context: { tokens: 420_000, window: 1_000_000, percent: 42 },
    rateLimits: LIMITS,
    changed: ['context', 'rateLimits'],
  })
  const line = s.last() ?? ''
  expect(line).toStartWith('🤖 Opus 5.5 (1M context)')
  expect(line).toContain('Ctx ███░░░░░ 42% 420k/1M')
  expect(line).toMatch(/5h ███░░░░░ 34% → \d\d:\d\d/)
  expect(line).toMatch(/Hét ███████░ 93% ⚠ → (V|H|K|Sze|Cs|P|Szo) \d\d:\d\d/)
})

test('limitek nélkül csak modell és kontextus (nem előfizetéses fiók)', HU, async ($, on) => {
  const s = engine(on)
  await $.session.measure({ context: { tokens: 5000, window: 200_000, percent: 3 }, rateLimits: [], changed: ['context'] })
  expect(s.last()).toBe('🤖 Opus  │  Ctx ░░░░░░░░ 3% 5k/200k')
})

test('90% fölött egyszer szól, resetenként', HU, async ($, on) => {
  const s = engine(on)
  const measure = (rateLimits: typeof LIMITS) =>
    $.session.measure({ context: {} as never, rateLimits, changed: ['rateLimits'] })

  await measure(LIMITS)
  expect(s.toasts.length).toBe(1)
  expect(s.toasts[0]).toStartWith('⚠ Hét limit: 93% → ')

  // Tovább nő ugyanabban az ablakban: nincs újabb toast.
  await measure([LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 97 }])
  expect(s.toasts.length).toBe(1)

  // Új ablak (új resetsAt) és újra 90 fölött: megint szól.
  await measure([LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 91, resetsAt: '2026-10-16T08:00:00Z' }])
  expect(s.toasts.length).toBe(2)
})

test('angolul is megy', { options: { language: 'en' } }, async ($, on) => {
  const s = engine(on)
  await $.session.measure({ context: {} as never, rateLimits: LIMITS, changed: ['rateLimits'] })
  expect(s.last()).toMatch(/Week ███████░ 93% ⚠ → (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d/)
  expect(s.toasts[0]).toStartWith('⚠ Week limit: 93%')
})

for (const [lang, expected] of [['hu_HU.UTF-8', 'Hét'], ['en_US.UTF-8', 'Week']] as const) {
  test(`auto: ${lang} → ${expected}`, async ($, on) => {
    const s = engine(on)
    mock.env(on, { LANG: lang })
    on('session.start', ($, e) => e as never)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: LIMITS } }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    expect(s.last()).toContain(`${expected} `)
  })
}

test('a sávba már nem rajzol', HU, async ($, on) => {
  engine(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  await $.session.measure({ context: {} as never, rateLimits: LIMITS, changed: ['rateLimits'] })
  const ui = await $.ui.mount({
    plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await ui.unmount()
})

test('/limitsav ki: üres státuszsor, be: újra kiírja', HU, async ($, on) => {
  const s = engine(on)
  await $.session.measure({ context: { tokens: 5000, window: 200_000, percent: 3 }, rateLimits: [], changed: ['context'] })
  expect((await $.command.run({ command: 'limitsav', args: 'ki' } as never)).text).toBe('Limitsáv kikapcsolva.')
  expect(s.last()).toBeUndefined()
  await $.session.measure({ context: { tokens: 6000, window: 200_000, percent: 3 }, rateLimits: [], changed: ['context'] })
  expect(s.last()).toBeUndefined()
  await $.command.run({ command: 'limitsav', args: 'be' } as never)
  expect(s.last()).toContain('Ctx')
})
