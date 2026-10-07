export type TaskStatus = 'pending' | 'in_progress' | 'done'
export type Task = { title: string; status: TaskStatus; progress: number }

// Az eszköztár (tool-hub) kérése: a kapcsoló gomb ezt írja, a mod a state.set hookjában veszi át.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'focus-mode': { isOn: boolean; tasks: Task[]; answers: string[] }
  }
}
