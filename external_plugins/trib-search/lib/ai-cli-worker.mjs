#!/usr/bin/env node

import { spawn } from 'child_process'

function runSpawnTask(task = {}) {
  return new Promise((resolve, reject) => {
    const command = String(task.command ?? '').trim()
    const args = Array.isArray(task.args) ? task.args.map(value => String(value)) : []
    if (!command) {
      reject(new Error('ai cli worker task requires command'))
      return
    }

    const timeoutMs = Math.max(1000, Number(task.timeout ?? 120000))
    const useStdin = task.stdin != null
    const child = spawn(command, args, {
      cwd: task.cwd ? String(task.cwd) : process.cwd(),
      env: {
        ...process.env,
        ...(task.env && typeof task.env === 'object' ? task.env : {}),
      },
      stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
        return
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })

    if (useStdin) {
      child.stdin.write(String(task.stdin))
      child.stdin.end()
    }
  })
}

function runShellTask(task = {}) {
  return runSpawnTask({
    command: '/bin/zsh',
    args: ['-lc', String(task.commandText ?? '')],
    cwd: task.cwd,
    env: task.env,
    timeout: task.timeout,
  })
}

process.on('message', async message => {
  if (message?.type !== 'run') return
  const requestId = Number(message.requestId ?? 0)
  try {
    const task = message.task ?? {}
    const result = task.mode === 'shell'
      ? await runShellTask(task)
      : await runSpawnTask(task)
    process.send?.({ type: 'result', requestId, result })
  } catch (error) {
    process.send?.({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
