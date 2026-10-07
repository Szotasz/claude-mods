export type SnakeCmd = 'up' | 'down' | 'left' | 'right' | 'pause' | 'restart'

// Amit a panel a kígyó Client moduljának átad (props): táblaméret, a panel gombjainak utolsó
// parancsa (n sorszámmal, hogy ugyanaz a gomb kétszer is számítson), Claude dolgozik-e, rekord, nyelv.
export type SnakeProps = {
  w: number
  h: number
  cmd: { c: SnakeCmd; n: number } | null
  working: boolean
  best: number
  lang: 'hu' | 'en'
}

// Az eszköztár (tool-hub) kérése: a kapcsoló gomb ezt írja, a mod a state.set hookjában veszi át.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'snake-pane': {
      isOn: boolean
      working: boolean
      cmd: { c: SnakeCmd; n: number } | null
      best: number
    }
  }
}
