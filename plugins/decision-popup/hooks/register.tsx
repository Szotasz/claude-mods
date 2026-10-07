import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isOn = atom({ plugin: 'decision-popup', key: 'isOn' } as const, true)

type Lang = 'hu' | 'en'

// Az őr-modok kérdéseinek fejléce: ezek piros keretet kapnak.
const GUARD_HEADERS = new Set(['Supabase-őr', 'Supabase', 'Push-őr', 'Push guard'])

const STRINGS = {
  hu: {
    title: 'Döntés kell',
    guard: 'Az őr megállított egy műveletet',
    hint: (n: number) => (n > 1 ? `Válassz egy gombnyomással: 1–${n} · Esc = elvetés` : 'Esc = elvetés'),
    command: 'Döntési felugró be/ki: a döntések egygombos kérdésként jönnek',
    on: 'Döntési felugró bekapcsolva: a döntéseket egygombos kérdésként kapod.',
    off: 'Döntési felugró kikapcsolva.',
    usage: 'Használat: /dontes [be|ki]',
  },
  en: {
    title: 'Decision needed',
    guard: 'A guard stopped an action',
    hint: (n: number) => (n > 1 ? `Answer with one key: 1–${n} · Esc dismisses` : 'Esc dismisses'),
    command: 'Decision popup on/off: decisions come as one-key questions',
    on: 'Decision popup on: decisions come to you as one-key questions.',
    off: 'Decision popup off.',
    usage: 'Usage: /dontes [on|off]',
  },
}

let lang: Lang = 'en'
const t = () => STRINGS[lang]

const PROMPT = `Decisions go to the person as a one-key popup.

- Whenever you need the person to choose (approve or refuse an action, pick between approaches, confirm something irreversible or outward-facing, answer yes/no), ask with the AskUserQuestion tool instead of asking in prose: one question, 2-4 short option labels (1-4 words), the recommended or safer option first, marked "(Recommended)" when you recommend one. They answer with a single key press.
- Put the facts the choice depends on in the question itself (what, where, why it matters), since that may be all they read.
- Do not invent a choice where a sensible default exists; decide those yourself and say what you chose.
- If a tool call is refused with a message that the person did not allow it, do not retry it another way.`

type Question = { header?: unknown; options?: unknown }

export function firstQuestion(questions: readonly unknown[]): { header: string; options: number } {
  const q = (questions[0] ?? {}) as Question
  return {
    header: typeof q.header === 'string' ? q.header : '',
    options: Array.isArray(q.options) ? q.options.length : 0,
  }
}

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, isOn, () => value)
  await $.store.set('isOn', value)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    lang = await pickLanguage($, options.language)
    const saved = await $.store.get('isOn')
    await update($, isOn, () => saved !== false)
    await $.command.register({
      name: 'dontes',
      description: t().command,
      argumentHint: lang === 'hu' ? '[be|ki]' : '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'dontes' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t().usage }
    await setOn($, wanted)
    return { text: wanted ? t().on : t().off }
  })

  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'decision') await setOn($, e.value.on)
    return done
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed
    return { sections: [...composed.sections, { id: 'decision-popup:instructions', text: PROMPT, scope: 'session' as const }] }
  })

  // A kérdés-dialógus keretet, címet és gombsúgót kap (csak fölé rajzolhatunk); az őrök kérdése pirosat.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const dialog = await next(e)
    if (!(await read($, isOn))) return dialog
    const { Box, Text } = $.ui.resolve(e)
    const q = firstQuestion(e.props.questions)
    const isGuard = GUARD_HEADERS.has(q.header)
    const color = isGuard ? 'error' : 'permission'
    const title = isGuard ? `🛡  ${t().guard} · ${q.header}` : `◆ ${t().title}${q.header === '' ? '' : ` · ${q.header}`}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box>
          <Text bold color={color}>{title}</Text>
          <Text dimColor>{`  ${t().hint(q.options)}`}</Text>
        </Box>
        {dialog}
      </Box>
    )
  })
}
