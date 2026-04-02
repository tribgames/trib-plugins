import { getEmbeddingDims } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import { insertCandidateUnits } from './memory-text-utils.mjs'

export function getEpisodesSince(store, timestamp) {
  const ts = typeof timestamp === 'number'
    ? new Date(timestamp).toISOString()
    : String(timestamp)
  return store.db.prepare(`
    SELECT id, ts, role, kind, content
    FROM episodes
    WHERE ts > ?
    ORDER BY ts, id
  `).all(ts)
}

export function countEpisodes(store) {
  return store.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n
}

export function getCandidatesForDate(store, dayKey) {
  return store.db.prepare(`
    SELECT mc.id, mc.episode_id, mc.ts, mc.role, mc.content, mc.score
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.day_key = ?
      AND mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    ORDER BY mc.score DESC, mc.ts ASC
  `).all(dayKey)
}

export function getPendingCandidateDays(store, limit = 7, minCount = 1) {
  return store.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    GROUP BY mc.day_key
    HAVING count(*) >= ?
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(minCount, limit)
}

export function getDecayRows(_store, _kind = 'fact') {
  return []
}

export function markRowsDeprecated(_store, _kind = 'fact', _ids = [], _seenAt = null) {
  return 0
}

export function listDeprecatedIds(_store, _kind = 'fact', _olderThan = '') {
  return []
}

export function deleteRowsByIds(_store, _kind = 'fact', _ids = []) {
  return 0
}

export function resetEmbeddingIndex(store, options = {}) {
  store.clearVectorsStmt.run()
  try { store.db.prepare('DELETE FROM pending_embeds').run() } catch {}
  if (store.vecEnabled) {
    try {
      store.db.exec('DROP TABLE IF EXISTS vec_memory')
      store.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${getEmbeddingDims()}])`)
    } catch {}
  }
  store.syncEmbeddingMetadata({
    reason: options.reason ?? 'reset_embedding_index',
    reindexRequired: 1,
    reindexReason: options.reindexReason ?? 'embedding index reset',
  })
}

export function vacuumDatabase(store) {
  try {
    store.db.exec('VACUUM')
    return true
  } catch {
    return false
  }
}

export function getRecentCandidateDays(store, limit = 7) {
  return store.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE e.role = 'user'
      AND e.kind = 'message'
    GROUP BY mc.day_key
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(limit)
}

export function countPendingCandidates(store, dayKey = null) {
  if (dayKey) {
    return store.db.prepare(`
      SELECT count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.status = 'pending'
        AND mc.day_key = ?
        AND e.role = 'user'
        AND e.kind = 'message'
    `).get(dayKey).n
  }
  return store.db.prepare(`
    SELECT count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role = 'user'
      AND e.kind = 'message'
  `).get().n
}

export function rebuildCandidates(store) {
  store.clearCandidatesStmt.run()
  const rows = store.db.prepare(`
    SELECT id, ts, day_key, role, kind, content
    FROM episodes
    ORDER BY ts, id
  `).all()
  let created = 0
  for (const row of rows) {
    const clean = cleanMemoryText(row.content)
    if (!clean) continue
    const shouldCandidate = row.role === 'user' && row.kind === 'message'
    if (shouldCandidate) {
      created += insertCandidateUnits(store.insertCandidateStmt, row.id, row.ts, row.day_key, row.role, clean)
    }
  }
  return created
}

export function resetConsolidatedMemory(store) {
  store.clearClassificationsStmt.run()
  store.clearClassificationsFtsStmt.run()
  store.clearCandidatesStmt.run()
  store.clearVectorsStmt.run()
  if (store.vecEnabled) {
    try { store.db.exec('DELETE FROM vec_memory') } catch {}
  }
  store.db.prepare(`UPDATE memory_candidates SET status = 'pending'`).run()
}

export function resetConsolidatedMemoryForDays(store, dayKeys = []) {
  const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
  if (keys.length === 0) return

  const placeholders = keys.map(() => '?').join(', ')
  const episodeIds = store.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

  if (episodeIds.length > 0) {
    const episodePlaceholders = episodeIds.map(() => '?').join(', ')

    const classificationIds = store.db.prepare(`
      SELECT id FROM classifications WHERE episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (classificationIds.length > 0) {
      const clsPlaceholders = classificationIds.map(() => '?').join(', ')
      for (const id of classificationIds) store.deleteClassificationFtsStmt.run(id)
      store.db.prepare(`DELETE FROM classifications WHERE id IN (${clsPlaceholders})`).run(...classificationIds)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${clsPlaceholders})`).run(...classificationIds)
      if (store.vecEnabled) {
        for (const id of classificationIds) {
          const rowid = store._vecRowId('classification', id)
          try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
    }
  }

  store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'pending'
    WHERE day_key IN (${placeholders})
  `).run(...keys)
}

export function pruneConsolidatedMemoryOutsideDays(store, dayKeys = []) {
  const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
  if (keys.length === 0) return

  const placeholders = keys.map(() => '?').join(', ')
  const keepEpisodeIds = store.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

  if (keepEpisodeIds.length === 0) return
  const keepPlaceholders = keepEpisodeIds.map(() => '?').join(', ')

  const staleClassificationIds = store.db.prepare(`
    SELECT id FROM classifications
    WHERE episode_id IS NOT NULL
      AND episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
  if (staleClassificationIds.length > 0) {
    const stalePlaceholders = staleClassificationIds.map(() => '?').join(', ')
    for (const id of staleClassificationIds) store.deleteClassificationFtsStmt.run(id)
    store.db.prepare(`DELETE FROM classifications WHERE id IN (${stalePlaceholders})`).run(...staleClassificationIds)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${stalePlaceholders})`).run(...staleClassificationIds)
    if (store.vecEnabled) {
      for (const id of staleClassificationIds) {
        const rowid = store._vecRowId('classification', id)
        try { store.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
      }
    }
  }
}

export function markCandidateIdsConsolidated(store, candidateIds = []) {
  const ids = [...new Set(candidateIds.map(id => Number(id)).filter(Number.isFinite))]
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const stmt = store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'consolidated'
    WHERE status = 'pending'
      AND id IN (${placeholders})
  `)
  const result = stmt.run(...ids)
  return Number(result.changes ?? 0)
}

export function markCandidatesConsolidated(store, dayKey) {
  return Number(store.db.prepare(`
    UPDATE memory_candidates
    SET status = 'consolidated'
    WHERE day_key = ? AND status = 'pending'
  `).run(dayKey).changes ?? 0)
}
