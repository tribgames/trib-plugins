import path from 'path'
import { spawn } from 'child_process'
import { CLI_HOME_DIR, ensureDir } from './config.mjs'
import { hasAiCliWorker, runAiCliTask } from './ai-cli-worker-host.mjs'

function requireWorker(label) {
  if (!hasAiCliWorker()) {
    throw new Error(`ai cli worker is not running — cannot execute ${label}`)
  }
}

export const AI_PROVIDER_IDS = ['grok', 'gemini', 'claude', 'codex']

export const AI_PROVIDER_CAPABILITIES = {
  grok: {
    connectionModes: ['api', 'cli'],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: true,
      quota: false,
    },
  },
  gemini: {
    connectionModes: ['cli'],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
  claude: {
    connectionModes: ['cli'],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
  codex: {
    connectionModes: ['cli'],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
}

function commandExists(command) {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore',
    })
    child.on('exit', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export async function getAvailableAiProviders(config = null) {
  const results = []
  const grokApiKey = config?.aiSearch?.profiles?.grok?.apiKey || ''
  for (const provider of AI_PROVIDER_IDS) {
    if (provider === 'grok' && grokApiKey) {
      results.push(provider)
      continue
    }
    if (await commandExists(provider)) {
      results.push(provider)
    }
  }
  return results
}

function buildPrompt(query, site) {
  const parts = [
    'Answer using live web search when the provider supports it.',
    'Return a concise answer with source URLs when possible.',
  ]
  if (site) {
    parts.push(`Limit the search to site:${site}.`)
  }
  parts.push(`Question: ${query}`)
  return parts.join('\n')
}

function extractGrokAnswer(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map(item => item?.text || '')
      .join('\n')
      .trim()
  }

  return ''
}

async function runGrokApi(prompt, model, env, timeoutMs) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY
  if (!apiKey) {
    throw new Error('XAI_API_KEY or GROK_API_KEY is required for Grok API mode')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        model: model || 'grok-4',
        stream: false,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Grok API failed: ${response.status} ${body}`)
    }

    const payload = await response.json()
    const answer = extractGrokAnswer(payload)
    if (!answer) {
      throw new Error('Grok API returned an empty answer')
    }
    return {
      stdout: answer,
      stderr: null,
      usage: payload.usage || null,
    }
  } finally {
    clearTimeout(timer)
  }
}

function extractXSearchAnswer(payload) {
  const message = payload?.output?.find(item => item?.type === 'message')
  const text = message?.content?.find(item => item?.type === 'output_text')?.text || ''
  return text.trim()
}

async function runGrokXSearch(prompt, model, env, timeoutMs) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY
  if (!apiKey) {
    throw new Error('XAI_API_KEY or GROK_API_KEY is required for x_search mode')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'grok-4-1-fast-reasoning',
        input: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        tools: [
          { type: 'x_search' },
        ],
        max_turns: 2,
        tool_choice: 'required',
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Grok x_search failed: ${response.status} ${body}`)
    }

    const payload = await response.json()
    const answer = extractXSearchAnswer(payload)
    if (!answer) {
      throw new Error('Grok x_search returned an empty answer')
    }
    return {
      stdout: answer,
      stderr: null,
      usage: payload.usage || null,
    }
  } finally {
    clearTimeout(timer)
  }
}

function providerHome(provider) {
  const home = path.join(CLI_HOME_DIR, provider)
  ensureDir(home)
  if (provider === 'gemini') {
    ensureDir(path.join(home, '.gemini'))
  }
  return home
}

function buildProviderEnv(provider) {
  if (provider === 'claude' || provider === 'codex') {
    return { ...process.env }
  }

  const home = providerHome(provider)
  return {
    ...process.env,
    HOME: home,
  }
}

function buildProviderCwd(provider, env) {
  if (provider === 'claude' || provider === 'codex') {
    return env.TRIB_SEARCH_EXEC_CWD || env.PWD || env.HOME || '/tmp'
  }
  return process.cwd()
}

function isTrue(value) {
  return value === true || value === 'true' || value === 1
}

function runCli(command, args, env, timeoutMs, cwd = process.cwd()) {
  requireWorker(command)
  return runAiCliTask({
    mode: 'spawn',
    command,
    args,
    env,
    cwd,
    timeout: timeoutMs,
  })
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function runShellCli(commandText, env, timeoutMs) {
  requireWorker('shell')
  return runAiCliTask({
    mode: 'shell',
    commandText,
    env,
    timeout: timeoutMs,
  })
}

function extractCodexAnswer(stdout) {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  let lastMessage = null
  for (const line of lines) {
    try {
      const payload = JSON.parse(line)
      if (payload?.type === 'item.completed' && payload?.item?.type === 'agent_message') {
        lastMessage = payload.item.text || lastMessage
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  return lastMessage || stdout.trim()
}

export async function runAiSearch({
  query,
  provider,
  site,
  model,
  profile,
  timeoutMs,
}) {
  const finalProvider = provider
  if (!finalProvider) {
    throw new Error('provider is required for ai_search')
  }

  const env = buildProviderEnv(finalProvider)
  const cwd = buildProviderCwd(finalProvider, env)

  switch (finalProvider) {
    case 'grok': {
      const prompt = buildPrompt(query, site)
      const result =
        env.XAI_API_KEY || env.GROK_API_KEY
          ? site === 'x.com' && profile?.xSearchEnabled !== false
            ? await runGrokXSearch(prompt, model, env, timeoutMs)
            : await runGrokApi(prompt, model, env, timeoutMs)
          : await runCli(
              'grok',
              model ? ['-m', model, '-p', prompt] : ['-p', prompt],
              env,
              timeoutMs,
              cwd,
            )
      return {
        provider: 'grok',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
        usage: result.usage || null,
      }
    }
    case 'gemini': {
      const prompt = buildPrompt(query, site)
      const args = ['-p', prompt, '--output-format', 'text']
      if (model) {
        args.push('--model', model)
      }
      const result = await runCli(
        'gemini',
        args,
        env,
        timeoutMs,
        cwd,
      )
      return {
        provider: 'gemini',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
      }
    }
    case 'claude': {
      const prompt = buildPrompt(query, site)
      const command = [
        `cd ${shellEscape(cwd)}`,
        '&&',
        'claude',
        '--print',
        ...(model ? ['--model', shellEscape(model)] : []),
        ...(profile?.effort ? ['--effort', shellEscape(profile.effort)] : []),
        '--',
        shellEscape(prompt),
      ].join(' ')
      const result = await runShellCli(command, env, timeoutMs)
      return {
        provider: 'claude',
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
      }
    }
    case 'codex': {
      const prompt = buildPrompt(query, site)
      const effort = profile?.effort || 'medium'
      const args = [
        'exec',
        '-c',
        `model_reasoning_effort=${effort}`,
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--json',
        prompt,
      ]
      if (isTrue(profile?.fastMode)) {
        args.splice(1, 0, '-c', 'service_tier=fast')
      }
      if (model) {
        args.splice(1, 0, '--model', model)
      }
      const result = await runCli('codex', args, env, timeoutMs, cwd)
      return {
        provider: 'codex',
        model: model || null,
        answer: extractCodexAnswer(result.stdout),
        stderr: result.stderr || null,
      }
    }
    default:
      throw new Error(`Unsupported ai_search provider: ${finalProvider}`)
  }
}
