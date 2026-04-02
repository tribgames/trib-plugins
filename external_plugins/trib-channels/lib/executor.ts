/**
 * Shared executor — handles the actual execution of event/schedule actions.
 * Used by both the event pipeline and the scheduler.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { join, normalize, extname } from 'path'
import { tmpdir } from 'os'
import { DATA_DIR } from './config.js'
import { runCliWorkerTask } from './cli-worker-host.js'

const SCRIPTS_DIR = join(DATA_DIR, 'scripts')
const NOPLUGIN_DIR = join(tmpdir(), 'trib-channels-noplugin')
const EVENT_LOG = join(DATA_DIR, 'event.log')

export function logEvent(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { process.stderr.write(`trib-channels event: ${msg}\n`) } catch { /* EPIPE */ }
  try { appendFileSync(EVENT_LOG, line) } catch { /* best effort */ }
}

// ── Callback types ──────────────────────────────────────────────────

export type InjectFn = (channelId: string, name: string, promptContent: string) => void
export type SendFn = (channelId: string, text: string) => Promise<void>
export type SessionStateGetter = () => 'idle' | 'active' | 'recent'

// ── Parsers ─────────────────────────────────────────────────────────

export function parseGithub(body: any, headers: Record<string, string>): Record<string, string> {
  const event = headers['x-github-event'] || ''
  const action = body.action || ''
  const pr = body.pull_request || body.issue || {}
  return {
    event, action,
    title: pr.title || body.head_commit?.message || '',
    author: pr.user?.login || body.sender?.login || '',
    repo: body.repository?.full_name || '',
    url: pr.html_url || body.compare || '',
    branch: body.ref || pr.head?.ref || '',
    message: body.head_commit?.message || '',
  }
}

export function parseSentry(body: any): Record<string, string> {
  const data = body.data || {}
  const evt = data.event || data.issue || {}
  return {
    title: evt.title || body.message || '',
    level: evt.level || body.level || '',
    project: body.project_name || body.project || '',
    url: evt.web_url || body.url || '',
  }
}

export function parseGeneric(body: any): Record<string, string> {
  const result: Record<string, string> = {}
  const keys = Object.keys(body).slice(0, 5)
  for (const k of keys) {
    result[k] = typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k])
  }
  return result
}

export function applyParser(
  parser: string | undefined,
  body: any,
  headers: Record<string, string>,
): Record<string, string> {
  switch (parser) {
    case 'github': return parseGithub(body, headers)
    case 'sentry': return parseSentry(body)
    case 'generic': return parseGeneric(body)
    default: return { raw: JSON.stringify(body) }
  }
}

// ── Filter engine ───────────────────────────────────────────────────

/**
 * Evaluate a simple filter expression against parsed data.
 * Supports: field == 'value', field != 'value', ||, &&
 */
export function evaluateFilter(expr: string, data: Record<string, string>): boolean {
  const orParts = expr.split('||').map(s => s.trim())
  for (const orPart of orParts) {
    const andParts = orPart.split('&&').map(s => s.trim())
    let andResult = true
    for (const condition of andParts) {
      const match = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/)
      if (!match) {
        const neqMatch = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/)
        if (neqMatch) {
          const [, field, value] = neqMatch
          if ((data[field] ?? '') === value) { andResult = false; break }
        } else {
          andResult = false
          break
        }
        continue
      }
      const [, field, value] = match
      if ((data[field] ?? '') !== value) { andResult = false; break }
    }
    if (andResult) return true
  }
  return false
}

// ── Template engine ─────────────────────────────────────────────────

export function applyTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '')
}

// ── Execution ───────────────────────────────────────────────────────

/** Ensure the empty plugin directory exists */
export function ensureNopluginDir(): void {
  mkdirSync(NOPLUGIN_DIR, { recursive: true })
}

/** Run claude -p via the CLI worker child process and return stdout via callback */
export function spawnClaudeP(
  name: string,
  prompt: string,
  onResult: (result: string, code: number | null) => void,
): void {
  ensureNopluginDir()
  logEvent(`${name}: dispatching to cli worker`)

  const wrappedPrompt = prompt + '\n\nIMPORTANT: Output your final result as plain text to stdout. Do NOT use any reply, messaging, or channel tools. Just print the result.'
  const args = [
    '-p', '--dangerously-skip-permissions', '--no-session-persistence',
    '--plugin-dir', NOPLUGIN_DIR,
  ]

  void runCliWorkerTask({
    command: 'claude',
    args,
    stdin: wrappedPrompt,
    timeout: 120000,
    env: { ...process.env, TRIB_CHANNELS_NO_CONNECT: '1' },
  }).then(result => {
    const lines = result.stdout.trim().split('\n')
    const text = lines.slice(-30).join('\n').substring(0, 1900)
    logEvent(`${name}: cli worker completed (${result.code})`)
    onResult(text, result.code)
  }).catch((err: Error) => {
    logEvent(`${name}: cli worker error: ${err.message}`)
    onResult('', null)
  })
}

/** Run a script from the scripts directory, return stdout via callback */
export function runScript(
  name: string,
  scriptName: string,
  onResult: (result: string, code: number | null) => void,
): void {
  if (!existsSync(SCRIPTS_DIR)) {
    mkdirSync(SCRIPTS_DIR, { recursive: true })
  }

  const scriptPath = normalize(join(SCRIPTS_DIR, scriptName))
  if (!scriptPath.startsWith(SCRIPTS_DIR)) {
    logEvent(`${name}: script path escapes directory: ${scriptName}`)
    onResult('', null)
    return
  }
  if (!existsSync(scriptPath)) {
    logEvent(`${name}: script not found: ${scriptPath}`)
    onResult('', null)
    return
  }

  const ext = extname(scriptName).toLowerCase()
  const cmd = ext === '.py' ? 'python3' : 'node'

  const proc = spawn(cmd, [scriptPath], {
    timeout: 30_000,
    env: { ...process.env },
  })

  let stdout = ''
  let stderr = ''
  if (proc.stdout) proc.stdout.on('data', (d: Buffer) => { stdout += d })
  if (proc.stderr) proc.stderr.on('data', (d: Buffer) => { stderr += d })

  proc.on('close', (code: number | null) => {
    if (code !== 0) {
      logEvent(`${name}: script exited ${code}: ${stderr.substring(0, 500)}`)
    }
    onResult(stdout.substring(0, 2000), code)
  })

  proc.on('error', (err: Error) => {
    logEvent(`${name}: script spawn error: ${err.message}`)
    onResult('', null)
  })
}
