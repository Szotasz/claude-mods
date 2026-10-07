import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HU = { options: { language: 'hu' } }

function engine(on: On, store: Record<string, unknown> = {}) {
  const opened: string[] = []
  const closed: string[] = []
  mock.env(on, { LANG: 'hu_HU.UTF-8' })
  mock.store(on, store)
  on('session.start', ($, e) => e as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', ($, e) => { closed.push(e.id); return { value: undefined } as never })
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return { opened, closed }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
}

const PANE = {
  component: 'Pane',
  requestId: 'snake',
  props: { title: 'Kígyó', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 19 }, view: {} } as never,
} as const

test('promptküldéskor és /jatek-kal nyílik', HU, async ($, on) => {
  const { opened } = engine(on)
  await start($)
  await $.prompt.submit({ text: 'javítsd a tesztet' } as never)
  expect(opened).toEqual(['snake'])
  const out = await $.command.run({ command: 'jatek', args: '' } as never)
  expect(opened).toEqual(['snake', 'snake'])
  expect(JSON.stringify(out)).toContain('Játék megnyitva')
})

test('/jatek ki után a prompt nem nyitja', HU, async ($, on) => {
  const { opened, closed } = engine(on)
  await start($)
  const out = await $.command.run({ command: 'jatek', args: 'ki' } as never)
  expect(closed).toEqual(['snake'])
  expect(JSON.stringify(out)).toContain('kikapcsolva')
  await $.prompt.submit({ text: 'hello' } as never)
  expect(opened).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a kígyó megy, eszik nem, falnak ütközik, a gombok irányítanak (${surface})`, HU, async ($, on) => {
    engine(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'snake-pane', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Claude végzett/ })).toBeDefined()
    expect(await ui.find({ in: 'board', type: 'Text', text: /Nyomj egy irányt/ })).toBeDefined()
    expect(await ui.find({ in: 'board', type: 'Text', text: 'Pont: 0' })).toBeDefined()
    // Fej + kétszegmenses test, és egy alma a táblán.
    expect(await ui.find({ in: 'board', type: 'Text', text: '████' })).toBeDefined()
    expect(await ui.find({ in: 'board', type: 'Text', text: '● ' })).toBeDefined()

    // Indul jobbra; a tábla 19 széles, a fej a 6. oszlopban: 13 lépés (200 ms-onként) után falnak megy.
    await ui.key({ key: 'right', in: 'board' })
    await ui.advance(400)
    expect(await ui.find({ in: 'board', type: 'Text', text: /p: szünet/ })).toBeDefined()
    // Fordulás visszafelé tilos, a szünet megállítja.
    await ui.key({ key: ' ', in: 'board' })
    expect(await ui.find({ in: 'board', type: 'Text', text: /Szünet/ })).toBeDefined()
    // A panel gombja (hotkey p) folytatja.
    await ui.press({ key: 'ctl-pause' })
    expect(await ui.find({ in: 'board', type: 'Text', text: /p: szünet/ })).toBeDefined()
    await ui.advance(5_000)
    expect(await ui.find({ in: 'board', type: 'Text', text: /Vége/ })).toBeDefined()

    // Új játék r-rel.
    await ui.key({ key: 'r', in: 'board' })
    expect(await ui.find({ in: 'board', type: 'Text', text: /Nyomj egy irányt/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a turn vége szünetelteti a futó játékot', HU, async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ turnId: 't1', prompt: 'x' } as never)
  const ui = await $.ui.mount({ plugin: 'snake-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Claude dolgozik/ })).toBeDefined()
  await ui.key({ key: 'down', in: 'board' })
  await ui.advance(200)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(await ui.find({ type: 'Text', text: /Claude végzett/ })).toBeDefined()
  expect(await ui.find({ in: 'board', type: 'Text', text: /Claude végzett — szünet/ })).toBeDefined()
  await ui.unmount()
})

test('a rekordot elmenti, a hamisat eldobja, és sessionök között megtartja', HU, async ($, on) => {
  engine(on, { best: 7 })
  await start($)
  const ui = await $.ui.mount({ plugin: 'snake-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ in: 'board', type: 'Text', text: 'Rekord: 7' })).toBeDefined()
  await ui.post({ best: 12 }, { in: 'board' })
  await ui.post({ best: 'hack' }, { in: 'board' })
  await ui.post({ best: 3 }, { in: 'board' })
  expect(await ui.find({ in: 'board', type: 'Text', text: 'Rekord: 12' })).toBeDefined()
  await ui.unmount()
})
