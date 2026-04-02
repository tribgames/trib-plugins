import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callLLM } from '../../lib/llm-provider.mjs'
import { readMainConfig } from '../../lib/memory-cycle.mjs'

const DEFAULT_CYCLE_PROVIDER = { connection: 'codex', model: 'gpt-5.4', effort: 'medium', fast: true }

function pluginRoot() {
  return resolve(import.meta.dirname, '..', '..')
}

export function loadCycle1Prompt(promptPath = null) {
  const resolved = promptPath ? resolve(String(promptPath)) : join(pluginRoot(), 'defaults', 'memory-cycle1-prompt.md')
  if (existsSync(resolved)) return readFileSync(resolved, 'utf8')
  return 'Extract durable memory from recent user messages. Output JSON only.\n\n{{CANDIDATES}}'
}

export function resolveCycle1PromptTemplate(options = {}) {
  if (typeof options.promptTemplate === 'string' && options.promptTemplate.trim()) {
    return options.promptTemplate
  }
  if (options.promptPath) {
    return loadCycle1Prompt(options.promptPath)
  }
  return loadCycle1Prompt()
}

export function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

export function normalizeCycle1Case(raw = {}) {
  const normalizeList = (value) => {
    if (!value) return []
    const list = Array.isArray(value) ? value : [value]
    return list.map(item => String(item).trim()).filter(Boolean)
  }
  const normalizeCandidates = (value) => {
    const list = Array.isArray(value) ? value : []
    return list
      .map(item => {
        if (typeof item === 'string') return { id: null, role: 'user', content: item.trim() }
        return {
          id: item?.id != null ? String(item.id).trim() : null,
          role: String(item?.role ?? 'user').trim() || 'user',
          content: String(item?.content ?? '').trim(),
        }
      })
      .filter(item => item.content)
  }
  return {
    id: String(raw.id ?? raw.label ?? raw.today ?? 'cycle1-case').trim(),
    label: String(raw.label ?? raw.id ?? raw.today ?? 'cycle1-case').trim(),
    today: String(raw.today ?? '').trim() || new Date().toISOString().slice(0, 10),
    candidates: normalizeCandidates(raw.candidates),
    expected_profiles: normalizeList(raw.expected_profiles),
    expected_facts: normalizeList(raw.expected_facts),
    expected_tasks: normalizeList(raw.expected_tasks),
    expected_signals: normalizeList(raw.expected_signals),
    expected_entities: normalizeList(raw.expected_entities),
    expected_relations: normalizeList(raw.expected_relations),
    provider: raw.provider ?? null,
    timeout: Number(raw.timeout ?? 60000),
  }
}

export function loadCycle1Cases(filePath) {
  const raw = readFileSync(filePath, 'utf8').trim()
  if (!raw) return []
  const parsed = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => JSON.parse(line))
  return parsed.map(item => normalizeCycle1Case(item)).filter(item => item.candidates.length > 0)
}

export function buildCycle1Prompt(testCase, options = {}) {
  const candidateText = testCase.candidates
    .map((candidate, index) => `#${index + 1} [${candidate.role}]: ${candidate.content.slice(0, 300)}`)
    .join('\n\n')

  return resolveCycle1PromptTemplate(options)
    .replace('{{TODAY}}', testCase.today)
    .replace('{{CANDIDATES}}', candidateText)
    + `\n\nAdditional extraction rules:\n`
    + `- For development/code tasks, set workstream as dev/{project}/{area} when possible.\n`
    + `- For non-development tasks, use general/{category}.\n`
    + `- For task objects, include scope as work or personal.\n`
    + `- For task objects, include activity as one of coding, research, planning, communication, ops when possible.\n`
    + `- For task objects, include current_state as a single-line summary when the current state is clear.\n`
    + `- For task objects, include next_step when the next action is mentioned or implied.\n`
    + `- Keep current_state and next_step concise.\n`
}

function defaultProvider(testCase) {
  return testCase.provider ?? readMainConfig()?.memory?.cycle1?.provider ?? DEFAULT_CYCLE_PROVIDER
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function collectOutputs(parsed = {}) {
  return {
    profiles: (parsed.profiles ?? []).map(item => String(item?.value ?? '').trim()).filter(Boolean),
    facts: (parsed.facts ?? []).map(item => String(item?.text ?? '').trim()).filter(Boolean),
    tasks: (parsed.tasks ?? []).map(item => String(item?.title ?? '').trim()).filter(Boolean),
    signals: (parsed.signals ?? []).map(item => String(item?.value ?? '').trim()).filter(Boolean),
    entities: (parsed.entities ?? []).map(item => String(item?.name ?? '').trim()).filter(Boolean),
    relations: (parsed.relations ?? []).map(item => {
      const source = String(item?.source ?? '').trim()
      const type = String(item?.type ?? '').trim()
      const target = String(item?.target ?? '').trim()
      return [source, type, target].filter(Boolean).join(' | ')
    }).filter(Boolean),
  }
}

function scoreExpected(expected = [], actual = []) {
  if (expected.length === 0) return { hit1: 1, recall: 1, matched: 0, total: 0 }
  const normalizedActual = actual.map(normalizeText)
  let matched = 0
  for (const expectedItem of expected) {
    const normalizedExpected = normalizeText(expectedItem)
    if (normalizedActual.some(actualItem => actualItem.includes(normalizedExpected) || normalizedExpected.includes(actualItem))) {
      matched += 1
    }
  }
  return {
    hit1: matched > 0 ? 1 : 0,
    recall: matched / expected.length,
    matched,
    total: expected.length,
  }
}

export async function runCycle1Case(testCase, options = {}) {
  const prompt = buildCycle1Prompt(testCase, options)
  const provider = options.provider ?? defaultProvider(testCase)
  const timeout = Number(options.timeout ?? testCase.timeout ?? 60000)
  const raw = await callLLM(prompt, provider, { timeout, cwd: options.cwd ?? process.cwd() })
  const parsed = extractJsonObject(raw)
  const outputs = collectOutputs(parsed ?? {})

  return {
    prompt,
    raw,
    parsed,
    outputs,
    scores: {
      profiles: scoreExpected(testCase.expected_profiles, outputs.profiles),
      facts: scoreExpected(testCase.expected_facts, outputs.facts),
      tasks: scoreExpected(testCase.expected_tasks, outputs.tasks),
      signals: scoreExpected(testCase.expected_signals, outputs.signals),
      entities: scoreExpected(testCase.expected_entities, outputs.entities),
      relations: scoreExpected(testCase.expected_relations, outputs.relations),
    },
  }
}

export async function runCycle1Benchmark(cases, options = {}) {
  const results = []
  const totals = {
    profiles: { hit1: 0, recall: 0, total: 0 },
    facts: { hit1: 0, recall: 0, total: 0 },
    tasks: { hit1: 0, recall: 0, total: 0 },
    signals: { hit1: 0, recall: 0, total: 0 },
    entities: { hit1: 0, recall: 0, total: 0 },
    relations: { hit1: 0, recall: 0, total: 0 },
  }

  for (const testCase of cases) {
    const result = await runCycle1Case(testCase, options)
    results.push({
      id: testCase.id,
      label: testCase.label,
      today: testCase.today,
      scores: result.scores,
      outputs: result.outputs,
      parsed: result.parsed,
      prompt: options.includePrompt ? result.prompt : undefined,
    })
    for (const key of Object.keys(totals)) {
      totals[key].hit1 += result.scores[key].hit1
      totals[key].recall += result.scores[key].recall
      totals[key].total += 1
    }
  }

  const summary = {}
  for (const [key, value] of Object.entries(totals)) {
    summary[key] = {
      hit_at_1: value.total > 0 ? value.hit1 / value.total : 0,
      avg_recall: value.total > 0 ? value.recall / value.total : 0,
      total: value.total,
    }
  }

  return { results, summary }
}
