import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { SnakeCmd, SnakeProps } from '../types'

// A kígyó a rajzoló szálon fut (Client surface modul): saját órája és billentyűfigyelője van,
// a hooks modult csak a rekord mentésére hívja (post). Így a játék nem terheli a motort.

type Dir = 'up' | 'down' | 'left' | 'right'
type Cell = [number, number]
type Phase = 'ready' | 'run' | 'pause' | 'over'

type Game = {
  w: number
  h: number
  snake: Cell[] // fej elöl
  dir: Dir
  queue: Dir[] // a két lépés között lenyomott irányok, sorban
  food: Cell
  score: number
  best: number
  phase: Phase
  lastCmd: number
  wasWorking: boolean
  notice?: 'done'
}

const FRAME_MS = 50
const DELTA: Record<Dir, Cell> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

const STRINGS = {
  hu: {
    score: 'Pont',
    best: 'Rekord',
    ready: 'Nyomj egy irányt (nyilak / wasd) a kezdéshez',
    paused: 'Szünet — szóköz vagy p a folytatáshoz',
    done: '✔ Claude végzett — szünet. Szóköz: folytatás',
    over: (s: number, record: boolean) => `Vége: ${s} pont${record ? ' — új rekord!' : ''} · r vagy irány: új játék`,
    run: 'p: szünet · r: újra',
  },
  en: {
    score: 'Score',
    best: 'Best',
    ready: 'Press a direction (arrows / wasd) to start',
    paused: 'Paused — space or p to resume',
    done: '✔ Claude finished — paused. Space: resume',
    over: (s: number, record: boolean) => `Game over: ${s}${record ? ' — new best!' : ''} · r or a direction: new game`,
    run: 'p: pause · r: restart',
  },
}

// Lépésköz képkockában: 200 ms-ról 100 ms-ig gyorsul, ahogy nő a pontszám.
const framesPerStep = (score: number) => Math.max(2, 4 - Math.floor(score / 6))

const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

function placeFood(w: number, h: number, snake: Cell[]): Cell {
  const free: Cell[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!snake.some(c => c[0] === x && c[1] === y)) free.push([x, y])
  return free[Math.floor(Math.random() * free.length)] ?? [0, 0]
}

function newGame(props: SnakeProps, prev?: Game): Game {
  const w = props.w
  const h = props.h
  const y = Math.floor(h / 2)
  const x = Math.floor(w / 3)
  const snake: Cell[] = [[x, y], [x - 1, y], [x - 2, y]]
  return {
    w,
    h,
    snake,
    dir: 'right',
    queue: [],
    food: placeFood(w, h, snake),
    score: 0,
    best: Math.max(props.best, prev?.best ?? 0),
    phase: 'ready',
    lastCmd: prev?.lastCmd ?? props.cmd?.n ?? 0,
    wasWorking: props.working,
  }
}

function step(g: Game): { game: Game; record?: number } {
  const [dir, ...queue] = g.queue.length > 0 ? g.queue : [g.dir]
  const [dx, dy] = DELTA[dir!]
  const head: Cell = [g.snake[0]![0] + dx, g.snake[0]![1] + dy]
  const eats = same(head, g.food)
  const body = eats ? g.snake : g.snake.slice(0, -1)
  const dead = head[0] < 0 || head[1] < 0 || head[0] >= g.w || head[1] >= g.h || body.some(c => same(c, head))
  if (dead) {
    const record = g.score > g.best ? g.score : undefined
    return { game: { ...g, dir: dir!, queue: [], phase: 'over', best: Math.max(g.best, g.score) }, record }
  }
  const snake = [head, ...body]
  return {
    game: {
      ...g,
      dir: dir!,
      queue,
      snake,
      score: eats ? g.score + 1 : g.score,
      food: eats ? placeFood(g.w, g.h, snake) : g.food,
    },
  }
}

function apply(g: Game, cmd: SnakeCmd, props: SnakeProps): Game {
  if (cmd === 'restart') return { ...newGame(props, g), lastCmd: g.lastCmd }
  if (cmd === 'pause') {
    if (g.phase === 'run') return { ...g, phase: 'pause' }
    if (g.phase === 'pause') return { ...g, phase: 'run', notice: undefined }
    return g
  }
  if (g.phase === 'over') return apply({ ...newGame(props, g), lastCmd: g.lastCmd }, cmd, props)
  const last = g.queue.at(-1) ?? g.dir
  const queue = cmd === last || cmd === OPPOSITE[last] || g.queue.length >= 3 ? g.queue : [...g.queue, cmd]
  return { ...g, queue, phase: 'run', notice: undefined }
}

function toCmd(event: ClientKeyEvent): SnakeCmd | undefined {
  if (event.ctrl || event.meta) return undefined
  switch (event.key.toLowerCase()) {
    case 'up': case 'w': case 'k': return 'up'
    case 'down': case 's': case 'j': return 'down'
    case 'left': case 'a': case 'h': return 'left'
    case 'right': case 'd': case 'l': return 'right'
    case ' ': case 'space': case 'p': return 'pause'
    case 'r': return 'restart'
    default: return undefined
  }
}

// Pluginonként egy példány fut, így a legutóbbi props modulszinten tartható: az óra és a
// billentyűfigyelő az első hívásban indul, de mindig a friss méretet és rekordot látja.
let latest: SnakeProps | undefined

const Snake: ClientModule<SnakeProps, Game> = (props, surface) => {
  const { Box, Text } = surface.elements
  const t = STRINGS[props.lang]
  latest = props
  const current = () => surface.state ?? newGame(latest ?? props)

  if (surface.state === undefined) {
    // A képkocka-számláló nem állapot: csak a lépés rajzol újra, a köztes képkocka nem.
    let frame = 0
    surface.every(FRAME_MS, () => {
      const g = current()
      if (g.phase !== 'run') return
      frame += 1
      if (frame % framesPerStep(g.score) !== 0) return
      const { game, record } = step(g)
      surface.setState(game)
      if (record !== undefined) surface.post({ best: record })
    })
    surface.onKey(event => {
      const cmd = toCmd(event)
      if (cmd !== undefined) surface.setState(apply(current(), cmd, latest ?? props))
    })
    surface.setState(newGame(props))
  }

  let g = current()
  // Új parancs a panel gombjairól (props-ban jön), és a turn vége: Claude végzett, szünet.
  let changed = false
  if (props.cmd && props.cmd.n > g.lastCmd) {
    g = { ...apply(g, props.cmd.c, props), lastCmd: props.cmd.n }
    changed = true
  }
  if (g.wasWorking !== props.working) {
    g = { ...g, wasWorking: props.working, ...(!props.working && g.phase === 'run' ? { phase: 'pause', notice: 'done' } : {}) }
    changed = true
  }
  if (props.best > g.best) {
    g = { ...g, best: props.best }
    changed = true
  }
  if (changed && surface.state !== undefined) surface.setState(g)

  const rows = []
  for (let y = 0; y < g.h; y++) {
    const runs: { kind: string; text: string }[] = []
    for (let x = 0; x < g.w; x++) {
      const at: Cell = [x, y]
      const kind = same(g.snake[0]!, at) ? 'head' : g.snake.some(c => same(c, at)) ? 'body' : same(g.food, at) ? 'food' : 'empty'
      const text = kind === 'food' ? '● ' : kind === 'empty' ? '  ' : '██'
      const last = runs.at(-1)
      if (last?.kind === kind) last.text += text
      else runs.push({ kind, text })
    }
    rows.push(
      <Box key={`r${y}`} flexDirection="row">
        {runs.map((run, i) => (
          <Text
            key={`r${y}-${i}`}
            color={run.kind === 'head' ? (g.phase === 'over' ? 'red' : 'greenBright') : run.kind === 'body' ? 'green' : run.kind === 'food' ? 'redBright' : undefined}
          >
            {run.text}
          </Text>
        ))}
      </Box>,
    )
  }

  const message =
    g.phase === 'ready' ? t.ready
    : g.phase === 'pause' ? (g.notice === 'done' ? t.done : t.paused)
    : g.phase === 'over' ? t.over(g.score, g.score > 0 && g.score >= g.best)
    : t.run

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text key="score" bold>{`${t.score}: ${g.score}`}</Text>
        <Text key="best" color="yellow">{`${t.best}: ${g.best}`}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={g.phase === 'run' ? 'green' : 'gray'} width={g.w * 2 + 2}>
        {rows}
      </Box>
      <Text key="message" dimColor={g.phase === 'run'} color={g.notice === 'done' ? 'green' : undefined} wrap="truncate-end">
        {message}
      </Text>
    </Box>
  )
}

export default Snake
