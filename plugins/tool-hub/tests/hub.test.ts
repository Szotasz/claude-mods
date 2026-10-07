import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HU = { options: { language: 'hu' } }

// A kapcsolt modok helyett: a fókusz mód be, a limitsáv ki, a projektpanel nincs betöltve.
// A saját isOpen értékét a valódi állapottár tartja.
function engine(on: On, states: Record<string, boolean | undefined>) {
  const ran: string[] = []
  on('state.get', ($, e, next) => (e.plugin === 'tool-hub' ? next(e) : ({ value: { value: states[e.plugin], version: 1 } }) as never))
  // A gomb nem futtat parancsot: a request értéket írja, ezt figyeljük.
  on('state.set', ($, e, next) => {
    const v = e.value as { tool?: string; on?: boolean } | null
    if (e.key === 'request' && v?.tool) ran.push(`${v.tool} ${v.on ? 'be' : 'ki'}`)
    return next(e)
  })
  on('command.run', ($, e) => { ran.push(`parancs: ${e.command}`); return { text: 'ok' } })
  // A sáv alatti réteg: egy másik mod vagy a motor saját rajza.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Text, { key: 'below' }, 'ALATTA') as never)
  return { ran }
}

const STATES = { 'focus-mode': true, 'usage-band': false, 'project-pane': undefined, 'snake-pane': false }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a lábléc gombja a sávban nyitja és zárja az eszköztárat (${surface})`, HU, async ($, on) => {
    engine(on, STATES)
    const footer = await $.ui.mount({ plugin: 'tool-hub', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: /Fókusz mód/ })).toBeDefined()
    const band = await $.ui.mount({ plugin: 'tool-hub', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'toggle-focus' })).toBeUndefined()

    await footer.press({ key: 'open-hub' })
    expect(await band.find({ key: 'toggle-focus' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'ALATTA' })).toBeDefined()

    await band.press({ key: 'close-hub' })
    expect(await band.find({ key: 'toggle-focus' })).toBeUndefined()
    await footer.unmount()
    await band.unmount()
  })

  test(`a sáv kapcsol: be→ki, ki→be, hiányzó mod nem kapcsolható (${surface})`, HU, async ($, on) => {
    const s = engine(on, STATES)
    expect((await $.command.run({ command: 'eszkozok', args: '' } as never)).text).toContain('megnyitva')
    const band = await $.ui.mount({ plugin: 'tool-hub', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: '● BE' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '○ KI' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'nincs betöltve' })).toBeDefined()
    expect(await band.find({ key: 'toggle-project' })).toBeUndefined()
    await band.press({ key: 'toggle-focus' })
    await band.press({ key: 'toggle-limits' })
    expect(await band.find({ type: 'Text', text: /Kígyó játék/ })).toBeDefined()
    await band.press({ key: 'toggle-game' })
    expect(s.ran).toEqual(['focus ki', 'limits be', 'game be'])
    await band.unmount()
  })
}
