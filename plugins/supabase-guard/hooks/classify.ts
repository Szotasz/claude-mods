// Tiszta függvények: melyik Supabase-hívás milyen veszélyes, és melyik projekthez tartozik a mappa.

export type Risk = 'read' | 'write' | 'destructive'

// Projekt-ref: a Supabase 20 kisbetűs azonosítója.
const REF = /^[a-z]{20}$/

export const isRef = (value: unknown): value is string => typeof value === 'string' && REF.test(value)

// mcp__supabase__execute_sql, mcp__claude_ai_Supabase__execute_sql, … → execute_sql
export function supabaseAction(tool: string): string | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool)
  if (m === null || !/supabase/i.test(m[1] ?? '')) return null
  return m[2] ?? null
}

const READ_ACTIONS = /^(list_|get_|search_docs$|generate_typescript_types$|query_logs$|confirm_cost$)/
// Ezek a megegyező projekten is mindig kérdeznek.
const DESTRUCTIVE_ACTIONS = new Set(['delete_branch', 'reset_branch', 'pause_project', 'restore_project'])

// DROP, TRUNCATE, DELETE, ALTER … DROP, jogosultság-visszavonás, WHERE nélküli UPDATE.
const DESTRUCTIVE_SQL = [
  /\bdrop\s+(table|schema|database|function|view|materialized|type|trigger|policy|index|extension|role|publication)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\b[^;]*\bdrop\b/i,
  /\brevoke\b/i,
  /\bdisable\s+row\s+level\s+security\b/i,
]
const READ_SQL = /^\s*(select|with|explain|show|values|table)\b/i

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function updateWithoutWhere(sql: string): boolean {
  return stripSqlComments(sql)
    .split(';')
    .some(stmt => /^\s*update\b/i.test(stmt) && !/\bwhere\b/i.test(stmt))
}

export function sqlRisk(sql: string): Risk {
  const clean = stripSqlComments(sql)
  if (DESTRUCTIVE_SQL.some(re => re.test(clean)) || updateWithoutWhere(clean)) return 'destructive'
  const statements = clean.split(';').filter(s => s.trim() !== '')
  if (statements.length > 0 && statements.every(s => READ_SQL.test(s) && !/\b(insert|update|delete)\b/i.test(s))) return 'read'
  return 'write'
}

export function actionRisk(action: string, input: Record<string, unknown>): Risk {
  if (action === 'execute_sql') return sqlRisk(typeof input.query === 'string' ? input.query : '')
  if (DESTRUCTIVE_ACTIONS.has(action)) return 'destructive'
  if (action === 'apply_migration' && typeof input.query === 'string' && sqlRisk(input.query) === 'destructive') return 'destructive'
  if (READ_ACTIONS.test(action)) return 'read'
  return 'write'
}

// A Bash-ban futó supabase CLI: --project-ref és a veszélyes alparancsok.
export type CliCall = { ref: string | null; risk: Risk; what: string }

export function supabaseCli(command: string): CliCall | null {
  if (!/(^|[\s;&|(])(npx\s+|bunx\s+)?supabase\s/.test(command)) return null
  const ref = /--project-ref[=\s]+["']?([a-z]{20})\b/.exec(command)?.[1] ?? null
  const what = /supabase\s+((?:[a-z][a-z-]*\s*){1,2})/.exec(command)?.[1]?.trim() ?? 'supabase'
  let risk: Risk = 'read'
  if (/\bdb\s+reset\b[^;&|]*--linked|\bprojects\s+delete\b|\bbranches\s+delete\b|\bmigration\s+repair\b/.test(command)) risk = 'destructive'
  else if (/\bdb\s+push\b|\bfunctions\s+deploy\b|\bsecrets\s+(set|unset)\b|\bfunctions\s+delete\b|\bconfig\s+push\b/.test(command)) risk = 'write'
  return { ref, risk, what }
}

// A mappa fájljaiból kiolvasható projekt-ref-ek.
export const LOOK_IN = [
  'supabase/.temp/project-ref',
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  'frontend/.env',
  'frontend/.env.local',
  'web/.env.local',
  'app/.env.local',
  'CLAUDE.md',
]

export function refsIn(text: string): string[] {
  const found = new Set<string>()
  const trimmed = text.trim()
  if (isRef(trimmed)) found.add(trimmed)
  for (const m of text.matchAll(/https?:\/\/([a-z]{20})\.supabase\.(co|in)\b/g)) found.add(m[1] ?? '')
  for (const m of text.matchAll(/project[ _-]?(?:id|ref)\W{1,6}([a-z]{20})\b/gi)) found.add(m[1] ?? '')
  for (const m of text.matchAll(/SUPABASE_(?:PROJECT_)?(?:ID|REF)\s*=\s*["']?([a-z]{20})\b/g)) found.add(m[1] ?? '')
  return [...found].filter(isRef)
}

export function short(ref: string): string {
  return `${ref.slice(0, 6)}…`
}
