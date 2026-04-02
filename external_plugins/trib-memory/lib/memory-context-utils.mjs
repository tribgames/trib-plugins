import { cleanMemoryText } from './memory-extraction.mjs'
import { DEFAULT_MEMORY_TUNING } from './memory-tuning.mjs'

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

export function formatHintAge(ts, nowTs = Date.now()) {
  if (!ts) return ''
  const msTs = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : new Date(ts).getTime()
  const diff = nowTs - msTs
  if (diff < 0) return '0m'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function computeHintRelevance(item, _options = {}) {
  // RRF + semantic scoring: classification ~0.15-0.40, episode ~0.01-0.04
  const weighted = Number(item?.weighted_score)
  if (Number.isFinite(weighted) && weighted > 0) {
    return clamp01(Math.min(1, weighted / 0.4))
  }
  return 0
}

export function shouldInjectHint(item, overrides = {}, options = {}) {
  const type = String(overrides.type ?? item?.type ?? 'episode')
  const queryTokenCount = Math.max(1, Number(options.queryTokenCount ?? 1))
  const confidence = clamp01(overrides.confidence ?? item?.confidence ?? item?.quality_score ?? item?.effectiveScore ?? 0)
  const relevance = clamp01(overrides.relevanceScore ?? computeHintRelevance(item, { queryTokenCount }))
  const overlap = clamp01(Number(item?.overlapCount ?? 0) / Math.min(3, queryTokenCount))
  const hintConfig = options.hintConfig ?? DEFAULT_MEMORY_TUNING.hintInjection
  const weights = hintConfig?.compositeWeights ?? DEFAULT_MEMORY_TUNING.hintInjection.compositeWeights
  const thresholds = hintConfig?.thresholds ?? DEFAULT_MEMORY_TUNING.hintInjection.thresholds
  const threshold = thresholds?.[type] ?? thresholds?.default ?? DEFAULT_MEMORY_TUNING.hintInjection.thresholds.default
  const composite = Number((
    relevance * Number(weights.relevance ?? 0.58) +
    confidence * Number(weights.confidence ?? 0.27) +
    overlap * Number(weights.overlap ?? 0.15)
  ).toFixed(3))

  return (
    relevance >= Number(threshold.relevance ?? 1) ||
    composite >= Number(threshold.composite ?? 1) ||
    (confidence >= Number(threshold.confidence ?? 1) && overlap >= Number(threshold.overlap ?? 1))
  )
}

export function buildHintKey(item, overrides = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  const rawText = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '').trim()
  if (!rawText) return ''
  const normalized = cleanMemoryText(rawText).toLowerCase().replace(/\s+/g, ' ').slice(0, 160)
  const signalSubtype = String(overrides.subtype ?? item?.subtype ?? item?.kind ?? '').toLowerCase().trim()
  if (type === 'signal') return `signal:${signalSubtype || normalized}`
  if (type === 'fact' || type === 'proposition') {
    const sourceFactId = Number(item?.source_fact_id ?? overrides.source_fact_id ?? 0)
    return sourceFactId > 0 ? `claim:${sourceFactId}` : `claim:${normalized}`
  }
  return `${type}:${normalized}`
}

export function formatHintTag(item, overrides = {}, options = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  const attrs = [`type="${type}"`]
  const conf = overrides.confidence ?? item?.confidence ?? item?.quality_score ?? item?.effectiveScore
  if (conf != null) attrs.push(`confidence="${Number(conf).toFixed(2)}"`)
  const stage = overrides.stage ?? item?.stage ?? item?.status
  if (stage && (type === 'task' || type === 'signal')) attrs.push(`stage="${stage}"`)
  const ts = overrides.ts ?? item?.updated_at ?? item?.last_seen ?? item?.source_ts ?? item?.created_at
  if (ts) attrs.push(`age="${formatHintAge(ts, options.nowTs)}"`)
  const rel = overrides.relevanceScore ?? computeHintRelevance(item, { queryTokenCount: options.queryTokenCount })
  if (rel != null) attrs.push(`relevance="${Number(rel).toFixed(2)}"`)
  const text = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '').slice(0, 200)
  return `<hint ${attrs.join(' ')}>${text}</hint>`
}
