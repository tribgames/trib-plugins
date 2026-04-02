function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

export const DEFAULT_MEMORY_TUNING = Object.freeze({
  devBias: {
    queryThreshold: 0.3,
    taskBoost: 0.25,
    decisionBoost: 0.15,
    profileSuppress: 0.15,
    eventSuppress: 0.08,
    workstreamBoost: 0.2,
    generalSuppress: 0.6,
  },
  intent: {
    topScoreMin: 0.74,
    gapMin: 0.05,
  },
  secondStageThreshold: {
    default: -0.30,
    profile: -0.28,
    task: -0.28,
    policy: -0.30,
    history: -0.26,
    event: -0.26,
    graph: -0.32,
  },
  hintInjection: {
    compositeWeights: {
      relevance: 0.58,
      confidence: 0.27,
      overlap: 0.15,
    },
    thresholds: {
      default: { relevance: 0.65, composite: 0.60, confidence: 1, overlap: 1 },
      profile: { relevance: 0.74, composite: 0.7, confidence: 0.86, overlap: 0.34 },
      signal: { relevance: 0.78, composite: 0.74, confidence: 0.88, overlap: 0.34 },
      task: { relevance: 0.62, composite: 0.58, confidence: 0.88, overlap: 0.34 },
      fact: { relevance: 0.62, composite: 0.58, confidence: 0.9, overlap: 0.34 },
      proposition: { relevance: 0.62, composite: 0.58, confidence: 0.9, overlap: 0.34 },
    },
  },
  taskSeed: {
    stageBonus: {
      implementing: 0.42,
      wired: 0.34,
      verified: 0.26,
      investigating: 0.12,
      planned: -0.24,
      done: 0.08,
    },
    statusBonus: {
      in_progress: 0.28,
      active: 0.22,
      paused: -0.06,
      done: 0.68,
      doneExcluded: -0.32,
    },
    priorityBonus: {
      high: 0.14,
      normal: 0.06,
      low: 0,
    },
    ongoingQuery: {
      plannedPenalty: -1.05,
      pausedPenalty: -0.2,
      activeBonus: 0.22,
      inProgressBonus: 0.28,
    },
  },
  history: {
    representative: {
      overlapMultiplier: 6,
      semanticMultiplier: 4,
      contentLengthDivisor: 180,
      contentLengthMax: 1.25,
      assistantBonus: 0.2,
      turnBonus: 0.1,
      recencyBonus: 0.000001,
    },
    exactDate: {
      overlapMultiplier: 8,
      weightedScoreMultiplier: -1,
      contentLengthDivisor: 180,
      contentLengthMax: 1.2,
      assistantBonus: 0.24,
      turnBonus: 0.12,
    },
  },
  weights: {
    recency: {
      maxPenalty: 0.4,
      stabilityStep: 0.8,
      maxRetrievalFactor: 5,
      windowDays: 15,
    },
    overlap: {
      defaultMax: 0.38,
      policyMax: 0.50,
      historyMax: 0.42,
    },
    retrieval: {
      maxBoost: 0.08,
      step: 0.01,
    },
    focus: {
      maxBoost: 0.14,
      multiplier: 0.12,
    },
    quality: {
      strongMax: 0.12,
      strongMultiplier: 0.3,
      lightMax: 0.08,
      lightMultiplier: 0.2,
    },
    densityPenalty: {
      signalNoOverlap: 0.12,
      episodeNoOverlap: 0.1,
    },
    entityBoost: {
      entityMatch: -0.28,
      relationMatch: -0.24,
      scopedMatch: -0.26,
    },
    doneTask: {
      doneBoost: -0.42,
      activePenalty: 0.28,
    },
    taskStagePenalty: {
      planned: 0.18,
      investigating: 0.08,
      implementing: -0.05,
      wired: -0.04,
      verified: -0.03,
    },
    relationPenalty: {
      default: 0.12,
    },
    typeBoost: {
      fact: {
        preference: -0.16,
        constraint: -0.15,
        decision: -0.11,
        default: -0.09,
      },
      task: -0.1,
      proposition: -0.12,
      entity: -0.08,
      relation: -0.1,
      profile: -0.08,
      signal: {
        tone: -0.08,
        language: -0.08,
        default: -0.04,
      },
      episode: -0.04,
    },
    intentBoost: {
      profile: {
        fact: { preference: -0.18, constraint: -0.18 },
        proposition: -0.14,
        signal: { tone: -0.14, language: -0.14 },
        profile: -0.22,
        task: 0.1,
        episode: 0.12,
      },
      task: {
        task: -0.26,
        proposition: 0.04,
        fact: { decision: 0.04, constraint: 0.02, default: 0.12 },
        signal: 0.12,
        episode: 0.12,
      },
      policy: {
        fact: { constraint: -0.18, decision: -0.1 },
        proposition: -0.14,
        relation: -0.08,
        entity: -0.06,
        signal: -0.04,
        task: 0.08,
        episode: 0.04,
      },
      event: {
        episode: -0.22,
        proposition: -0.12,
        taskWithSource: -0.06,
        factWithSource: -0.04,
        signal: 0.08,
      },
      history: {
        episode: -0.12,
        proposition: -0.12,
        entity: -0.1,
        relation: -0.1,
        task: -0.04,
        signal: 0.06,
      },
      decision: {
        fact: { decision: -0.12, constraint: -0.10 },
        proposition: -0.12,
        entity: -0.12,
        relation: -0.14,
        profile: -0.08,
        task: -0.03,
      },
    },
  },
  reranker: {
    enabled: false,
    model: 'Xenova/bge-reranker-large',
    triggerThreshold: -0.4,
    minRerankerScore: -2,
    maxCandidates: 5,
  },
})

export function mergeMemoryTuning(overrides = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_MEMORY_TUNING))
  return deepMerge(base, overrides)
}
