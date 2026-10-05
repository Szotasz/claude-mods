import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProjectGit, ProjectNetlify, ProjectSnapshot, ProjectSupabase } from '../types'
import { STRINGS, languageFor } from './i18n'
import type { Strings } from './i18n'
import { githubSlug, json, mapDeploys, mapPrs, mapRuns, parseStatus, planSync } from './parse'
import type { SyncPlan } from './parse'

const PANE = 'project'
const REFRESH_MS = 60_000
const FETCH_MS = 5 * 60_000

const snap = atom({ plugin: 'project-pane', key: 'snap' } as const, null)
const busy = atom({ plugin: 'project-pane', key: 'busy' } as const, null)

// A modul minden beállításváltáskor és szerkesztéskor újratöltődik: ezek onnan indulnak újra.
let t: Strings = STRINGS.en
let root: string | undefined
let lastFetch: number | undefined
let startedAt = 0
let isRefreshing = false
const notified = new Set<string>()

// Háttérben indított munka: egy hibája ne legyen kezeletlen (pl. a modul újratöltése közben).
const background = (work: Promise<unknown>) => void work.catch(() => undefined)

const STATE_COLOR: Record<string, string> = {
  ready: 'green', success: 'green', error: 'red', failure: 'red',
  building: 'yellow', enqueued: 'yellow', processing: 'yellow', in_progress: 'yellow', queued: 'yellow',
}
const color = (state?: string) => STATE_COLOR[state ?? ''] ?? 'gray'
const mark = (state?: string) =>
  ({ green: '✔', red: '✘', yellow: '…', gray: '·' } as Record<string, string>)[color(state)] ?? '·'

type Run = { ok: boolean; out: string; err: string }

// Egy parancs, ami nem indul el (nincs telepítve), ugyanúgy "nem sikerült", mint a hibakód.
async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs = 30_000): Promise<Run> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

async function repoRoot($: EngineInterface): Promise<string | undefined> {
  const r = await run($, ['git', 'rev-parse', '--show-toplevel'], await $.session.cwd())
  return r.ok && r.out !== '' ? r.out : undefined
}

async function collectGit($: EngineInterface, dir: string, fetchedAt?: number): Promise<ProjectGit> {
  const status = parseStatus((await run($, ['git', 'status', '--porcelain=2', '--branch'], dir)).out)

  const head = await run($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)
  let defaultBranch = head.ok ? head.out.replace(/^origin\//, '') : 'main'
  if (!head.ok && (await run($, ['git', 'rev-parse', '--verify', '--quiet', 'origin/master'], dir)).ok) {
    defaultBranch = 'master'
  }

  const vs = await run($, ['git', 'rev-list', '--left-right', '--count', `HEAD...origin/${defaultBranch}`], dir)
  const [aheadOfDefault = 0, behindDefault = 0] = vs.ok ? vs.out.split(/\s+/).map(Number) : []

  const log = await run($, ['git', 'log', '-1', '--format=%h%x09%ct%x09%s'], dir)
  const [hash, at, ...subject] = log.out.split('\t')
  const lastCommit = log.ok && hash ? { hash, at: Number(at) * 1000, subject: subject.join('\t') } : undefined

  return { ...status, defaultBranch, behindDefault, aheadOfDefault, lastCommit, fetchedAt }
}

async function collectNetlify($: EngineInterface, dir: string): Promise<ProjectNetlify | undefined> {
  const siteId = json<{ siteId?: string }>(await $.fs.read(`${dir}/.netlify/state.json`).catch(() => ''))?.siteId
  if (siteId === undefined) {
    // netlify.toml van, de nincs összekötve: így is jelezzük, hogy Netlify-os a projekt.
    return (await $.fs.exists(`${dir}/netlify.toml`)) ? { siteId: '', deploys: [], note: 'no-cli' } : undefined
  }

  const deploys = await run($, ['netlify', 'api', 'listSiteDeploys', '--data', JSON.stringify({ site_id: siteId, per_page: 3 })], dir)
  if (!deploys.ok) {
    const missing = /ENOENT|not found|No such file|cannot start|spawn/i.test(deploys.err)
    return { siteId, deploys: [], note: missing ? 'no-cli' : 'error' }
  }
  const site = json<{ name?: string; admin_url?: string }>(
    (await run($, ['netlify', 'api', 'getSite', '--data', JSON.stringify({ site_id: siteId })], dir)).out,
  )
  return { siteId, name: site?.name, adminUrl: site?.admin_url, deploys: mapDeploys(deploys.out) }
}

async function collectSupabase($: EngineInterface, dir: string): Promise<ProjectSupabase | undefined> {
  const ref = (await $.fs.read(`${dir}/supabase/.temp/project-ref`).catch(() => '')).trim()
  if (ref === '') return undefined

  const files = (await $.fs.list(`${dir}/supabase/migrations`).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.sql'))
    .map(f => f.name)
    .sort()
  const base: ProjectSupabase = { ref, migrations: files.length, latest: files.at(-1) }

  const r = await run($, ['supabase', 'projects', 'list', '-o', 'json'], dir)
  if (!r.ok) return { ...base, note: 'not-logged-in' }
  const project = json<{ id: string; name: string; status: string; region: string }[]>(r.out)?.find(p => p.id === ref)
  return { ...base, name: project?.name, status: project?.status, region: project?.region }
}

async function collect($: EngineInterface, dir: string, fetchedAt?: number): Promise<ProjectSnapshot> {
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], dir)
  const slug = remote.ok ? githubSlug(remote.out) : undefined
  const gh = async (args: string[]) => {
    const r = slug ? await run($, ['gh', ...args, '-R', slug], dir) : undefined
    return r?.ok ? r.out : undefined
  }

  const [git, prs, runs, netlify, supabase] = await Promise.all([
    collectGit($, dir, fetchedAt),
    gh(['pr', 'list', '--limit', '8', '--json', 'number,title,headRefName,url,reviewDecision,statusCheckRollup']),
    gh(['run', 'list', '-L', '5', '--json', 'databaseId,name,headBranch,status,conclusion,createdAt,url']),
    collectNetlify($, dir),
    collectSupabase($, dir),
  ])

  return {
    root: dir, name: dir.split('/').at(-1) ?? dir, slug, git,
    prs: prs === undefined ? undefined : mapPrs(prs),
    runs: runs === undefined ? undefined : mapRuns(runs),
    netlify, supabase, updatedAt: await $.clock.now(),
  }
}

type SyncOutcome = { ok: boolean; step: string; detail?: string; stashed?: boolean }

async function runSync($: EngineInterface, dir: string, plan: SyncPlan, stash: boolean): Promise<SyncOutcome> {
  let stashed = false
  if (stash) {
    const at = new Date(await $.clock.now()).toISOString().slice(0, 16)
    const s = await run($, ['git', 'stash', 'push', '--include-untracked', '-m', `project-pane sync ${at}`], dir)
    if (!s.ok) return { ok: false, step: 'stash', detail: s.err }
    stashed = true
  }

  if (plan.kind === 'pull') {
    const p = await run($, ['git', 'pull', '--ff-only'], dir, 120_000)
    return { ok: p.ok, step: 'pull', detail: p.err, stashed }
  }
  if (plan.kind === 'switch') {
    const sw = await run($, ['git', 'switch', plan.to], dir)
    if (!sw.ok) return { ok: false, step: 'switch', detail: sw.err, stashed }
    const ff = await run($, ['git', 'merge', '--ff-only', `origin/${plan.to}`], dir, 120_000)
    return { ok: ff.ok, step: ff.ok ? 'switch' : 'merge', detail: ff.err, stashed }
  }
  return { ok: false, step: 'none', stashed }
}

async function refresh($: EngineInterface, withFetch = false): Promise<void> {
  if (root === undefined || isRefreshing) return
  isRefreshing = true
  try {
    if (withFetch && (await run($, ['git', 'fetch', '--quiet', 'origin'], root, 60_000)).ok) lastFetch = await $.clock.now()
    const next = await collect($, root, lastFetch)
    await update($, snap, () => next)
    notifyFailures($, next)
  } finally {
    isRefreshing = false
  }
}

// Csak a session indulása utáni hibákra szól, mindegyikre egyszer.
function notifyFailures($: EngineInterface, s: ProjectSnapshot): void {
  const deploy = s.netlify?.deploys[0]
  if (deploy && deploy.state === 'error' && deploy.at > startedAt && !notified.has(`d${deploy.at}`)) {
    notified.add(`d${deploy.at}`)
    $.ui.toast(t.deployFailed(deploy.branch), { timeoutMs: 10_000 })
  }
  for (const r of s.runs ?? []) {
    if (r.conclusion === 'failure' && r.at > startedAt && !notified.has(`r${r.id}`)) {
      notified.add(`r${r.id}`)
      $.ui.toast(t.runFailed(r.name), { timeoutMs: 10_000 })
    }
  }
}

async function sync($: EngineInterface, stash: boolean): Promise<void> {
  const s = await read($, snap)
  if (root === undefined || s === null || (await read($, busy)) !== null) return
  const plan = planSync(s.git)
  if (plan.kind === 'none' || plan.kind === 'diverged') return

  await update($, busy, () => 'sync')
  try {
    const out = await runSync($, root, plan, stash)
    if (out.ok) $.ui.toast(t.syncDone(out.stashed === true))
    else {
      $.ui.toast(t.syncFailed(out.step), { timeoutMs: 10_000 })
      await $.prompt.fill({ text: t.syncAsk(out.step, out.detail ?? ''), mode: 'replace' })
    }
  } finally {
    await update($, busy, () => null)
    await refresh($, true)
  }
}

export const register: Register = (on, options) => {
  if (options.language === 'hu' || options.language === 'en') t = STRINGS[options.language]

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    t = languageFor(options.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || '')
    startedAt = await $.clock.now()
    root = await repoRoot($)

    await $.command.register({ name: 'project', description: t.commandDescription })
    if (root === undefined) return started

    if (options.autoOpen !== false) {
      const title = t.title(root.split('/').at(-1) ?? '')
      // Keskeny terminálon a magától nyíló panel rejtve vár: szólunk, hogy ne tűnjön el nyomtalanul.
      background($.ui.open({ id: PANE, title }).then(opened => {
        if (!opened.isPlaced) $.ui.toast(t.waiting(opened.reason), { timeoutMs: 10_000 })
      }))
    }
    background(refresh($, true))
    $.clock.every(REFRESH_MS, () => background(refresh($)))
    $.clock.every(FETCH_MS, () => background(refresh($, true)))

    return started
  })

  on('command.run', { command: 'project' }, async $ => {
    root ??= await repoRoot($)
    if (root === undefined) return { text: t.notRepo }
    await $.ui.open({ id: PANE, title: t.title(root.split('/').at(-1) ?? '') })
    background(refresh($, true))
    return { text: t.opened }
  })

  // Claude futtathatott git/gh parancsot: a turn végén frissítünk (fetch nélkül, az olcsó).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    background(refresh($))
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const s = await read($, snap)
    const working = await read($, busy)
    const now = await $.clock.now()

    if (s === null) return <Text dimColor>{root === undefined ? t.notRepo : t.loading}</Text>

    const g = s.git
    const plan = planSync(g)
    const failedRun = s.runs?.find(r => r.conclusion === 'failure')

    const heading = (text: string) => <Text bold color="cyan">{text}</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{s.slug ?? s.name}</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{t.updated(t.ago(now - s.updatedAt))}</Text>
            <Button key="refresh" label={t.refresh} hotkey="r" dimColor onPress={() => refresh($, true)} />
          </Box>
        </Box>

        <Box flexDirection="column">
          {heading(t.git)}
          <Text>
            🌿 <Text bold>{g.branch}</Text>
            {g.upstream ? <Text dimColor>  ↑{g.ahead} ↓{g.behind}</Text> : null}
            <Text color={g.dirty > 0 ? 'yellow' : 'green'}>  · {g.dirty > 0 ? t.dirty(g.dirty) : t.clean}</Text>
          </Text>
          {g.lastCommit && (
            <Text dimColor wrap="truncate-end">
              {t.lastCommit(g.lastCommit.hash, t.ago(now - g.lastCommit.at))} — {g.lastCommit.subject}
            </Text>
          )}
          <Text dimColor>{g.fetchedAt ? t.fetched(t.ago(now - g.fetchedAt)) : t.noFetch}</Text>

          {plan.kind === 'none' && <Text color="green">{t.upToDate}</Text>}
          {plan.kind === 'diverged' && <Text color="red">{t.diverged(plan.ahead, plan.behind)}</Text>}
          {(plan.kind === 'pull' || plan.kind === 'switch') && (
            <Box flexDirection="column">
              <Text color="yellow">
                {plan.kind === 'pull' ? t.behindPull(plan.commits, g.branch) : t.behindSwitch(plan.to, plan.commits, g.branch)}
              </Text>
              {working !== null ? (
                <Text color="yellow">{t.syncing}</Text>
              ) : g.dirty === 0 ? (
                <Button
                  key="sync"
                  hotkey="s"
                  variant="primary"
                  label={plan.kind === 'pull' ? t.pull(plan.commits) : t.switchTo(plan.to)}
                  onPress={() => sync($, false)}
                />
              ) : (
                <Box flexDirection="column">
                  <Text dimColor>{t.dirtyBlocks}</Text>
                  <Button key="stash-sync" hotkey="s" label={t.stashSync} onPress={() => sync($, true)} />
                </Box>
              )}
            </Box>
          )}
        </Box>

        {s.netlify && (
          <Box flexDirection="column">
            {heading(t.deploy)}
            {s.netlify.note === 'no-cli' && <Text dimColor>{t.netlifyNoCli}</Text>}
            {s.netlify.note === 'error' && <Text dimColor>{t.netlifyError}</Text>}
            {s.netlify.note === undefined && s.netlify.deploys.length === 0 && <Text dimColor>{t.noDeploys}</Text>}
            {s.netlify.deploys.map(d => (
              <Text>
                <Text color={color(d.state)}>{mark(d.state)} {d.state}</Text>
                <Text>  {d.branch}</Text>
                <Text dimColor>  {t.ago(now - d.at)}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          {heading(t.prs)}
          {s.prs === undefined && <Text dimColor>{s.slug ? t.ghMissing : '—'}</Text>}
          {s.prs?.length === 0 && <Text dimColor>{t.noPrs}</Text>}
          {s.prs?.map(p => (
            <Text wrap="truncate-end">
              <Text color={color(p.checks === 'pass' ? 'success' : p.checks === 'fail' ? 'failure' : p.checks === 'pending' ? 'queued' : '')}>
                {mark(p.checks === 'pass' ? 'success' : p.checks === 'fail' ? 'failure' : p.checks === 'pending' ? 'queued' : '')}
              </Text>
              <Text bold> #{p.number}</Text> {p.title}
              {p.review ? <Text dimColor>  · {p.review.toLowerCase().replace('_', ' ')}</Text> : null}
            </Text>
          ))}
        </Box>

        {s.runs !== undefined && (
          <Box flexDirection="column">
            {heading(t.ci)}
            {s.runs.length === 0 && <Text dimColor>{t.noRuns}</Text>}
            {s.runs.map(r => (
              <Text wrap="truncate-end">
                <Text color={color(r.conclusion ?? r.status)}>{mark(r.conclusion ?? r.status)}</Text> {r.name}
                <Text dimColor>  {r.branch} · {t.ago(now - r.at)}</Text>
              </Text>
            ))}
            {failedRun && (
              <Button
                key="ask-run"
                hotkey="a"
                label={t.ask}
                onPress={() =>
                  $.prompt.fill({
                    text: t.askRun(failedRun.name, failedRun.branch, failedRun.id, failedRun.url),
                    mode: 'replace',
                  })
                }
              />
            )}
          </Box>
        )}

        {s.supabase && (
          <Box flexDirection="column">
            {heading(t.supabase)}
            <Text>
              <Text bold>{s.supabase.ref}</Text>
              {s.supabase.name ? <Text> · {s.supabase.name}</Text> : null}
              {s.supabase.region ? <Text dimColor> · {s.supabase.region}</Text> : null}
            </Text>
            {s.supabase.status && (
              <Text color={s.supabase.status === 'ACTIVE_HEALTHY' ? 'green' : 'yellow'}>{s.supabase.status}</Text>
            )}
            <Text dimColor wrap="truncate-end">{t.migrations(s.supabase.migrations, s.supabase.latest)}</Text>
            {s.supabase.note === 'not-logged-in' && <Text dimColor>{t.supabaseLogin}</Text>}
          </Box>
        )}

        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {s.slug && <Link href={`https://github.com/${s.slug}`} label="GitHub" />}
          {s.netlify?.adminUrl && <Link href={s.netlify.adminUrl} label="Netlify" />}
          {s.supabase && <Link href={`https://supabase.com/dashboard/project/${s.supabase.ref}`} label="Supabase" />}
        </Box>
      </Box>
    )
  })
}
