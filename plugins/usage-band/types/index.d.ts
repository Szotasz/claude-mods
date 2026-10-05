export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { percent: number; tokens?: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { limits: Limit[]; warned: string[]; context: Context | null; model: string | null }
  }
}
