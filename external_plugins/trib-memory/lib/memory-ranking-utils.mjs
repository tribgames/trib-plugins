import { cleanMemoryText } from './memory-extraction.mjs'

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

export function compactRetrievalContent(item) {
  const raw = cleanMemoryText(item?.content ?? '')
  if (!raw) return ''
  if (item?.type === 'episode') return raw.slice(0, 160)
  return raw.slice(0, 260)
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
