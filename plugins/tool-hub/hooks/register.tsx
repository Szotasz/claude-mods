import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Az eszköztár a prompt fölötti sávban nyílik (nem oldalpanelként).
const isOpen = atom({ plugin: 'tool-hub', key: 'isOpen' } as const, false)
// Kapcsolási kérés a modoknak: parancsfuttatás helyett, mert az minden gombnyomásnál sort hagyna a transcriptben.
const request = atom({ plugin: 'tool-hub', key: 'request' } as const, null)

type Lang = 'hu' | 'en'

// A kapcsolható modok. Új mod felvétele: egy sor ide, egy ág a stateOf-ba, és az `isOn` kulcsa a types/index.d.ts-be.
// A mod maga írja az állapotát; a gomb a hub `request` értékét írja, amit a mod state.set hookja átvesz.
// A `command` csak tájékoztató: kézzel így kapcsolható.
const TOOLS = [
  {
    id: 'focus',
    command: 'fokusz',
    label: { hu: 'Fókusz mód', en: 'Focus mode' },
    detail: {
      hu: 'Csak a részfeladatok listája és a végső válasz látszik',
      en: 'Only the subtask list and the final answer are shown',
    },
  },
  {
    id: 'limits',
    command: 'limitsav',
    label: { hu: 'Limitsáv', en: 'Usage bar' },
    detail: {
      hu: 'Alsó sáv: 5 órás és heti limit, kontextusablak',
      en: 'Bottom bar: 5-hour and weekly limits, context window',
    },
  },
  {
    id: 'header',
    command: 'hasznalat',
    label: { hu: 'Használati sáv', en: 'Usage band' },
    detail: {
      hu: 'Prompt fölött: kontextus kategóriánként színezve, 5 órás és heti limit',
      en: 'Above the prompt: context by category in colours, 5-hour and weekly limits',
    },
  },
  {
    id: 'project',
    command: 'project',
    label: { hu: 'Projektpanel', en: 'Project pane' },
    detail: {
      hu: 'GitHub, CI, Netlify és Supabase állapot oldalt',
      en: 'GitHub, CI, Netlify and Supabase status at the side',
    },
  },
  {
    id: 'game',
    command: 'jatek',
    label: { hu: 'Kígyó játék', en: 'Snake game' },
    detail: {
      hu: 'Oldalt nyílik promptküldéskor, amíg Claude dolgozik',
      en: 'Opens at the side when you send a prompt, while Claude works',
    },
  },
] as const

type Tool = (typeof TOOLS)[number]

const STRINGS = {
  hu: {
    button: '⚙ Eszközök',
    title: 'Szabolcs eszközei',
    command: 'Megnyitja az eszköztárat (modok be/ki)',
    opened: 'Eszköztár megnyitva a prompt fölött.',
    closed: 'Eszköztár bezárva.',
    on: 'BE',
    off: 'KI',
    missing: 'nincs betöltve',
    turnOn: 'Bekapcsol',
    turnOff: 'Kikapcsol',
    hint: 'kattintás, vagy ctrl+x tab után szám',
    close: 'Bezár',
  },
  en: {
    button: '⚙ Tools',
    title: "Szabolcs's tools",
    command: 'Open the toolbox (mods on/off)',
    opened: 'Toolbox opened above the prompt.',
    closed: 'Toolbox closed.',
    on: 'ON',
    off: 'OFF',
    missing: 'not loaded',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    hint: 'click, or ctrl+x tab then a digit',
    close: 'Close',
  },
}

let lang: Lang = 'en'
const t = () => STRINGS[lang]

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

// A hivatkozásoknak szó szerint kell a forrásban állniuk (így listázható, mit olvas a mod).
const FOCUS = { plugin: 'focus-mode', key: 'isOn' } as const
const LIMITS = { plugin: 'usage-band', key: 'isOn' } as const
const HEADER = { plugin: 'usage-header', key: 'isOn' } as const
const PROJECT = { plugin: 'project-pane', key: 'isOn' } as const
const GAME = { plugin: 'snake-pane', key: 'isOn' } as const

// undefined: a mod nincs betöltve (még sosem írta az állapotát).
async function stateOf($: EngineInterface, tool: Tool): Promise<boolean | undefined> {
  switch (tool.id) {
    case 'focus':
      return (await $.state.get(FOCUS)).value
    case 'limits':
      return (await $.state.get(LIMITS)).value
    case 'header':
      return (await $.state.get(HEADER)).value
    case 'project':
      return (await $.state.get(PROJECT)).value
    case 'game':
      return (await $.state.get(GAME)).value
  }
}

const toggleOpen = ($: EngineInterface) => update($, isOpen, open => !open)

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await pickLanguage($, options.language)
    await $.command.register({ name: 'eszkozok', description: t().command, immediate: true })
    // Ékezettel is: ha a motor nem fogad el ékezetes nevet, marad az ékezet nélküli.
    await $.command.register({ name: 'eszközök', description: t().command, immediate: true }).catch(() => undefined)
    return started
  })

  on('command.run', { command: ['eszkozok', 'eszközök'] }, async $ => {
    await toggleOpen($)
    return { text: (await read($, isOpen)) ? t().opened : t().closed }
  })

  // A prompt alatti lábléc jobb oldala: a motor módfeliratai, mellettük az eszköztár gombja.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const focus = TOOLS[0]
    const modes = (await stateOf($, focus)) === true ? [...e.props.modes, focus.label[lang]] : e.props.modes
    return (
      <Box flexDirection="row" gap={1}>
        {modes.length > 0 ? <Text dimColor>{modes.join(' & ')}</Text> : null}
        <Button key="open-hub" label={t().button} onPress={() => toggleOpen($).then(() => undefined)} />
      </Box>
    )
  })

  // A sávot más mod is rajzolhatja (fókusz mód): az övé alá tesszük a kapcsolókat.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = []
    for (const [i, tool] of TOOLS.entries()) {
      const state = await stateOf($, tool)
      rows.push(
        <Box key={`row-${tool.id}`} flexDirection="row" gap={1}>
          <Text bold>{`${i + 1}. ${tool.label[lang]}`}</Text>
          {state === undefined ? (
            <Text dimColor>{t().missing}</Text>
          ) : (
            <Box flexDirection="row" gap={1}>
              <Text color={state ? 'green' : 'gray'} bold>{state ? `● ${t().on}` : `○ ${t().off}`}</Text>
              <Button
                key={`toggle-${tool.id}`}
                label={state ? t().turnOff : t().turnOn}
                hotkey={String(i + 1)}
                onPress={() => update($, request, prev => ({ tool: tool.id, on: !state, n: (prev?.n ?? 0) + 1 })).then(() => undefined)}
              />
            </Box>
          )}
          <Text dimColor wrap="truncate-end">{`· ${tool.detail[lang]}`}</Text>
        </Box>,
      )
    }
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" gap={1}>
          <Text color="cyan" bold>{`⚙ ${t().title}`}</Text>
          <Text dimColor>{t().hint}</Text>
          <Button key="close-hub" label={t().close} onPress={() => update($, isOpen, () => false).then(() => undefined)} />
        </Box>
        {rows}
      </Box>
    )
  })
}
