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
    w_class: 0.5,
    w_topic: 0.3,
    w_element: 0.2,
    gain: 0.35,
  },
  state: {
    '진행 중': 1.1,
    '확인 필요': 1.05,
    '완료': 0.9,
    default: 1.0,
  },
  time: {
    decayPerDay: 0.02,
    min: 0.8,
    max: 1.4,
    recentBoostDays: 3,
    recentBoost: 1.2,
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

export function computeSemanticFactor(item, query, config = DEFAULT_SCORING) {
  const sem = config.semantic
  const classMatch = fuzzyFieldMatch(item.classification, query)
  const topicMatch = fuzzyFieldMatch(item.topic, query)
  const elementMatch = fuzzyFieldMatch(item.element, query)
  const raw = sem.w_class * classMatch + sem.w_topic * topicMatch + sem.w_element * elementMatch
  return 1 + raw * sem.gain
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

// ── Time factor ──────────────────────────────────────────────────────

export function computeTimeFactor(ts, config = DEFAULT_SCORING) {
  if (!ts) return config.time.default ?? 1.0
  const ageDays = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000)
  if (ageDays <= config.time.recentBoostDays) return config.time.recentBoost
  const decay = 1.0 - ageDays * config.time.decayPerDay
  return Math.max(config.time.min, Math.min(config.time.max, decay))
}

// ── Language factor ──────────────────────────────────────────────────

export function computeLanguageFactor(itemLang, queryLang, config = DEFAULT_SCORING) {
  if (!itemLang || !queryLang) return 1.0
  return itemLang === queryLang ? config.language.match : config.language.mismatch
}

// ── Combined final score ─────────────────────────────────────────────

export function computeFinalScore(baseScore, item, query, options = {}) {
  const config = options.config ?? DEFAULT_SCORING
  const semanticFactor = item.type === 'classification'
    ? computeSemanticFactor(item, query, config)
    : 1.0
  const stateFactor = computeStateFactor(item.state, config)
  const timeFactor = computeTimeFactor(item.source_ts ?? item.updated_at, config)
  const langFactor = computeLanguageFactor(options.itemLang, options.queryLang, config)
  return baseScore * semanticFactor * stateFactor * timeFactor * langFactor
}
