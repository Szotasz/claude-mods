import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2026-10-09T08:00:00Z' },
]

const PROPS = { hasSurvey: false, isWorking: false } as never
const HU = { options: { language: 'hu' } }

// A motor helyett: a measure-t visszhangozza, a sávba a saját (üres) rajzát adja.
function engine(on: On, modelName?: string) {
  if (modelName !== undefined) on('session.model', () => ({ value: modelName }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as never
  })
}

test('a sáv mutatja mindkét ablakot', HU, async ($, on) => {
  engine(on, 'Opus')
  await $.session.measure({ context: {} as never, rateLimits: LIMITS, changed: ['rateLimits'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /^ 34%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 93%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Hét $/ })).toBeDefined()
    await ui.unmount()
  }
})

test('adat nélkül átengedi a motornak (nem előfizetéses fiók)', HU, async ($, on) => {
  engine(on, 'Opus')
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('90% fölött egyszer szól, resetenként', HU, async ($, on) => {
  engine(on, 'Opus')
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })

  const measure = (rateLimits: typeof LIMITS) =>
    $.session.measure({ context: {} as never, rateLimits, changed: ['rateLimits'] })

  await measure(LIMITS)
  expect(toasts).toEqual(['⚠ Hét limit: 93% → ' + toasts[0]?.split('→ ')[1]])

  // Tovább nő ugyanabban az ablakban: nincs újabb toast.
  await measure([LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 97 }])
  expect(toasts.length).toBe(1)

  // Új ablak (új resetsAt) és újra 90 fölött: megint szól.
  await measure([LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 91, resetsAt: '2026-10-16T08:00:00Z' }])
  expect(toasts.length).toBe(2)
})

test('a kontextusablak telítettsége is látszik, limitek nélkül is', HU, async ($, on) => {
  engine(on, 'Opus')
  await $.session.measure({
    context: { tokens: 420_000, window: 1_000_000, percent: 42 },
    rateLimits: [],
    changed: ['context'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /^Ctx $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 42%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 420k\/1M$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a modell neve a sáv elején', HU, async ($, on) => {
  engine(on, 'Opus 5.5 (1M context)')
  await $.session.measure({ context: {} as never, rateLimits: [], changed: ['cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /^🤖 Opus 5\.5 \(1M context\)$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('angolul is megy', { options: { language: 'en' } }, async ($, on) => {
  engine(on, 'Opus')
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.measure({ context: {} as never, rateLimits: LIMITS, changed: ['rateLimits'] })

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /^Week $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ → (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/ })).toBeDefined()
  expect(toasts[0]).toMatch(/^⚠ Week limit: 93%/)
  await ui.unmount()
})

test('auto: magyar LANG mellett magyar', async ($, on) => {
  engine(on, 'Opus')
  mock.env(on, { LANG: 'hu_HU.UTF-8' })
  on('session.start', ($, e) => e as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: LIMITS } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /^Hét $/ })).toBeDefined()
  await ui.unmount()
})

test('auto: más LANG mellett angol', async ($, on) => {
  engine(on, 'Opus')
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('session.start', ($, e) => e as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: LIMITS } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /^Week $/ })).toBeDefined()
  await ui.unmount()
})
