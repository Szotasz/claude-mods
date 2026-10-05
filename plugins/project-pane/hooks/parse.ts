import type { ProjectGit, ProjectPr, ProjectRun, ProjectDeploy } from '../types'

export function json<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function githubSlug(remoteUrl: string): string | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(remoteUrl)
  return m ? `${m[1]}/${m[2]}` : undefined
}

export type StatusPart = Pick<ProjectGit, 'branch' | 'upstream' | 'ahead' | 'behind' | 'dirty'>

/** `git status --porcelain=2 --branch` */
export function parseStatus(out: string): StatusPart {
  const part: StatusPart = { branch: '?', ahead: 0, behind: 0, dirty: 0 }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) part.branch = line.slice(14)
    else if (line.startsWith('# branch.upstream ')) part.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.slice(12).split(' ')
      part.ahead = Number(a?.slice(1) ?? 0)
      part.behind = Number(b?.slice(1) ?? 0)
    } else if (line !== '' && !line.startsWith('#')) part.dirty += 1
  }
  return part
}

type GhCheck = { status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number; title: string; headRefName: string; url: string
  reviewDecision?: string; statusCheckRollup?: GhCheck[]
}

export function checksOf(rollup: GhCheck[] = []): ProjectPr['checks'] {
  if (rollup.length === 0) return 'none'
  const results = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (results.some(r => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(r))) return 'fail'
  if (results.some(r => ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(r))) return 'pending'
  return 'pass'
}

export function mapPrs(out: string): ProjectPr[] | undefined {
  return json<GhPr[]>(out)?.map(p => ({
    number: p.number, title: p.title, branch: p.headRefName, url: p.url,
    review: p.reviewDecision || undefined, checks: checksOf(p.statusCheckRollup),
  }))
}

type GhRun = {
  databaseId: number; name: string; headBranch: string; status: string
  conclusion?: string; createdAt: string; url: string
}

export function mapRuns(out: string): ProjectRun[] | undefined {
  return json<GhRun[]>(out)?.map(x => ({
    id: x.databaseId, name: x.name, branch: x.headBranch, status: x.status,
    conclusion: x.conclusion || undefined, at: Date.parse(x.createdAt), url: x.url,
  }))
}

type NlDeploy = { state: string; branch: string; created_at: string; deploy_ssl_url?: string }

export function mapDeploys(out: string): ProjectDeploy[] {
  return (json<NlDeploy[]>(out) ?? []).slice(0, 3).map(d => ({
    state: d.state, branch: d.branch, at: Date.parse(d.created_at), url: d.deploy_ssl_url,
  }))
}

export type SyncPlan =
  | { kind: 'none' }
  | { kind: 'pull'; commits: number }
  | { kind: 'switch'; to: string; commits: number }
  | { kind: 'diverged'; ahead: number; behind: number }

// Csak fast-forward: a gomb soha nem merge-öl, nem rebase-el és nem dob el commitot.
export function planSync(git: ProjectGit): SyncPlan {
  if (git.behind > 0 && git.ahead > 0) return { kind: 'diverged', ahead: git.ahead, behind: git.behind }
  if (git.behind > 0) return { kind: 'pull', commits: git.behind }
  if (git.branch !== git.defaultBranch && git.behindDefault > 0) {
    return { kind: 'switch', to: git.defaultBranch, commits: git.behindDefault }
  }
  return { kind: 'none' }
}
