import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callLLM } from '../../lib/llm-provider.mjs'

const DEFAULT_PROVIDER = { connection: 'cli', model: 'sonnet', effort: 'medium' }

function pluginRoot() {
  return resolve(import.meta.dirname, '..', '..')
}

export function loadClassificationPrompt(promptPath = null) {
  const resolved = promptPath
    ? resolve(String(promptPath))
    : join(pluginRoot(), 'defaults', 'memory-classification-prompt.md')
  if (existsSync(resolved)) return readFileSync(resolved, 'utf8')
  return 'Fill the missing classification columns for each row. Output JSON only.\n\nRows:\n\n{{ROWS}}'
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

export function normalizeClassificationRows(rows = []) {
  return rows.map((row, index) => ({
    case_id: String(row.case_id ?? row.id ?? `case-${index + 1}`).trim(),
    episode_ids: String(row.episode_ids ?? '').trim(),
    center_user_text: String(row.center_user_text ?? '').trim(),
    center_assistant_text: String(row.center_assistant_text ?? '').trim(),
    semantic_before: String(row.semantic_before ?? '').trim(),
    semantic_after: String(row.semantic_after ?? '').trim(),
  }))
}

export function buildClassificationRowsText(rows = []) {
  return rows.map((row) => {
    const parts = [
      `case_id=${row.case_id}`,
      row.episode_ids ? `episode_ids=${row.episode_ids}` : null,
      `center_user_text=${row.center_user_text}`,
      `center_assistant_text=${row.center_assistant_text}`,
      `semantic_before=${row.semantic_before || '없음'}`,
      `semantic_after=${row.semantic_after || '없음'}`,
    ].filter(Boolean)
    return parts.join(' | ')
  }).join('\n')
}

export function buildClassificationPrompt(rows = [], options = {}) {
  const template = loadClassificationPrompt(options.promptPath)
  return template.replace('{{ROWS}}', buildClassificationRowsText(rows))
}

function normalizeOutputItem(item = {}) {
  return {
    case_id: String(item.case_id ?? '').trim(),
    classification: String(item.classification ?? '').trim(),
    topic: String(item.topic ?? '').trim(),
    element: String(item.element ?? '').trim(),
    state: String(item.state ?? '').trim(),
  }
}

export async function runClassificationBatch(rows, options = {}) {
  const normalizedRows = normalizeClassificationRows(rows)
  const prompt = buildClassificationPrompt(normalizedRows, options)
  const provider = options.provider ?? DEFAULT_PROVIDER
  const timeout = Number(options.timeout ?? 120000)
  const raw = await callLLM(prompt, provider, { timeout, cwd: options.cwd ?? process.cwd() })
  const parsed = extractJsonObject(raw)
  const items = Array.isArray(parsed?.items) ? parsed.items.map(normalizeOutputItem) : []
  return {
    prompt,
    raw,
    items,
  }
}
