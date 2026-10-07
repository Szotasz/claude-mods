// Egy kategória a kontextusablakból, ahogy a /context listázza; a szín a téma kulcsa.
export type Segment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }
export type Breakdown = { segments: Segment[]; total: number; max: number; percent: number }
// A fókusz mód listája: a sáv tetején lévő vonal csak a legszélesebb soráig tart.
export type Task = { title: string; status: 'pending' | 'in_progress' | 'done'; progress: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// Az eszköztár (tool-hub) kérése: a kapcsoló gomb ezt írja, a mod a state.set hookjában veszi át.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'focus-mode': { isOn: boolean; tasks: Task[] }
    'usage-header': { breakdown: Breakdown | null; limits: Limit[]; isOn: boolean }
  }
}
