import { getExactHistoryTypePriority, getResultDayKey } from './memory-query-plan.mjs'
import { DEFAULT_MEMORY_TUNING } from './memory-tuning.mjs'

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`

async function getEpisodeSessionId(store, sourceEpisodeId, cache) {
  const id = Number(sourceEpisodeId ?? 0)
  if (!id) return ''
  if (cache.has(id)) return cache.get(id)
  try {
    const value = String(store.db.prepare(`SELECT session_id FROM episodes WHERE id = ?`).get(id)?.session_id ?? '')
    cache.set(id, value)
    return value
  } catch {
    cache.set(id, '')
    return ''
  }
}

function parseComparableTime(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export async function applyMetadataFilters(store, rows = [], filters = {}) {
  const memoryKind = String(filters.memory_kind ?? '').trim()
  const taskStatus = String(filters.task_status ?? '').trim()
  const sourceType = String(filters.source_type ?? '').trim().toLowerCase()
  const sessionId = String(filters.session_id ?? '').trim()
  const startTs = parseComparableTime(filters.start_ts ?? '')
  const endTs = parseComparableTime(filters.end_ts ?? '')
  if (!memoryKind && !taskStatus && !sourceType && !sessionId && startTs == null && endTs == null) return rows
  const sessionCache = new Map()
  const filtered = []
  for (const row of rows) {
    if (memoryKind && String(row?.type ?? '') !== memoryKind) continue
    if (taskStatus && row?.type === 'task' && String(row?.status ?? '') !== taskStatus) continue
    if (sourceType) {
      const kind = String(row?.source_kind ?? '').toLowerCase()
      const backend = String(row?.source_backend ?? '').toLowerCase()
      if (kind !== sourceType && backend !== sourceType) continue
    }
    if (sessionId) {
      const matchedSessionId = await getEpisodeSessionId(store, row?.source_episode_id ?? row?.entity_id, sessionCache)
      if (matchedSessionId !== sessionId) continue
    }
    if (startTs != null || endTs != null) {
      const rowTs = parseComparableTime(row?.source_ts ?? row?.updated_at ?? '')
      if (rowTs == null) continue
      if (startTs != null && rowTs < startTs) continue
      if (endTs != null && rowTs > endTs) continue
    }
    filtered.push(row)
  }
  return filtered
}

function parseEpisodeTime(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function historyRepresentativeScore(item, options = {}) {
  const cfg = options.historyConfig ?? DEFAULT_MEMORY_TUNING.history.representative
  const overlap = Number(item?.overlapCount ?? 0)
  const semantic = Math.max(0, Number(item?.semanticSimilarity ?? 0))
  const contentLen = String(item?.content ?? '').length
  const subtype = String(item?.subtype ?? '').toLowerCase()
  const clean = String(item?.content ?? '').trim()
  const genericPenalty =
    clean.length < 18 ? 1.8 :
    /^(ok|okay|ㅇㅋ|네|예|응|맞아요)[.!?]?$/i.test(clean) ? 2.2 :
    /보이나요|됐나요|알려주세요|테스트해보시고|결과 알려주세요|포워딩/.test(clean) ? 1.4 :
    /\?$/.test(clean) && clean.length < 40 ? 0.8 :
    0
  return (
    overlap * Number(cfg.overlapMultiplier ?? 6) +
    semantic * Number(cfg.semanticMultiplier ?? 4) +
    Math.min(Number(cfg.contentLengthMax ?? 1.25), contentLen / Math.max(1, Number(cfg.contentLengthDivisor ?? 180))) +
    (subtype === 'assistant' ? Number(cfg.assistantBonus ?? 0.2) : 0) +
    (subtype === 'turn' ? Number(cfg.turnBonus ?? 0.1) : 0) +
    parseEpisodeTime(item?.updated_at) * Number(cfg.recencyBonus ?? 0.000001) -
    genericPenalty
  )
}

function segmentEpisodesByGap(rows = [], gapMinutes = 45) {
  const sorted = [...rows].sort((a, b) => parseEpisodeTime(a.updated_at) - parseEpisodeTime(b.updated_at))
  const segments = []
  let current = []
  for (const row of sorted) {
    const previous = current[current.length - 1]
    if (!previous) {
      current = [row]
      continue
    }
    const gapMs = parseEpisodeTime(row.updated_at) - parseEpisodeTime(previous.updated_at)
    if (gapMs > gapMinutes * 60 * 1000) {
      segments.push(current)
      current = [row]
    } else {
      current.push(row)
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

export async function buildHybridRetrievalInputs(store, plan, queryVector, focusVector) {
  const limit = plan.limit
  const denseRows = await store.searchRelevantDense(plan.query, limit * 2, queryVector, focusVector, {
    includeDoneTasks: plan.includeDoneTasks,
  })
  const sparseRows = [...store.searchRelevantSparse(plan.query, limit * 2)]
  const dense = await applyMetadataFilters(store, denseRows, plan.filters)
  const sparse = await applyMetadataFilters(store, sparseRows, plan.filters)

  if (plan.temporal) {
    const seen = new Set(sparse.map(item => `${item.type}:${item.entity_id}`))
    try {
      const temporalEpisodes = store.db.prepare(`
        SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
               ? AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
        FROM episodes
        WHERE day_key >= ? AND day_key <= ?
          AND kind IN (${RECALL_EPISODE_KIND_SQL})
          AND content NOT LIKE 'You are consolidating%'
          AND LENGTH(content) >= 10
        ORDER BY ts DESC
        LIMIT 6
      `).all(
        (plan.intent.primary === 'event' || plan.intent.primary === 'history') && plan.temporal.exact ? -4.0 : -1.5,
        plan.temporal.start,
        plan.temporal.end,
      )
      for (const episode of temporalEpisodes) {
        if (!seen.has(`episode:${episode.entity_id}`)) {
          sparse.push(episode)
          seen.add(`episode:${episode.entity_id}`)
        }
      }
    } catch {}
  }

  if (plan.isHistoryExact) {
    const exactEpisodeLane = store.db.prepare(`
      SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
             -12.0 AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count,
             NULL AS quality_score, source_ref, ts AS source_ts, kind AS source_kind, backend AS source_backend
      FROM episodes
      WHERE day_key = ?
        AND kind IN (${RECALL_EPISODE_KIND_SQL})
        AND LENGTH(content) >= 10
      ORDER BY ts ASC
      LIMIT ?
    `).all(plan.temporal.start, Math.max(limit, 6))
    const seen = new Set(sparse.map(item => `${item.type}:${item.entity_id}`))
    for (const row of exactEpisodeLane) {
      if (seen.has(`episode:${row.entity_id}`)) continue
      sparse.unshift(row)
      seen.add(`episode:${row.entity_id}`)
    }
  }

  return { sparse, dense }
}

export function applyExactHistorySelection(plan, results, limit, options = {}) {
  if (!plan.isHistoryExact) return results
  const exactDate = plan.temporal.start
  const exactCfg = options.tuning?.history?.exactDate ?? DEFAULT_MEMORY_TUNING.history.exactDate
  const candidates = results.filter(item => getResultDayKey(item) === exactDate)
  const substantiveCandidates = candidates.filter(item => String(item?.content ?? '').trim().length >= 10)
  const score = (item) => {
    const overlap = Number(item?.overlapCount ?? 0)
    const weightedScore = Number(item?.weighted_score ?? item?.score ?? 0)
    const contentLen = String(item?.content ?? '').length
    const subtype = String(item?.subtype ?? '').toLowerCase()
    const clean = String(item?.content ?? '').trim()
    const genericPenalty =
      clean.length < 18 ? 1.6 :
      /^(ok|okay|ㅇㅋ|네|예|응|맞아요)[.!?]?$/i.test(clean) ? 2 :
      /보이나요|됐나요|알려주세요|테스트해보시고|결과 알려주세요|포워딩/.test(clean) ? 1.2 :
      /\?$/.test(clean) && clean.length < 40 ? 0.7 :
      0
    return (
      overlap * Number(exactCfg.overlapMultiplier ?? 8) +
      weightedScore * Number(exactCfg.weightedScoreMultiplier ?? -1) +
      Math.min(Number(exactCfg.contentLengthMax ?? 1.2), contentLen / Math.max(1, Number(exactCfg.contentLengthDivisor ?? 180))) +
      (subtype === 'assistant' ? Number(exactCfg.assistantBonus ?? 0.24) : 0) +
      (subtype === 'turn' ? Number(exactCfg.turnBonus ?? 0.12) : 0) -
      genericPenalty
    )
  }
  const exactDayResults = (substantiveCandidates.length > 0 ? substantiveCandidates : candidates)
    .sort((a, b) => {
      const scoreDelta = score(b) - score(a)
      if (scoreDelta !== 0) return scoreDelta
      const typeDelta = getExactHistoryTypePriority(a) - getExactHistoryTypePriority(b)
      if (typeDelta !== 0) return typeDelta
      return Number(a?.weighted_score ?? a?.score ?? 0) - Number(b?.weighted_score ?? b?.score ?? 0)
    })
  if (exactDayResults.length === 0) return results
  return exactDayResults.slice(0, limit)
}

export function summarizeRetrieverDebug(plan, sparse = [], dense = [], finalResults = []) {
  const summarizeItem = (item) => ({
    type: item?.type ?? null,
    subtype: item?.subtype ?? null,
    entity_id: item?.entity_id ?? null,
    status: item?.status ?? null,
    score: item?.score ?? item?.weighted_score ?? null,
    rerank_score: item?.rerank_score ?? null,
    overlap: item?.overlapCount ?? null,
    content: String(item?.content ?? '').slice(0, 120),
  })

  return {
    plan: {
      retriever: plan.retriever,
      intent: plan.intent?.primary ?? null,
      includeDoneTasks: plan.includeDoneTasks,
      explicitRelationQuery: plan.explicitRelationQuery,
      preferRelations: plan.preferRelations,
      isHistoryExact: plan.isHistoryExact,
      temporal: plan.temporal ?? null,
      entityScope: (plan.queryEntities ?? []).map(item => ({
        id: item.id,
        name: item.name,
        type: item.entity_type,
      })),
    },
    candidate_pool: {
      sparse_count: sparse.length,
      dense_count: dense.length,
      sparse_top: sparse.slice(0, 5).map(summarizeItem),
      dense_top: dense.slice(0, 5).map(summarizeItem),
    },
    final_top: finalResults.slice(0, 5).map(summarizeItem),
  }
}
