import { fork } from 'node:child_process'
import { resolve } from 'node:path'

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
  return resolve(import.meta.dirname, '..', 'services', 'llm-worker.mjs')
}

function attachWorkerListeners(child) {
  child.on('message', (message = {}) => {
    const requestId = Number(message.requestId ?? 0)
    if (!requestId || !pending.has(requestId)) return
    const entry = pending.get(requestId)
    pending.delete(requestId)
    clearTimeout(entry.timer)
    if (message.type === 'result') {
      entry.resolve(message.result ?? { stdout: '', stderr: '', code: 0 })
      return
    }
    entry.reject(new Error(String(message.error ?? 'worker request failed')))
  })

  child.on('exit', (code, signal) => {
    worker = null
    rejectAllPending(`llm worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })

  child.on('error', (error) => {
    worker = null
    rejectAllPending(`llm worker error: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function hasLlmWorker() {
  return Boolean(worker && worker.connected)
}

export function startLlmWorker(options = {}) {
  if (hasLlmWorker()) return worker
  const child = fork(workerPath(), {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...options.env,
      TRIB_MEMORY_LLM_WORKER_CHILD: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  worker = child
  attachWorkerListeners(child)
  return child
}

export async function stopLlmWorker() {
  if (!worker) return
  const child = worker
  worker = null
  rejectAllPending('llm worker stopped')
  try { child.kill('SIGTERM') } catch {}
}

export function runLlmWorkerTask(task = {}) {
  if (!hasLlmWorker()) {
    throw new Error('llm worker is not running')
  }
  const requestId = ++requestSeq
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, Number(task.timeout ?? 120000)) + 5000
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`llm worker request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    worker.send({ type: 'run', requestId, task })
  })
}
