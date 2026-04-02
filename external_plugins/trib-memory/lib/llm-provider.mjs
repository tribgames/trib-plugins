/**
 * llm-provider.mjs — Unified LLM provider abstraction layer.
 * Supports: codex, cli (claude), ollama, api (placeholder).
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { hasLlmWorker, runLlmWorkerTask } from './llm-worker-host.mjs'

const execFileAsync = promisify(execFile)

function shouldUseWorker(provider, options = {}) {
  if (process.env.TRIB_MEMORY_LLM_WORKER_CHILD === '1') return false
  if (options.disableWorker) return false
  if (!hasLlmWorker()) return false
  return provider?.connection === 'codex' || provider?.connection === 'cli'
}

async function execBuffered(command, args, options = {}) {
  if (shouldUseWorker(options.provider, options)) {
    return runLlmWorkerTask({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
    })
  }
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout || 60000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return {
    stdout: String(stdout ?? '').trim(),
    stderr: String(stderr ?? '').trim(),
    code: 0,
  }
}

async function execWithInput(command, args, stdin, options = {}) {
  if (shouldUseWorker(options.provider, options)) {
    return runLlmWorkerTask({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      stdin,
    })
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd ?? process.cwd(),
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeoutMs = options.timeout || 120000
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
        return
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
        return
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      })
    })

    child.stdin.write(String(stdin ?? ''))
    child.stdin.end()
  })
}

/**
 * @param {string} prompt — LLM에 보낼 프롬프트
 * @param {object} provider — { connection, model, effort?, fast?, baseUrl? }
 * @param {object} options — { timeout?, cwd? }
 * @returns {Promise<string>} — LLM 응답 텍스트
 */
export async function callLLM(prompt, provider, options = {}) {
  switch (provider.connection) {
    case 'codex':
      return callCodex(prompt, provider, options)
    case 'cli':
      return callClaude(prompt, provider, options)
    case 'ollama':
      return callOllama(prompt, provider, options)
    case 'api':
      return callAPI(prompt, provider, options)
    default:
      throw new Error(`Unknown provider connection: ${provider.connection}`)
  }
}

async function callCodex(prompt, provider, options) {
  const args = ['exec', '--json', '--model', provider.model || 'gpt-5.4']
  if (provider.effort) args.push('-c', `model_reasoning_effort=${provider.effort}`)
  if (provider.fast) args.push('-c', 'service_tier=fast')
  args.push('--skip-git-repo-check')

  const { stdout } = await execWithInput('codex', args, prompt, { ...options, provider })

  // JSON streaming parse — extract text from agent_message type
  const lines = stdout.split('\n').filter(l => l.trim())
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        return obj.item.text
      }
    } catch { /* skip non-JSON lines */ }
  }
  return ''
}

async function callClaude(prompt, provider, options) {
  const args = [
    '-p',
    '--model', provider.model || 'sonnet',
    '--output-format', 'json',
    '--system-prompt', 'You are a memory extraction system.',
    '--no-session-persistence',
  ]
  if (provider.effort) args.push('--effort', provider.effort)

  const runClaudeOnce = async () => {
    const { stdout } = await execWithInput('claude', args, prompt, { ...options, provider })
    try {
      const parsed = JSON.parse(stdout)
      if (parsed?.is_error) {
        throw new Error(String(parsed?.result ?? 'claude provider returned an error'))
      }
      return String(parsed?.result ?? '').trim()
    } catch {
      return stdout.trim()
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runClaudeOnce()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = /Not logged in/i.test(message)
      if (!retryable || attempt >= 2) throw error
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

async function callOllama(prompt, provider, options) {
  const baseUrl = provider.baseUrl || 'http://localhost:11434'
  const payload = JSON.stringify({
    model: provider.model || 'qwen3.5:9b',
    prompt,
    stream: false,
    options: { num_ctx: 4096, temperature: 0 },
  })
  const { stdout } = await execFileAsync('curl', [
    '-s',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    `${baseUrl}/api/generate`,
  ], {
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const data = JSON.parse(stdout || '{}')
  return data.response || ''
}

async function callAPI(prompt, provider, options) {
  // Anthropic/OpenAI API direct call — to be implemented
  throw new Error('API provider not yet implemented. Use codex, cli, or ollama.')
}
