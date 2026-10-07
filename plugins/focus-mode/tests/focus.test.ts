import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HU = { options: { language: 'hu' } }
const PLAN = 'mcp__focus-mode__plan'

const fokusz = ($: Engine, args: string) =>
  $.command.run({
    command: 'fokusz',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  } as never)

const band = ($: Engine, isWorking = true) =>
  $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 100, scroll: { top: 0, bodyRows: 19 } },
  } as never)

const row = ($: Engine, component: string, props: Record<string, unknown>) =>
  $.ui.render({ surface: 'terminal', component, requestId: 'r1', props } as never)

const texts = (tree: unknown) => JSON.stringify(tree)

test('a /fokusz be/ki kapcsol és szól róla', HU, async ($, on) => {
  mock.store(on)
  expect((await fokusz($, 'be')).text).toContain('Fókusz mód bekapcsolva')
  expect((await fokusz($, 'ki')).text).toContain('kikapcsolva')
  expect((await fokusz($, 'valami')).text).toContain('Használat')
})

test('a terv megjelenik a sávban: pipa, állapotsáv, összesítés', HU, async ($, on) => {
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['ALATTA'] }) as never)
  await fokusz($, 'be')
  await $.tool.call({
    tool: PLAN,
    tasks: [
      { title: 'Adatbázis séma', status: 'done' },
      { title: 'API végpont', status: 'in_progress', progress: 50 },
      { title: 'Tesztek', status: 'pending' },
    ],
  } as never)
  const drawn = texts(await band($))
  expect(drawn).toContain('1/3')
  expect(drawn).toContain('✓ ')
  expect(drawn).toContain('Adatbázis séma')
  expect(drawn).toContain('████░░░░ 50%')
  expect(drawn).toContain('○ Tesztek')
  expect(drawn).toContain('50%')
  // a sávot megosztja: az alatta lévő réteg (pl. eszköztár) is kirajzolódik
  expect(drawn).toContain('ALATTA')
})

test('fókusz módban az eszközhívások és a köztes szöveg rejtve, a végső válasz látszik', HU, async ($, on) => {
  mock.store(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['ENGINE'] }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await fokusz($, 'be')

  const tool = await row($, 'ToolUse', { tool_use_id: 'r1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false })
  expect(texts(tool)).not.toContain('ENGINE')

  const mid = await row($, 'AssistantMessage', { text: 'Most megnézem a fájlokat.', isFirstOfReply: true })
  expect(texts(mid)).not.toContain('ENGINE')

  await $.turn.complete({ answer: 'Kész: az API működik.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  const final = await row($, 'AssistantMessage', { text: 'Kész: az API működik.', isFirstOfReply: true })
  expect(texts(final)).toContain('ENGINE')

  const prompt = await row($, 'UserMessage', { text: 'Csináld meg az API-t', origin: { kind: 'composer' }, isExpanded: false })
  expect(texts(prompt)).not.toContain('ENGINE')
  const output = await row($, 'CommandOutput', { command: 'limitsav', args: 'ki', text: 'Limitsáv kikapcsolva.', isErrored: false })
  expect(texts(output)).not.toContain('ENGINE')

  await fokusz($, 'ki')
  expect(texts(await row($, 'UserMessage', { text: 'Csináld meg az API-t', origin: { kind: 'composer' }, isExpanded: false }))).toContain('ENGINE')
  expect(texts(await row($, 'AssistantMessage', { text: 'Most megnézem a fájlokat.', isFirstOfReply: true }))).toContain('ENGINE')
})

test('kikapcsolva a sáv a motoré', HU, async ($, on) => {
  mock.store(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['ENGINE'] }) as never)
  expect(texts(await band($))).toContain('ENGINE')
})

test('angolul is megy', { options: { language: 'en' } }, async ($, on) => {
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['ALATTA'] }) as never)
  await fokusz($, 'on')
  expect(texts(await band($))).toContain('Focus mode')
})

