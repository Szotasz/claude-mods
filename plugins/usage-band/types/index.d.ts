export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { percent: number; tokens?: number; window: number }

// Az eszköztár (tool-hub) kérése: a kapcsoló gomb ezt írja, a mod a state.set hookjában veszi át.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'usage-band': { limits: Limit[]; warned: string[]; context: Context | null; model: string | null; isOn: boolean }
  }
}
