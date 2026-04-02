import { createHash } from 'crypto'
import { cleanMemoryText } from './memory-extraction.mjs'

export function isProfileIntent(intent) {
  return intent === 'profile'
}

export function isPolicyIntent(intent) {
  return intent === 'policy' || intent === 'security'
}

export const SEED_LANE_PRIOR = Object.freeze({
  decision: -0.22,
  history: -0.20,
})

export const SCOPED_LANE_PRIOR = Object.freeze({
  exact_history_episode: -0.38,
})

export const SECOND_STAGE_THRESHOLD = Object.freeze({
  default: -0.30,
  history: -0.26,
  event: -0.26,
})

function isGenericAssistantEpisode(item) {
  if (String(item?.type ?? '') !== 'episode') return false
  if (String(item?.subtype ?? '').toLowerCase() !== 'assistant') return false
  const clean = cleanMemoryText(item?.content ?? '')
  if (!clean) return false
  if (clean.length <= 18) return true
  return (
    /^네[, ]/.test(clean) ||
    /말씀해 주세요|확인하겠습니다|어떻게 도와|도와드릴까요/i.test(clean)
  )
}

export function getIntentTypeCaps(intent, options = {}) {
  const hasCoreResult = Boolean(options.hasCoreResult)
  const conciseQuery = Boolean(options.conciseQuery)
  if (intent === 'event') return new Map([['episode', 4], ['classification', 2]])
  if (intent === 'history') return new Map([['episode', 3], ['classification', 2]])
  return new Map([
    ['classification', 3],
    ['episode', hasCoreResult ? (conciseQuery ? 1 : 2) : 2],
  ])
}

export function getIntentSubtypeBonus(intent, item) {
  if (intent === 'event') return item.type === 'episode' ? -0.14 : 0
  if (intent === 'history') return item.type === 'episode' ? -0.08 : 0
  if (item.type === 'classification') return -0.06
  if (isGenericAssistantEpisode(item)) return 0.18
  return 0
}

export function shouldKeepRerankItem(_intent, item, _options = {}) {
  if (item.dense_score != null && Number(item.dense_score) < -0.3) return true
  return item.type === 'classification' || item.type === 'episode'
}

export function computeSourceTrustAdjustment(item, primaryIntent = 'decision') {
  const sourceKind = String(item?.source_kind ?? '').toLowerCase().trim()
  const sourceBackend = String(item?.source_backend ?? '').toLowerCase().trim()

  if (sourceKind === 'message') return item?.type === 'episode' ? -0.1 : -0.14
  if (sourceKind === 'transcript') {
    if (item?.type === 'episode' && (primaryIntent === 'event' || primaryIntent === 'history')) return 0.04
    return item?.type === 'episode' ? 0.08 : 0.14
  }
  if (sourceKind === 'turn') return 0.05
  if (sourceBackend === 'discord') return -0.03
  if (sourceBackend === 'claude-session') return 0.04
  return 0
}

export function compactRetrievalContent(item) {
  const raw = cleanMemoryText(item?.content ?? '')
  if (!raw) return ''
  if (item?.type === 'episode') return raw.slice(0, 160)
  return raw.slice(0, 260)
}

function normalizedSurfaceText(item) {
  return cleanMemoryText(item?.content ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function surfaceKey(item) {
  const type = String(item?.type ?? '')
  const entityId = Number(item?.entity_id ?? 0)
  if (entityId > 0) return `${type}:${entityId}`
  const normalized = normalizedSurfaceText(item)
  if (!normalized) return ''
  const hash = createHash('sha1')
    .update(`${type}:${normalized.slice(0, 240)}`)
    .digest('hex')
    .slice(0, 16)
  return `${type}:${hash}`
}

function preferSurfaceCandidate(current, previous, scoreField = 'weighted_score') {
  if (!previous) return true
  const currentScore = Number(current?.[scoreField] ?? current?.weighted_score ?? 0)
  const previousScore = Number(previous?.[scoreField] ?? previous?.weighted_score ?? 0)
  if (currentScore !== previousScore) return currentScore < previousScore
  const currentQuality = Number(current?.quality_score ?? current?.confidence ?? 0)
  const previousQuality = Number(previous?.quality_score ?? previous?.confidence ?? 0)
  if (currentQuality !== previousQuality) return currentQuality > previousQuality
  return Number(current?.retrieval_count ?? 0) > Number(previous?.retrieval_count ?? 0)
}

export function collapseClaimSurfaceDuplicates(items, scoreField = 'weighted_score') {
  const selected = new Map()
  for (const item of items) {
    const key = surfaceKey(item)
    if (!key) continue
    const previous = selected.get(key)
    if (preferSurfaceCandidate(item, previous, scoreField)) {
      selected.set(key, item)
    }
  }
  return [...selected.values()]
}

export function computeSecondStageRerankScore(intent, item, options = {}) {
  const exactHistory = Boolean(options.isHistoryExact)
  const exactDate = String(options.exactDate ?? '')
  const sourceTs = String(item?.source_ts ?? item?.updated_at ?? '')
  const sameDay = exactDate && sourceTs.startsWith(exactDate)

  let bonus = 0
  if (intent === 'event' || intent === 'history') {
    if (item?.type === 'episode') bonus -= 0.10
    if (exactHistory && sameDay && item?.type === 'episode') bonus -= 0.22
    if (exactHistory && sameDay && item?.type === 'classification') bonus -= 0.08
  } else {
    if (item?.type === 'classification') bonus -= 0.12
    if (isGenericAssistantEpisode(item)) bonus += 0.10
  }

  return Number(item?.rerank_score ?? item?.weighted_score ?? 0) + bonus
}
