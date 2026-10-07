import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task, TaskStatus } from '../types'

const isOn = atom({ plugin: 'focus-mode', key: 'isOn' } as const, false)
const tasks = atom({ plugin: 'focus-mode', key: 'tasks' } as const, [])
// A turnök végső válaszai: csak ezek az asszisztens-sorok látszanak fókusz módban.
const answers = atom({ plugin: 'focus-mode', key: 'answers' } as const, [])

const PLAN_TOOL = 'mcp__focus-mode__plan'
const KEEP_ANSWERS = 100
const WIDTH = 12

type Strings = {
  title: string
  done: string
  waiting: string
  idle: string
  on: string
  off: string
  usage: string
}

const STRINGS: Record<'hu' | 'en', Strings> = {
  hu: {
    title: 'Fókusz mód',
    done: 'kész',
    waiting: 'a részfeladatok hamarosan megjelennek…',
    idle: 'bekapcsolva · /fokusz ki a kikapcsoláshoz',
    on: 'Fókusz mód bekapcsolva: csak a részfeladatok és a végső válasz látszik.',
    off: 'Fókusz mód kikapcsolva: újra látszik minden lépés.',
    usage: 'Használat: /fokusz [be|ki]',
  },
  en: {
    title: 'Focus mode',
    done: 'done',
    waiting: 'subtasks will show up shortly…',
    idle: 'on · /fokusz off to turn it off',
    on: 'Focus mode on: only the subtasks and the final answer are shown.',
    off: 'Focus mode off: every step is shown again.',
    usage: 'Usage: /fokusz [on|off]',
  },
}

let t: Strings = STRINGS.en

const PROMPT = `Focus mode is on. The person is not watching the transcript: your tool calls, their results and any text you write before the end of the turn are hidden from them. They only see a subtask list drawn from the ${PLAN_TOOL} tool, and your final message of the turn.

- For any request that takes more than one step, first call ${PLAN_TOOL} with the subtasks of the job (3-8 short items, written in the person's language), before any other tool.
- Call it again whenever a subtask starts, makes notable progress (estimate \`progress\` 0-100) or finishes. Always send the whole list.
- Before you end the turn, every finished subtask must be marked done.
- Make the final message a short summary of what was done, plus anything the person must decide or do. Questions for the person go in that final message or through AskUserQuestion; nothing else you write mid-turn reaches them.`

const PLAN_SPEC = {
  name: 'plan',
  description:
    'Sets the subtask list the person sees in focus mode, replacing the previous one. Send every subtask each time, with its status and an estimated progress percentage.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short subtask name, in the person\'s language.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            progress: { type: 'number', minimum: 0, maximum: 100, description: 'Estimated percent done.' },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['tasks'],
  },
}

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'done']

// A modell bemenetét tűrően olvassuk: hiányzó progress → státuszból becsült érték.
export function parseTasks(input: unknown): Task[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((raw): Task[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const { title, status, progress } = raw as Record<string, unknown>
    if (typeof title !== 'string' || title.trim() === '') return []
    const s: TaskStatus = STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : 'pending'
    const fallback = s === 'done' ? 100 : 0
    const p = typeof progress === 'number' && Number.isFinite(progress) ? progress : fallback
    return [{ title: title.trim(), status: s, progress: s === 'done' ? 100 : Math.max(0, Math.min(99, Math.round(p))) }]
  })
}

export function bar(percent: number, width = WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function overall(list: readonly Task[]): number {
  if (list.length === 0) return 0
  return Math.round(list.reduce((sum, task) => sum + task.progress, 0) / list.length)
}

export function isAnswer(text: string, list: readonly string[]): boolean {
  const shown = text.trim()
  if (shown === '') return false
  return list.some(a => a.trim() === shown || a.includes(shown))
}

async function pickLanguage($: EngineInterface, setting: unknown): Promise<Strings> {
  if (setting === 'hu' || setting === 'en') return STRINGS[setting]
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  return locale.toLowerCase().startsWith('hu') ? STRINGS.hu : STRINGS.en
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, isOn, () => value)
  await $.store.set('isOn', value)
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') t = STRINGS[options.language]

  on('session.start', async ($, e, next) => {
    t = await pickLanguage($, options.language)
    const saved = (await $.store.get('isOn')) === true
    await update($, isOn, () => saved)
    await $.tool.register(PLAN_SPEC)
    await $.command.register({
      name: 'fokusz',
      description: t === STRINGS.hu ? 'Fókusz mód be/ki: csak részfeladatok és végső válasz' : 'Focus mode on/off: subtasks and final answer only',
      argumentHint: t === STRINGS.hu ? '[be|ki]' : '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'fokusz' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted = ['be', 'on'].includes(arg) ? true : ['ki', 'off'].includes(arg) ? false : arg === '' ? !(await read($, isOn)) : null
    if (wanted === null) return { text: t.usage }
    await setOn($, wanted)
    return { text: wanted ? t.on : t.off }
  })

  // Az eszköztár gombja parancs nélkül kapcsol (így nem marad parancssor a transcriptben).
  on('state.set', { plugin: 'tool-hub', key: 'request' }, async ($, e, next) => {
    const done = await next(e)
    if (e.value?.tool === 'focus') await setOn($, e.value.on)
    return done
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const list = parseTasks(e.tasks)
    await update($, tasks, () => list)
    const done = list.filter(task => task.status === 'done').length
    return { result: `Plan updated: ${done}/${list.length} done.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed
    return { sections: [...composed.sections, { id: 'focus-mode:instructions', text: PROMPT, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer.trim() !== '') {
      const answer = e.answer
      await update($, answers, list => [...list, answer].slice(-KEEP_ANSWERS))
    }
    return next(e)
  })

  // Az elrejtett sorok helyére egy üres Box kerül: eszközhívások, a felhasználó promptjai és a parancsok kimenete.
  on('ui.render', { component: ['ToolUse', 'ToolResult', 'ToolGroup', 'UserMessage', 'CommandOutput'] }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.props.isSummary !== true && isAnswer(e.props.text, await read($, answers))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const list = await read($, tasks)
    // Más mod (pl. az eszköztár) is rajzolhat a sávba: az övét a lista alá tesszük.
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan" bold>{`◆ ${t.title}`}</Text>
            <Text dimColor>{` ${e.props.isWorking ? t.waiting : t.idle}`}</Text>
          </Box>
          {below}
        </Box>
      )
    }

    const done = list.filter(task => task.status === 'done').length
    const total = overall(list)
    const titleRoom = Math.max(10, columns - WIDTH - 12)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>{`◆ ${t.title}`}</Text>
          <Text dimColor>{`  ${done}/${list.length} ${t.done}  `}</Text>
          <Text color={total === 100 ? 'green' : 'cyan'}>{`${bar(total)} ${total}%`}</Text>
        </Box>
        {list.map((task, i) => {
          const name = task.title.length > titleRoom ? `${task.title.slice(0, titleRoom - 1)}…` : task.title
          if (task.status === 'done') {
            return (
              <Box key={`t${i}`}>
                <Text color="green">  ✓ </Text>
                <Text dimColor strikethrough>{name}</Text>
              </Box>
            )
          }
          if (task.status === 'in_progress') {
            return (
              <Box key={`t${i}`}>
                <Text color="yellow">  ▸ </Text>
                <Text bold>{`${name} `}</Text>
                <Text color="yellow">{`${bar(task.progress, 8)} ${task.progress}%`}</Text>
              </Box>
            )
          }
          return (
            <Box key={`t${i}`}>
              <Text dimColor>{`  ○ ${name}`}</Text>
            </Box>
          )
        })}
        {below}
      </Box>
    )
  })
}
