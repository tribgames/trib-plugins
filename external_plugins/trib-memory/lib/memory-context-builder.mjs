import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { embedText, getEmbeddingModelId } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import { buildHintKey, formatHintTag } from './memory-context-utils.mjs'
import { readMemoryFeatureFlags } from './memory-ops-policy.mjs'
import { parseTemporalHint } from './memory-query-plan.mjs'
import { looksLowSignalQuery, tokenizeMemoryText } from './memory-text-utils.mjs'
import { cosineSimilarity } from './memory-vector-utils.mjs'

function nextDateStr(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

function readContextBuilderConfig(store) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.dataDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function buildInboundMemoryContext(store, query, options = {}) {
  const clean = cleanMemoryText(query)
  if (!clean) return ''
  if (!options.skipLowSignal && looksLowSignalQuery(clean)) return ''

  const totalStartedAt = Date.now()
  const stageTimings = []
  const tuning = store.getRetrievalTuning()
  const measureStage = async (label, work) => {
    const startedAt = Date.now()
    try {
      return await work()
    } finally {
      stageTimings.push(`${label}=${Date.now() - startedAt}ms`)
    }
  }

  const limit = Number(options.limit ?? 3)
  const lines = []
  const seenHintKeys = new Set()
  const queryTokenCount = Math.max(1, tokenizeMemoryText(clean).length)
  const featureFlags = readMemoryFeatureFlags(readContextBuilderConfig(store))
  const queryVector = await measureStage('embed_query', () => embedText(clean))
  const pushHint = (item, overrides = {}) => {
    const rawText = String(overrides.text ?? item.content ?? item.text ?? item.value ?? '').trim()
    if (!rawText) return
    // weighted_score >= 0.02 threshold (low-quality hints filtered)
    if (item.weighted_score == null || item.weighted_score < 0.02) return
    const key = buildHintKey(item, overrides)
    if (!key) return
    if (seenHintKeys.has(key)) return
    seenHintKeys.add(key)
    lines.push(formatHintTag(item, overrides, { queryTokenCount, nowTs: totalStartedAt }))
  }

  let relevant = await measureStage('hybrid_search', () => store.searchRelevantHybrid(clean, limit, {
    queryVector,
    channelId: options.channelId,
    userId: options.userId,
    recordRetrieval: false,
    tuning,
  }))
  relevant = relevant
    .filter(item => {
      if (item.type !== 'classification' && item.type !== 'episode') return false
      // Filter out short noisy episodes (ㅎㅇ, ㅇㅇ, ㄱㄱ etc.)
      if (item.type === 'episode') {
        const text = String(item.content || '').replace(/\s+/g, '')
        if (text.length < 5) return false
      }
      return true
    })
    .slice(0, Math.max(3, limit))

  if (relevant.length > 0) {
    for (const item of relevant) {
      pushHint(item)
    }
  } else {
    const fallbackClassifications = store.getClassificationRows(4).map(item => ({
      type: 'classification',
      subtype: item.classification,
      content: [item.classification, item.topic, item.element, item.state].filter(Boolean).join(' | '),
      confidence: item.confidence,
      updated_at: item.updated_at,
      entity_id: item.id,
    }))
    for (const item of fallbackClassifications) {
      pushHint(item, { type: 'classification' })
    }
  }

  if (lines.length > 0) {
    try {
      let recentTopics = []
      if (options.channelId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND channel_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.channelId))
      }
      if (recentTopics.length === 0 && options.userId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND user_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.userId))
      }
      if (recentTopics.length > 0) {
        lines.push('<recent>' + recentTopics.map(r => cleanMemoryText(r.content).slice(0, 40)).join(' / ') + '</recent>')
      }
    } catch {}
  }

  // Temporal-based episode injection: temporal keywords get recent episodes
  const temporal = parseTemporalHint(clean)
  if (lines.length === 0 && temporal) {
    try {
      let startDate = null
      let endDate = null
      if (temporal?.start) {
        startDate = temporal.start
        endDate = nextDateStr(temporal.end ?? temporal.start)
      }
      if (!startDate && featureFlags.temporalParser) {
        try {
          const temporalPort = fs.readFileSync(path.join(os.tmpdir(), 'trib-memory', 'temporal-port'), 'utf8').trim()
          const res = await fetch(`http://localhost:${temporalPort}/temporal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: clean, lang: 'ko' }),
            signal: AbortSignal.timeout(1000),
          })
          const data = await res.json()
          if (data.parsed?.length > 0) {
            startDate = data.parsed[0].start
            endDate = nextDateStr(data.parsed[0].end || data.parsed[0].start)
          }
        } catch {}
      }

      // Fallback: history=3 days, event=7 days
      const fallbackDays = '-3 days'
      const dateFilter = startDate
        ? `AND ts >= '${startDate}' AND ts < '${endDate}'`
        : `AND ts >= datetime('now', '${fallbackDays}')`

      const recentEpisodes = store.db.prepare(`
        SELECT ts, role, content FROM episodes
        WHERE kind IN ('message', 'turn')
          AND content NOT LIKE 'You are consolidating%'
          AND content NOT LIKE 'You are improving%'
          AND LENGTH(content) BETWEEN 10 AND 500
          ${dateFilter}
        ORDER BY ts DESC
        LIMIT 5
      `).all()
      for (const ep of recentEpisodes) {
        const prefix = ep.role === 'user' ? 'u' : 'a'
        const text = cleanMemoryText(ep.content).slice(0, 150)
        lines.push(`<hint type="episode" age="${ep.ts}">[${prefix}] ${text}</hint>`)
      }
    } catch {}
  }

  // Passive mention tracking: update decay counters for core_memory items
  // that are semantically similar to the user message (fire-and-forget)
  if (Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const activeModel = getEmbeddingModelId()
      const coreMemoryVectors = store.db.prepare(`
        SELECT mv.entity_id, mv.vector_json
        FROM memory_vectors mv
        JOIN core_memory cm ON cm.id = mv.entity_id
        WHERE mv.entity_type = 'core_memory'
          AND mv.model = ?
          AND cm.status = 'active'
      `).all(activeModel)
      const nowTs = Math.floor(Date.now() / 1000)
      const mentionedIds = []
      for (const row of coreMemoryVectors) {
        try {
          const vec = JSON.parse(row.vector_json)
          if (!Array.isArray(vec) || vec.length === 0) continue
          const sim = cosineSimilarity(queryVector, vec)
          if (sim >= 0.4) mentionedIds.push(row.entity_id)
        } catch { /* skip malformed vectors */ }
      }
      if (mentionedIds.length > 0) {
        const placeholders = mentionedIds.map(() => '?').join(',')
        store.db.prepare(`
          UPDATE core_memory
          SET retrieval_count = retrieval_count + 1,
              last_retrieved_at = ?
          WHERE id IN (${placeholders})
        `).run(nowTs, ...mentionedIds)
      }
    } catch { /* passive tracking should never break hint delivery */ }
  }

  const validLines = lines.filter(l => l && l.trim())
  if (validLines.length === 0) return ''
  const ctx = `<memory-context>\n${validLines.join('\n')}\n</memory-context>`
  const totalMs = Date.now() - totalStartedAt
  process.stderr.write(
    `[memory-timing] q="${clean.slice(0, 40)}" total=${totalMs}ms ${stageTimings.join(' ')}\n`,
  )
  process.stderr.write(`[memory] recall q="${clean.slice(0, 40)}" hints=${lines.filter(l => l.startsWith('<hint ')).length}\n`)
  return ctx
}
