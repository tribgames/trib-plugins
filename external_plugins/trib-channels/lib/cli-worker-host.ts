import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import { PLUGIN_ROOT } from './config.js'

type PendingEntry = {
  resolve: (value: { stdout: string, stderr: string, code: number | null }) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

let worker: ChildProcess | null = null
let requestSeq = 0
const pending = new Map<number, PendingEntry>()

function rejectAllPending(message: string): void {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer)
    reject(new Error(message))
  }
  pending.clear()
}

function workerPath(): string {
  return join(PLUGIN_ROOT, 'lib', 'ai-cli-worker.cjs')
}

function attachWorkerListeners(child: ChildProcess): void {
  child.on('message', (message: any) => {
    const requestId = Number(message?.requestId ?? 0)
    if (!requestId || !pending.has(requestId)) return
    const entry = pending.get(requestId)!
    pending.delete(requestId)
    clearTimeout(entry.timer)
    if (message?.type === 'result') {
      entry.resolve(message.result ?? { stdout: '', stderr: '', code: 0 })
      return
    }
    entry.reject(new Error(String(message?.error ?? 'cli worker request failed')))
  })

  child.on('exit', (code, signal) => {
    worker = null
    rejectAllPending(`cli worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })

  child.on('error', (error) => {
    worker = null
    rejectAllPending(`cli worker error: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function hasCliWorker(): boolean {
  return Boolean(worker && worker.connected)
}

export function startCliWorker(options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  if (hasCliWorker()) return worker!
  const child = fork(workerPath(), {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env, TRIB_CHANNELS_CLI_WORKER_CHILD: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  worker = child
  attachWorkerListeners(child)
  return child
}

export async function stopCliWorker(): Promise<void> {
  if (!worker) return
  const child = worker
  worker = null
  rejectAllPending('cli worker stopped')
  try { child.kill('SIGTERM') } catch {}
}

export function runCliWorkerTask(task: Record<string, unknown>): Promise<{ stdout: string, stderr: string, code: number | null }> {
  if (!hasCliWorker()) throw new Error('cli worker is not running')
  const requestId = ++requestSeq
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, Number(task.timeout ?? 120000)) + 5000
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`cli worker request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    worker!.send({ type: 'run', requestId, task })
  })
}
