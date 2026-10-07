// Az eszköztár a kapcsolt modok saját `isOn` értékét olvassa (írni csak a tulajdonos írhatja:
// a gomb a saját `request` értékét írja, a mod a state.set hookjában veszi át). Új mod: ide is fel kell venni.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { isOpen: boolean; request: HubRequest | null }
    'focus-mode': { isOn: boolean }
    'usage-band': { isOn: boolean }
    'usage-header': { isOn: boolean }
    'project-pane': { isOn: boolean }
    'snake-pane': { isOn: boolean }
  }
}
