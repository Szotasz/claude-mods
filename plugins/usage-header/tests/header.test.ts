import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-05T14:20:00Z' },
  { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2026-10-09T08:00:00Z' },
]

const cat = (name: string, tokens: number, color: string, kind: 'used' | 'free' | 'buffer' | 'deferred') =>
  ({ name, tokens, color, kind, isDeferred: kind === 'deferred' })

const BREAKDOWN = {
  categories: [
    cat('System prompt', 3_000, 'promptBorder', 'used'),
    cat('System tools', 12_000, 'inactive', 'used'),
    cat('MCP tools', 30_000, 'cyan_FOR_SUBAGENTS_ONLY', 'deferred'),
    cat('Memory files', 400, 'claude', 'used'),
    cat('Messages', 68_600, 'purple_FOR_SUBAGENTS_ONLY', 'used'),
    cat('Free space', 83_000, 'promptBorder', 'free'),
    cat('Autocompact buffer', 33_000, 'inactive', 'buffer'),
  ],
  totalTokens: 84_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 42,
}

const HU = { options: { language: 'hu' } }

function engine(on: On, withBreakdown = true) {
  mock.store(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => e as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42, breakdown: withBreakdown ? BREAKDOWN : undefined },
      rateLimits: LIMITS,
    },
  }) as never)
}

async function mount($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop') {
  return $.ui.mount({
    plugin: 'usage-header', surface, component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as never,
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`kontextus kategóriánként színezve és a két limit (${surface})`, HU, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as never)
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /^Kontextus/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^─{120}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Rendszerprompt 3k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Üzenetek 69k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tömörítési tartalék 33k' })).toBeDefined()
    // A halasztott MCP-sémák nincsenek az ablakban.
    expect(await ui.find({ type: 'Text', text: /MCP/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '5 óra ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 93% ⚠' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ (V|H|K|Sze|Cs|P|Szo) \d\d:\d\d/ })).toBeDefined()
    await ui.unmount()
  })
}

test('első válasz előtt: nincs adat felirat', HU, async ($, on) => {
  engine(on, false)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /még nincs adat/ })).toBeDefined()
  await ui.unmount()
})

test('/hasznalat ki: a sáv eltűnik, be: visszajön', HU, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  expect((await $.command.run({ command: 'hasznalat', args: 'ki' } as never)).text).toBe('Használati sáv kikapcsolva.')
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'hasznalat', args: 'be' } as never)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' 42%' })).toBeDefined()
  await ui.unmount()
})

test('angolul is', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'System prompt 3k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Week ' })).toBeDefined()
  await ui.unmount()
})
