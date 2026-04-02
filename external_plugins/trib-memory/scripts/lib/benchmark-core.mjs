import { readFileSync } from 'node:fs'
import { buildTemporalOverride, parseTimerange } from './benchmark-runtime.mjs'

export function normalizeCase(raw, defaults = {}) {
  const expectedAny = []

  const pushMany = (value) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) pushMany(item)
      return
    }
    const clean = String(value).trim()
    if (clean) expectedAny.push(clean)
  }

  pushMany(raw.expected)
  pushMany(raw.expected_any)

  return {
    id: String(raw.id ?? raw.label ?? raw.query).trim(),
    label: String(raw.label ?? raw.query).trim(),
    query: String(raw.query ?? '').trim(),
    expected_any: [...new Set(expectedAny)],
    expected_all: (Array.isArray(raw.expected_all) ? raw.expected_all : raw.expected_all ? [raw.expected_all] : [])
      .map(item => String(item).trim())
      .filter(Boolean),
    expected_type: (Array.isArray(raw.expected_type) ? raw.expected_type : raw.expected_type ? [raw.expected_type] : [])
      .map(item => String(item).trim())
      .filter(Boolean),
    expected_subtype: (Array.isArray(raw.expected_subtype) ? raw.expected_subtype : raw.expected_subtype ? [raw.expected_subtype] : [])
      .map(item => String(item).trim())
      .filter(Boolean),
    expected_id: raw.expected_id != null ? Number(raw.expected_id) : null,
    timerange: raw.timerange ?? defaults.timerange ?? null,
    start_ts: raw.start_ts ?? defaults.start_ts ?? null,
    end_ts: raw.end_ts ?? defaults.end_ts ?? null,
    filters: {
      memory_kind: raw.memory_kind ?? defaults.memory_kind,
      task_status: raw.task_status ?? defaults.task_status,
      source_type: raw.source_type ?? defaults.source_type,
      session_id: raw.session_id ?? defaults.session_id,
      start_ts: raw.start_ts ?? defaults.start_ts,
      end_ts: raw.end_ts ?? defaults.end_ts,
    },
  }
}

export function loadCases(filePath, defaults = {}) {
  const raw = readFileSync(filePath, 'utf8').trim()
  if (!raw) return []
  const parsed = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => JSON.parse(line))
  return parsed.map(item => normalizeCase(item, defaults)).filter(item => item.query)
}

function itemContent(item) {
  return String(item?.content ?? item?.text ?? '').toLowerCase()
}

function matchesExpectation(item, testCase) {
  if (!item) return false
  const content = itemContent(item)
  if (testCase.expected_id != null && Number(item?.entity_id ?? item?.id) !== Number(testCase.expected_id)) return false
  if (testCase.expected_type.length > 0 && !testCase.expected_type.includes(String(item?.type ?? ''))) return false
  if (testCase.expected_subtype.length > 0 && !testCase.expected_subtype.includes(String(item?.subtype ?? ''))) return false
  if (testCase.expected_all.length > 0 && !testCase.expected_all.every(token => content.includes(String(token).toLowerCase()))) return false
  if (testCase.expected_any.length > 0 && !testCase.expected_any.some(token => content.includes(String(token).toLowerCase()))) return false
  return true
}

function findFirstMatchRank(items, testCase) {
  for (let i = 0; i < items.length; i += 1) {
    if (matchesExpectation(items[i], testCase)) return i + 1
  }
  return null
}

export async function runBenchmarkCases(store, cases, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 5))
  const topK = Math.max(1, Number(options.topK ?? 3))
  const includeCases = options.includeCases !== false
  const includeTop = options.includeTop !== false
  const totals = { hit1: 0, hitK: 0, mrr: 0, matched: 0 }
  const caseOutputs = []

  for (const testCase of cases) {
    const { trStart, trEnd } = parseTimerange(testCase.timerange)
    const temporal = buildTemporalOverride(trStart, trEnd)
    const results = await store.searchRelevantHybrid(testCase.query, limit * 2, {
      temporal,
      filters: testCase.filters,
      recordRetrieval: false,
    })
    const items = Array.isArray(results) ? results : (results?.results ?? [])
    const rank = findFirstMatchRank(items, testCase)
    const caseSummary = {
      id: testCase.id,
      label: testCase.label,
      query: testCase.query,
      timerange: testCase.timerange,
      expected_any: testCase.expected_any,
      expected_all: testCase.expected_all,
      rank,
      ...(includeTop ? { top: items.slice(0, topK) } : {}),
    }

    if (rank != null) {
      totals.matched += 1
      totals.mrr += 1 / rank
      if (rank === 1) totals.hit1 += 1
      if (rank <= topK) totals.hitK += 1
    }

    if (includeCases) caseOutputs.push(caseSummary)
  }

  return {
    top_k: topK,
    cases: includeCases ? caseOutputs : [],
    summary: {
      hit_at_1: totals.hit1 / cases.length,
      hit_at_k: totals.hitK / cases.length,
      mrr: totals.mrr / cases.length,
      matched: totals.matched,
      total: cases.length,
    },
  }
}
