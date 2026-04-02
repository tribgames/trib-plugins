import { fork } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

let worker = null
let requestSeq = 0
const pending = new Map()

function rejectAllPending(message) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer)
    reject(new Error(message))
  }
  pending.clear()
}

function workerPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-cli-worker.mjs')
}

function attachWorkerListeners(child) {
  child.on('message', message => {
    const requestId = Number(message?.requestId ?? 0)
    if (!requestId || !pending.has(requestId)) return
    const entry = pending.get(requestId)
    pending.delete(requestId)
    clearTimeout(entry.timer)
    if (message?.type === 'result') {
      entry.resolve(message.result ?? { stdout: '', stderr: '', code: 0 })
      return
    }
    entry.reject(new Error(String(message?.error ?? 'ai cli worker request failed')))
  })

  child.on('exit', (code, signal) => {
    worker = null
    rejectAllPending(`ai cli worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })

  child.on('error', error => {
    worker = null
    rejectAllPending(`ai cli worker error: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function hasAiCliWorker() {
  return Boolean(worker && worker.connected)
}

export function startAiCliWorker(options = {}) {
  if (hasAiCliWorker()) return worker
  const child = fork(workerPath(), {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env, TRIB_SEARCH_AI_WORKER_CHILD: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  worker = child
  attachWorkerListeners(child)
  return child
}

export async function stopAiCliWorker() {
  if (!worker) return
  const child = worker
  worker = null
  rejectAllPending('ai cli worker stopped')
  try { child.kill('SIGTERM') } catch {}
}

export function runAiCliTask(task = {}) {
  if (!hasAiCliWorker()) throw new Error('ai cli worker is not running')
  const requestId = ++requestSeq
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, Number(task.timeout ?? 120000)) + 5000
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`ai cli worker request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    worker.send({ type: 'run', requestId, task })
  })
}
