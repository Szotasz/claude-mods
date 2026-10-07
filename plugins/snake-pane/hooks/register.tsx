import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SnakeCmd, SnakeProps } from '../types'

const PANE = 'snake'
const isOn = atom({ plugin: 'snake-pane', key: 'isOn' } as const, true)
const working = atom({ plugin: 'snake-pane', key: 'working' } as const, false)
// A panel gombjainak utolsó parancsa; a kígyó a sorszámból látja, hogy új.
const cmd = atom({ plugin: 'snake-pane', key: 'cmd' } as const, null)
const best = atom({ plugin: 'snake-pane', key: 'best' } as const, 0)

type Lang = 'hu' | 'en'

const STRINGS = {
  hu: {
    title: '🐍 Kígyó',
    command: 'Kígyó játék oldalt, amíg Claude dolgozik',
    usage: 'Használat: /jatek [be|ki]',
    opened: 'Játék megnyitva. Kattints a táblára, és nyilakkal irányíts.',
    closed: 'Játék kikapcsolva.',
    working: '⏳ Claude dolgozik…',
    idle: '✔ Claude végzett',
    hint: 'Kattints a táblára (nyilak, wasd, szóköz), vagy ctrl+x tab, aztán w a s d p r',
    pause: 'szünet',
    restart: 'új',
  },
  en: {
    title: '🐍 Snake',
    command: 'Snake in the side pane while Claude works',
    usage: 'Usage: /jatek [on|off]',
    opened: 'Game opened. Click the board and steer with the arrows.',
    closed: 'Game turned off.',
    working: '⏳ Claude is working…',
    idle: '✔ Claude is done',
    hint: 'Click the board (arrows, wasd, space), or ctrl+x tab, then w a s d p r',
    pause: 'pause',
    restart: 'new',
  },
}

let lang: Lang = 'en'
const t = () => STRINGS[lang]
// A person zárta be a panelt ebben a sessionben: a promptok már nem nyitják újra (a parancs igen).
let dismissed = false

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'hu' || setting === 'en') return setting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}

const background = (work: Promise<unknown>) => void work.catch(() => undefined)

// Be/ki kapcsolás: a /jatek parancs és az eszköztár (tool-hub) gombja is ezt hívja.
async function setOn($: EngineInterface, wanted: boolean): Promise<string> {
  await update($, isOn, () => wanted)
  await $.store.set('isOn', wanted)
  if (!wanted) {
    await $.ui.close({ id: PANE })
    return t().closed
  }
  dismissed = false
  await $.ui.open({ id: PANE, title: t().title })
  return t().opened
}

const press = ($: EngineInterface, c: SnakeCmd) =>
  update($, cmd, prev => ({ c, n: (prev?.n ?? 0) + 1 })).then(() => undefined)

const CONTROLS: { c: SnakeCmd; hotkey: string; label: () => string }[] = [
  { c: 'up', hotkey: 'w', label: () => '↑' },
  { c: 'left', hotkey: 'a', label: () => '←' },
  { c: 'down', hotkey: 's', label: () => '↓' },
  { c: 'right', hotkey: 'd', label: () => '→' },
  { c: 'pause', hotkey: 'p', label: () => t().pause },
  { c: 'restart', hotkey: 'r', label: () => t().restart },
]

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') lang = options.language

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) !== false
    await update($, isOn, () => saved)
    const record = await $.store.get('best')
    if (typeof record === 'number') await update($, best, () => record)
    await $.command.register({
      name: 'jatek',
      description: t().command,
      argumentHint: lang === 'hu' ? '[be|ki]' : '[on|off]',
      immediate: true,
    })
    await $.command.register({ name: 'játék', description: t().command, immediate: true }).catch(() => undefined)
    return started
  })

  on('command.run', { command: ['jatek', 'játék'] }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && !['be', 'on', 'ki', 'off'].includes(arg)) return { text: t().usage }
    return { text: await setOn($, !['ki', 'off'].includes(arg)) }
  })

  // Az eszköztár gombja parancs nélkül kapcsol (így nem marad parancssor a transcriptben).
  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'game') await setOn($, e.value.on)
    return done
  })

  // Promptküldéskor nyílik: ez a person saját lépése, így keskeny terminálon is helyet kap.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    if (options.autoOpen !== false && !dismissed && (await read($, isOn))) {
      background($.ui.open({ id: PANE, title: t().title }))
    }
    return done
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await update($, working, () => false)
    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') dismissed = true
    return next(e)
  })

  // A kígyó új rekordja: tartósan mentjük, és visszaadjuk neki a props-ban.
  on('ui.message', async ($, e) => {
    const data = e.data as { best?: unknown } | null
    const score = typeof data?.best === 'number' && Number.isFinite(data.best) ? Math.floor(data.best) : undefined
    if (score !== undefined && score > (await read($, best))) {
      await update($, best, () => score)
      await $.store.set('best', score)
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Client csak a terminálon és a desktopon van: máshol csak az állapotsor látszik.
    const Client = 'Client' in elements ? elements.Client : undefined
    const isWorking = await read($, working)
    const status = (
      <Text key="status" color={isWorking ? 'yellow' : 'green'} bold>
        {isWorking ? t().working : t().idle}
      </Text>
    )
    if (Client === undefined) {
      return <Box flexDirection="column">{status}</Box>
    }
    // Négyzetes cellák: 2 karakter széles egy mező. A Client alatt a gombok és a súgó két sora.
    const props: SnakeProps = {
      w: Math.max(8, Math.min(30, Math.floor((e.props.bodyColumns - 2) / 2))),
      h: Math.max(6, Math.min(20, e.props.scroll.bodyRows - 7)),
      cmd: await read($, cmd),
      working: isWorking,
      best: await read($, best),
      lang,
    }
    return (
      <Box flexDirection="column">
        {status}
        <Client key="board" module="./snake.tsx" props={props} />
        <Box flexDirection="row" gap={1}>
          {CONTROLS.map(control => (
            <Button
              key={`ctl-${control.c}`}
              plain
              hotkey={control.hotkey}
              label={control.label()}
              onPress={() => press($, control.c)}
            />
          ))}
        </Box>
        <Text key="hint" dimColor wrap="wrap">{t().hint}</Text>
      </Box>
    )
  })
}
