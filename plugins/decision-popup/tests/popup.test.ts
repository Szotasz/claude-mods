import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HU = { options: { language: 'hu' } }

const dialog = ($: Engine, surface: 'terminal' | 'desktop', header: string) =>
  $.ui.render({
    surface,
    component: 'AskUserQuestion',
    requestId: 'q1',
    props: {
      tool: 'AskUserQuestion',
      questions: [{ question: 'Mehet?', header, multiSelect: false, options: [{ label: 'Megtiltom' }, { label: 'Engedélyezem' }] }],
    },
  } as never)

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never

const dontes = ($: Engine, args: string) =>
  $.command.run({ command: 'dontes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a kérdés keretben, címmel és gombsúgóval jelenik meg (${surface})`, HU, async ($, on) => {
    mock.store(on)
    on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
    const drawn = JSON.stringify(await dialog($, surface, 'Megközelítés'))
    // a beépített dialógus (engine node) a keretben marad
    expect(drawn).toContain('"type":"engine"')
    expect(drawn).toContain('Döntés kell · Megközelítés')
    expect(drawn).toContain('1–2')
    expect(drawn).toContain('"borderStyle":"round"')

    const guard = JSON.stringify(await dialog($, surface, 'Supabase-őr'))
    expect(guard).toContain('Az őr megállított egy műveletet')
    expect(guard).toContain('"borderColor":"error"')
  })
}

test('a rendszerprompt kéri az egygombos kérdést; kikapcsolva nem', HU, async ($, on) => {
  mock.store(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  const composed = await $.prompt.compose(COMPOSE)
  expect(JSON.stringify(composed)).toContain('AskUserQuestion')

  expect((await dontes($, 'ki')).text).toContain('kikapcsolva')
  expect(JSON.stringify(await $.prompt.compose(COMPOSE))).not.toContain('AskUserQuestion')
  expect(JSON.stringify(await dialog($, 'terminal', 'x'))).not.toContain('Döntés kell')
})
