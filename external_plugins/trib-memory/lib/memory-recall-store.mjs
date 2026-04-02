import { embedText } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import {
  buildFtsQuery,
  tokenizeMemoryText,
} from './memory-text-utils.mjs'
import { vecToHex } from './memory-vector-utils.mjs'
import { applyMetadataFilters } from './memory-retrievers.mjs'
export { applyMetadataFilters }

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`
const DEBUG_RECALL_EPISODE_KIND_SQL = `'message', 'turn', 'transcript'`



export function getProfileRecallRows(_store, _query = '', _limit = 5) {
  return []
}

export function getPolicyRecallRows(_store, _query = '', _limit = 5, _options = {}) {
  return []
}

export function getEntityRecallRows(_store, _query = '', _limit = 5) {
  return []
}

export function getRelationRecallRows(_store, _query = '', _limit = 5) {
  return []
}

export async function verifyMemoryClaim(store, query, options = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return []
  const verifyLimit = Math.max(1, Math.min(Number(options.limit ?? 3), 5))
  const queryVector = options.queryVector ?? await embedText(clean)
  const ftsQuery = String(options.ftsQuery ?? '').trim()
  const matchesById = new Map()

  const registerMatch = (row, extras = {}) => {
    const id = Number(row.id ?? extras.id ?? 0)
    if (!id) return
    const previous = matchesById.get(id) ?? {}
    const merged = { ...previous, ...row, ...extras, type: 'classification' }
    const normalizedQuery = clean.toLowerCase()
    const content = [merged.classification, merged.topic, merged.element, merged.state].filter(Boolean).join(' ')
    const normalizedText = cleanMemoryText(merged.text ?? content ?? '').toLowerCase()
    const queryTokens = tokenizeMemoryText(clean)
    const lexicalHits = queryTokens.filter(token => normalizedText.includes(token)).length
    const lexicalOverlap = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0
    const literalMatch = normalizedText.includes(normalizedQuery)
    const similarity = Number(merged.similarity ?? previous.similarity ?? 0)
    const exactBoost = literalMatch ? 0.18 : 0
    const lexicalBoost = Math.min(0.45, lexicalOverlap * 0.45)
    const semanticBoost = Math.min(0.55, Math.max(0, similarity) * 0.55)
    const verifyScore = Number(Math.min(1, semanticBoost + lexicalBoost + exactBoost).toFixed(3))
    const crossLingual = lexicalOverlap < 0.1 && similarity > 0
    const highConfidenceFound = Number(merged.confidence ?? 0) >= 0.8 && (lexicalOverlap > 0 || similarity > 0.2)
    const accepted = literalMatch || verifyScore >= 0.55 || similarity >= 0.82 || (crossLingual && similarity >= 0.45) || (similarity >= 0.7 && lexicalOverlap >= 0.15) || highConfidenceFound
    matchesById.set(id, {
      ...merged,
      content: normalizedText,
      lexical_overlap: lexicalOverlap,
      literal_match: literalMatch,
      verify_score: verifyScore,
      accepted,
    })
  }

  if (store.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const hex = vecToHex(queryVector)
      const knnRows = store.vecReadDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
      ).all(verifyLimit * 3)
      for (const knn of knnRows) {
        const { entityType, entityId } = store._vecRowToEntity(knn.rowid)
        if (entityType !== 'classification') continue
        const row = store.db.prepare(
          `SELECT id, classification, topic, element, state, confidence, updated_at AS last_seen, status FROM classifications WHERE id = ? AND status = 'active'`
        ).get(entityId)
        if (row) registerMatch(row, { similarity: Number((1 - knn.distance).toFixed(3)), source: 'vector' })
      }
    } catch {}
  }

  if (ftsQuery) {
    try {
      const ftsMatches = store.db.prepare(`
        SELECT c.id, c.classification, c.topic, c.element, c.state, c.confidence, c.updated_at AS last_seen, c.status
        FROM classifications_fts
        JOIN classifications c ON c.id = classifications_fts.rowid
        WHERE classifications_fts MATCH ? AND c.status = 'active'
        ORDER BY bm25(classifications_fts)
        LIMIT ?
      `).all(ftsQuery, verifyLimit * 2)
      for (const row of ftsMatches) registerMatch(row, { source: 'fts' })
    } catch {}
  }

  return Array.from(matchesById.values())
    .sort((a, b) => {
      const verifyDelta = Number(b.verify_score ?? 0) - Number(a.verify_score ?? 0)
      if (verifyDelta !== 0) return verifyDelta
      const lexicalDelta = Number(b.lexical_overlap ?? 0) - Number(a.lexical_overlap ?? 0)
      if (lexicalDelta !== 0) return lexicalDelta
      return Number(b.confidence ?? b.similarity ?? 0) - Number(a.confidence ?? a.similarity ?? 0)
    })
    .slice(0, verifyLimit)
}

export async function getEpisodeRecallRows(store, options = {}) {
  const {
    query = '',
    startDate,
    endDate,
    limit = 5,
    queryVector = null,
    ftsQuery = '',
    includeTranscripts = false,
  } = options
  const clean = String(query ?? '').trim()
  const queryLimit = Math.max(1, Number(limit))
  let episodes = []

  if (store.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const hex = vecToHex(queryVector)
      const knnRows = store.vecReadDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
      ).all(queryLimit * 5)
      for (const knn of knnRows) {
        const { entityType, entityId } = store._vecRowToEntity(knn.rowid)
        if (entityType !== 'episode') continue
        const ep = store.db.prepare(`
          SELECT id, ts, day_key, role, kind, content, source_ref, backend AS source_backend
          FROM episodes
          WHERE id = ? AND day_key >= ? AND day_key <= ?
            AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        `).get(entityId, startDate, endDate)
        if (ep) episodes.push({ ...ep, similarity: 1 - knn.distance })
      }
    } catch {}
  }

  if (episodes.length === 0 && clean) {
    try {
      episodes = store.db.prepare(`
        SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend, bm25(episodes_fts) AS score
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ? AND e.day_key >= ? AND e.day_key <= ?
          AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, startDate, endDate, queryLimit * 2)
    } catch {}
  }

  if (episodes.length === 0 && !clean) {
    episodes = store.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend
      FROM episodes e
      WHERE e.day_key >= ? AND e.day_key <= ?
        AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(startDate, endDate, queryLimit)
  }

  const seen = new Set()
  return episodes.filter(row => {
    const id = Number(row.id ?? row.entity_id ?? 0)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, queryLimit)
}

export async function bulkVerifyHints(store, hints = []) {
  const details = []
  let confirmed = 0
  let outdated = 0
  let unknown = 0

  for (const rawHint of hints) {
    const clean = String(rawHint ?? '').trim()
    if (!clean) {
      unknown += 1
      details.push({ hint: clean, status: '?' })
      continue
    }
    const ftsQuery = clean.replace(/['"*\-(){}[\]^~:]/g, ' ').replace(/\b(OR|AND|NOT|NEAR)\b/gi, '').trim()
    const matches = await verifyMemoryClaim(store, clean, { limit: 1, ftsQuery })
    const bestMatch = matches[0]
    if (bestMatch) {
      const status = bestMatch.status === 'active' && bestMatch.accepted !== false ? '✓' : '✗'
      if (status === '✓') confirmed += 1
      else outdated += 1
      details.push({
        hint: clean,
        status,
        fact: String(bestMatch.text ?? bestMatch.content ?? ''),
        confidence: Number(bestMatch.confidence ?? bestMatch.similarity ?? 0).toFixed(2),
        mention_count: Number(bestMatch.mention_count ?? 0),
      })
    } else {
      unknown += 1
      details.push({ hint: clean, status: '?' })
    }
  }

  return {
    summary: `✓ confirmed(${confirmed}) ✗ outdated(${outdated}) ? unknown(${unknown})`,
    details,
  }
}

export function getRecallShortcutRows(store, kind = 'all', limit = 5, options = {}) {
  const queryLimit = Math.max(1, Number(limit))
  const { startDate = null, endDate = null } = options
  let rows = []

  if (kind === 'all' || kind === 'episodes') {
    rows.push(...store.db.prepare(`
      SELECT 'episode' AS type, role AS subtype, content, ts AS last_seen
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
        AND content NOT LIKE 'You are consolidating%'
        AND LENGTH(content) >= 10
        ${startDate && endDate ? 'AND day_key >= ? AND day_key <= ?' : ''}
      ORDER BY ts DESC
      LIMIT ?
    `).all(...(startDate && endDate ? [startDate, endDate, kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit] : [kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit])))
  }
  if (kind === 'all' || kind === 'classifications') {
    rows.push(...store.db.prepare(`
      SELECT 'classification' AS type, classification AS subtype,
             trim(classification || ' | ' || topic || ' | ' || element || CASE WHEN state IS NOT NULL AND state != '' THEN ' | ' || state ELSE '' END) AS content,
             confidence, updated_at AS last_seen
      FROM classifications
      WHERE status = 'active'
        ${startDate && endDate ? 'AND day_key >= ? AND day_key <= ?' : ''}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...(startDate && endDate ? [startDate, endDate, kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit] : [kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit])))
  }

  return rows
}

