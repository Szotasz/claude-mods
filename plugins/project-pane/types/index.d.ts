export type ProjectGit = {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  dirty: number
  defaultBranch: string
  /** Commits origin/<default> has that HEAD lacks, and the reverse. */
  behindDefault: number
  aheadOfDefault: number
  lastCommit?: { hash: string; at: number; subject: string }
  fetchedAt?: number
}

export type ProjectPr = {
  number: number
  title: string
  branch: string
  checks: 'pass' | 'fail' | 'pending' | 'none'
  review?: string
  url: string
}

export type ProjectRun = {
  id: number
  name: string
  branch: string
  status: string
  conclusion?: string
  at: number
  url: string
}

export type ProjectDeploy = { state: string; branch: string; at: number; url?: string }

export type ProjectNetlify = {
  siteId: string
  name?: string
  adminUrl?: string
  deploys: ProjectDeploy[]
  note?: 'no-cli' | 'error'
}

export type ProjectSupabase = {
  ref: string
  migrations: number
  latest?: string
  name?: string
  status?: string
  region?: string
  note?: 'not-logged-in'
}

export type ProjectSnapshot = {
  root: string
  name: string
  slug?: string
  git: ProjectGit
  /** undefined: gh is missing or not logged in. */
  prs?: ProjectPr[]
  runs?: ProjectRun[]
  netlify?: ProjectNetlify
  supabase?: ProjectSupabase
  updatedAt: number
}

// Az eszköztár (tool-hub) kérése: a kapcsoló gomb ezt írja, a mod a state.set hookjában veszi át.
export type HubRequest = { tool: string; on: boolean; n: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-hub': { request: HubRequest | null }
    'project-pane': { snap: ProjectSnapshot | null; busy: string | null; isOn: boolean }
  }
}
