import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/shop'
const HU = { options: { language: 'hu' } }
const NOW = Date.parse('2026-10-05T12:00:00Z')

type Fixture = Record<string, { exitCode?: number; stdout?: string; stderr?: string }>

// Tipikus elavult klón: régi develop, a main 13 committal előrébb, 7 módosított fájl.
const STALE: Fixture = {
  'git rev-parse --show-toplevel': { stdout: ROOT },
  'git fetch --quiet origin': {},
  'git remote get-url origin': { stdout: 'https://github.com/acme/shop.git' },
  'git status --porcelain=2 --branch': {
    stdout: ['# branch.oid abc', '# branch.head develop', '# branch.upstream origin/develop', '# branch.ab +0 -0',
      ...Array.from({ length: 7 }, (_, i) => `1 .M N... 100644 100644 100644 a b f${i}.ts`)].join('\n'),
  },
  'git symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
  'git rev-list --left-right --count HEAD...origin/main': { stdout: '0\t13' },
  'git log -1 --format=%h%x09%ct%x09%s': { stdout: `57704fe\t${(NOW - 200 * 86_400_000) / 1000}\tFix checkout flow` },
  'gh pr list --limit 8 --json number,title,headRefName,url,reviewDecision,statusCheckRollup -R acme/shop': {
    stdout: JSON.stringify([{ number: 142, title: 'Stripe webhook retry', headRefName: 'fix/x', url: 'u',
      reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }]),
  },
  'gh run list -L 5 --json databaseId,name,headBranch,status,conclusion,createdAt,url -R acme/shop': {
    stdout: JSON.stringify([{ databaseId: 7, name: 'netlify-deploy-verify', headBranch: 'main', status: 'completed',
      conclusion: 'failure', createdAt: '2026-09-30T06:00:34Z', url: 'https://github.com/run/7' }]),
  },
  'supabase projects list -o json': { exitCode: 1, stderr: 'Unauthorized' },
}

const FILES: Record<string, string> = {
  [`${ROOT}/.netlify/state.json`]: '{"siteId":"1a2b3c4d"}',
  [`${ROOT}/supabase/.temp/project-ref`]: 'abcdefghijklmnopqrst\n',
}

function engine(on: On, fixture: Fixture, waitReason?: string) {
  const ran: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  mock.env(on, { LANG: 'hu_HU.UTF-8' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => e as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () =>
    ({ value: waitReason === undefined ? { isPlaced: true } : { isPlaced: false, reason: waitReason } }) as never)
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.fill', ($, e) => { prompts.push(e.text); return { isFilled: true } as never })
  on('fs.read', ($, e) => (e.path in FILES ? { value: FILES[e.path]! } : ({ deny: 'ENOENT' }) as never))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('netlify.toml') }))
  on('fs.list', () => ({ value: [{ name: '001_init.sql', kind: 'file' }, { name: '018_rls.sql', kind: 'file' }] }) as never)
  on('process.run', ($, e) => {
    const key = e.argv.join(' ')
    ran.push(key)
    if (e.argv[0] === 'netlify') return { deny: 'spawn netlify ENOENT' } as never
    const hit = fixture[key] ?? { exitCode: 1, stderr: `unexpected: ${key}` }
    return { value: { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '',
      isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return { ran, prompts, toasts }
}

async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  // a session.start a frissítést háttérben indítja: a /project parancs megvárható útja ugyanaz
  await $.command.run({ command: 'project', args: '' } as never)
}

const PANE = { component: 'Pane', requestId: 'project', props: {} as never } as const

test('régi branch: figyelmeztet és stash+szinkront kínál', HU, async ($, on) => {
  engine(on, STALE)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'project-pane', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /a main 13 committal előrébb jár, te a develop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7 módosított fájl/ })).toBeDefined()
    expect(await ui.find({ key: 'stash-sync' })).toBeDefined()
    expect(await ui.find({ key: 'sync' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /netlify-deploy-verify/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#142/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Netlify CLI kell/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /abcdefghijklmnopqrst/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 migráció · utolsó: 018_rls\.sql/ })).toBeDefined()
    await ui.unmount()
  }
})

test('stash + szinkron: félreteszi, átvált, fast-forward', HU, async ($, on) => {
  const { ran } = engine(on, {
    ...STALE,
    'git stash push --include-untracked -m project-pane sync 2026-10-05T12:00': {},
    'git switch main': {},
    'git merge --ff-only origin/main': {},
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'project-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'stash-sync' })

  const i = ran.indexOf('git stash push --include-untracked -m project-pane sync 2026-10-05T12:00')
  expect(i).toBeGreaterThan(-1)
  expect(ran.indexOf('git switch main')).toBeGreaterThan(i)
  expect(ran.indexOf('git merge --ff-only origin/main')).toBeGreaterThan(ran.indexOf('git switch main'))
  expect(ran.some(c => /reset|rebase|--force|merge (?!--ff-only)/.test(c))).toBe(false)
  await ui.unmount()
})

test('tiszta, lemaradt branch: egyszerű pull', HU, async ($, on) => {
  const { ran } = engine(on, {
    ...STALE,
    'git status --porcelain=2 --branch': { stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3' },
    'git rev-list --left-right --count HEAD...origin/main': { stdout: '0\t3' },
    'git pull --ff-only': {},
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'project-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', text: /Pull \(3\)/ })).toBeDefined()
  await ui.press({ key: 'sync' })
  expect(ran).toContain('git pull --ff-only')
  expect(ran.some(c => c.startsWith('git stash'))).toBe(false)
  await ui.unmount()
})

test('sikertelen szinkron: a hibát a promptba teszi', HU, async ($, on) => {
  const { prompts } = engine(on, {
    ...STALE,
    'git status --porcelain=2 --branch': { stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3' },
    'git rev-list --left-right --count HEAD...origin/main': { stdout: '0\t3' },
    'git pull --ff-only': { exitCode: 128, stderr: 'fatal: Not possible to fast-forward' },
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'project-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'sync' })
  expect(prompts[0]).toContain('Not possible to fast-forward')
  await ui.unmount()
})

test('naprakész: nincs szinkron gomb; angolul', { options: { language: 'en' } }, async ($, on) => {
  engine(on, {
    ...STALE,
    'git status --porcelain=2 --branch': { stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0' },
    'git rev-list --left-right --count HEAD...origin/main': { stdout: '0\t0' },
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'project-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /up to date with GitHub/ })).toBeDefined()
  expect(await ui.find({ key: 'sync' })).toBeUndefined()
  expect(await ui.find({ key: 'stash-sync' })).toBeUndefined()
  await ui.unmount()
})

test('a sikertelen CI-ból kérdést tesz a promptba', HU, async ($, on) => {
  const { prompts } = engine(on, STALE)
  await start($)
  const ui = await $.ui.mount({ plugin: 'project-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'ask-run' })
  expect(prompts[0]).toContain('gh run view 7 --log-failed')
  await ui.unmount()
})

test('keskeny terminál: szól, hogy a panel vár', HU, async ($, on) => {
  const { toasts } = engine(on, STALE, '120 oszlop < 144')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  for (let i = 0; i < 20 && toasts.length === 0; i++) await Promise.resolve()
  expect(toasts.some(x => x.includes('120 oszlop < 144') && x.includes('/project'))).toBe(true)
})

test('/project ki: bezárja a panelt és nem frissít; /project be: újra nyitja', HU, async ($, on) => {
  const s = engine(on, STALE)
  const closed: string[] = []
  on('ui.close', ($, e) => { closed.push(e.id); return { value: undefined } as never })
  await start($)
  expect((await $.command.run({ command: 'project', args: 'ki' } as never)).text).toContain('kikapcsolva')
  expect(closed).toEqual(['project'])
  const before = s.ran.length
  await $.command.run({ command: 'project', args: 'valami' } as never)
  expect(s.ran.length).toBe(before)
  expect((await $.command.run({ command: 'project', args: 'be' } as never)).text).toBe('Projekt-panel megnyitva.')
})
