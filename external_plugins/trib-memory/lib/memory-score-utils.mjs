/**
 * memory-score-utils.mjs — Scoring pipeline per RETRIEVAL-CLASSIFICATION-PLAN.md
 *
 * base_score = keyword_score + embedding_score + time_score
 * semantic_factor = 1 + (semantic_raw * semantic_gain)
 *   where semantic_raw = w_class * class_match + w_topic * topic_match + w_element * element_match
 * final_score = base_score * semantic_factor * state_factor * time_factor * language_factor
 */

// ── Defaults (overridable via config.json retrieval.scoring) ─────────

const DEFAULT_SCORING = {
  semantic: {
    w_topic: 0.30,
    w_element: 0.70,
    gain: 0.5,
    vectorThreshold: 0.45,
    maxBonusRatio: 1.0,
  },
  state: {
    '진행 중': 1.1,
    '확인 필요': 1.05,
    '완료': 0.9,
    default: 1.0,
  },
  time: {
    halfLifeDays: 30,
    alpha: 0.3,
    min: 0.5,
  },
  language: {
    match: 1.05,
    mismatch: 0.95,
  },
}

export function getScoringConfig(tuning = {}) {
  const cfg = tuning?.scoring ?? {}
  return {
    semantic: { ...DEFAULT_SCORING.semantic, ...cfg.semantic },
    state: { ...DEFAULT_SCORING.state, ...cfg.state },
    time: { ...DEFAULT_SCORING.time, ...cfg.time },
    language: { ...DEFAULT_SCORING.language, ...cfg.language },
  }
}

// ── Semantic factor ──────────────────────────────────────────────────

export function computeSemanticFactor(item, query, config = DEFAULT_SCORING, options = {}) {
  const sem = config.semantic
  // 벡터 기반 semantic matching — query vector와 item vector의 cosine similarity
  if (options.queryVector && item.vector_json) {
    try {
      const itemVector = typeof item.vector_json === 'string' ? JSON.parse(item.vector_json) : item.vector_json
      if (Array.isArray(itemVector) && Array.isArray(options.queryVector) && itemVector.length === options.queryVector.length) {
        const similarity = cosineSim(options.queryVector, itemVector)
        const threshold = sem.vectorThreshold ?? 0.45
        if (similarity > threshold) {
          return 1 + (similarity - threshold) / (1 - threshold) * sem.gain
        }
        return 1.0
      }
    } catch {}
  }
  // fallback: 텍스트 매칭
  const topicMatch = fuzzyFieldMatch(item.topic, query)
  const elementMatch = fuzzyFieldMatch(item.element, query)
  const raw = sem.w_topic * topicMatch + sem.w_element * elementMatch
  return 1 + raw * sem.gain
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

function fuzzyFieldMatch(field, query) {
  if (!field || !query) return 0
  const f = String(field).toLowerCase()
  const q = String(query).toLowerCase()
  if (f === q) return 1.0
  if (q.includes(f) || f.includes(q)) return 0.8
  const fTokens = f.split(/\s+/)
  const qTokens = q.split(/\s+/)
  const overlap = fTokens.filter(t => t.length >= 2 && qTokens.some(qt => qt.includes(t) || t.includes(qt))).length
  if (overlap === 0) return 0
  return Math.min(1.0, overlap / Math.max(1, fTokens.length) * 0.7)
}

// ── State factor ─────────────────────────────────────────────────────

export function computeStateFactor(state, config = DEFAULT_SCORING) {
  const s = String(state ?? '').trim()
  if (!s) return config.state.default ?? 1.0
  return config.state[s] ?? config.state.default ?? 1.0
}

// ── Importance tag factors (MEMORY-DECAY-PLAN.md) ───────────────────

const TAG_FACTORS = {
  rule: 0.0,
  directive: 0.1,
  preference: 0.15,
  decision: 0.2,
  incident: 0.5,
  transient: 1.5,
}

export function getTagFactor(importance) {
  if (!importance) return 1.0
  const tags = String(importance).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  if (tags.length === 0) return 1.0
  const factors = tags.map(t => TAG_FACTORS[t] ?? 1.0)
  return Math.min(...factors)
}

// ── Time factor ──────────────────────────────────────────────────────

export function computeTimeFactor(ts, config = DEFAULT_SCORING, importance = null) {
  if (!ts) return 1.0
  const ageDays = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000)
  // power-law decay: 1 / (1 + age/halfLife)^alpha
  const halfLife = config.time.halfLifeDays ?? 30
  const alpha = config.time.alpha ?? 0.3
  const decay = 1 / Math.pow(1 + ageDays / halfLife, alpha)
  // tag-based decay modulation: loss * tag_factor
  const tagFactor = getTagFactor(importance)
  const loss = 1 - decay
  const actualLoss = loss * tagFactor
  return Math.max(config.time.min ?? 0.2, 1 - actualLoss)
}

// ── Importance boost (search time) ──────────────────────────────────

export function computeImportanceBoost(importance) {
  const tagFactor = getTagFactor(importance)
  return 1 + (1 - tagFactor) * 0.05
}

// ── Language factor ──────────────────────────────────────────────────

export function computeLanguageFactor(itemLang, queryLang, config = DEFAULT_SCORING) {
  if (!itemLang || !queryLang) return 1.0
  return itemLang === queryLang ? config.language.match : config.language.mismatch
}

// ── Combined final score ─────────────────────────────────────────────

export function computeFinalScore(baseScore, item, query, options = {}) {
  const config = options.config ?? DEFAULT_SCORING
  const importanceBoost = computeImportanceBoost(item.importance)
  return baseScore * importanceBoost
}
