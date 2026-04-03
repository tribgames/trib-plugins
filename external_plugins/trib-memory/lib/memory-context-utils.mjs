import { cleanMemoryText } from './memory-extraction.mjs'

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
  const weighted = Number(item?.weighted_score)
  if (Number.isFinite(weighted) && weighted > 0) return weighted
  return 0
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

export function formatHintTag(item, overrides = {}, _options = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  if (type === 'classification') {
    const topic = item?.topic || ''
    const element = item?.element || ''
    const text = [topic, element].filter(Boolean).join(' — ')
    return text ? `- ${text}` : ''
  }
  const raw = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '')
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  return text ? `- ${text}` : ''
}
