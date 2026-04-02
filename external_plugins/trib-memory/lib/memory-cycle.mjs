/**
 * memory-cycle.mjs — Memory consolidation and cleanup cycle.
 * Standalone memory consolidation module.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { cleanMemoryText, getMemoryStore } from './memory.mjs'
import { classifyCandidateConcept } from './memory-extraction.mjs'
import { embedText, configureEmbedding } from './embedding-provider.mjs'
import { callLLM } from './llm-provider.mjs'
import { cosineSimilarity as cosineSimilarityShared } from './memory-vector-utils.mjs'

const PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || (() => {
  const candidates = [
    join(homedir(), '.claude', 'plugins', 'data', 'trib-memory-trib-memory'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'memory.sqlite'))) return c
  }
  return candidates[0]
})()
const HISTORY_DIR = join(PLUGIN_DATA_DIR, 'history')
const CONFIG_PATH = join(PLUGIN_DATA_DIR, 'memory-cycle.json')

// ── Cycle State (waterfall chaining) ──
const CYCLE_STATE_PATH = join(tmpdir(), 'trib-memory', 'cycle-state.json')

const DEFAULT_CYCLE_STATE = {
  cycle1: { lastRunAt: null, interval: '5m' },
  cycle2: { lastRunAt: null, schedule: '03:00' },
  cycle3: { lastRunAt: null, schedule: 'sunday 03:00' },
}

const CYCLE_WRITE_PRIORITY = {
  cycle1: 1,
  cycle2: 1,
  cycle3: 2,
}

let _cycleWriteActive = false
let _cycleWriteSeq = 0
const _cycleWriteQueue = []

function enqueueCycleWrite(kind, work) {
  return new Promise((resolve, reject) => {
    _cycleWriteQueue.push({
      kind,
      priority: CYCLE_WRITE_PRIORITY[kind] ?? 1,
      seq: _cycleWriteSeq++,
      work,
      resolve,
      reject,
    })
    _cycleWriteQueue.sort((left, right) => right.priority - left.priority || left.seq - right.seq)
    void pumpCycleWriteQueue()
  })
}

async function pumpCycleWriteQueue() {
  if (_cycleWriteActive) return
  const next = _cycleWriteQueue.shift()
  if (!next) return
  _cycleWriteActive = true
  try {
    const result = await next.work()
    next.resolve(result)
  } catch (error) {
    next.reject(error)
  } finally {
    _cycleWriteActive = false
    if (_cycleWriteQueue.length > 0) void pumpCycleWriteQueue()
  }
}

export function loadCycleState() {
  try {
    const raw = readFileSync(CYCLE_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CYCLE_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_CYCLE_STATE }
  }
}

export function saveCycleState(state) {
  const dir = join(tmpdir(), 'trib-memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(CYCLE_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

const MAX_MEMORY_CONSOLIDATE_DAYS = 2
const MAX_MEMORY_CANDIDATES_PER_DAY = 40
const MAX_MEMORY_CONTEXTUALIZE_ITEMS = 24
const MEMORY_FLUSH_DEFAULT_MAX_DAYS = 1
const MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES = 20
const MEMORY_FLUSH_DEFAULT_MAX_BATCHES = 1
const MEMORY_FLUSH_DEFAULT_MIN_PENDING = 8

// Tier 2 (Auto-flush) thresholds
const AUTO_FLUSH_THRESHOLD = 15
const AUTO_FLUSH_INTERVAL_MS = 2 * 60 * 60 * 1000  // 2 hours

function resolveCycleBackfillLimit(mainConfig, fallback) {
  return Math.max(1, Number(mainConfig?.memory?.runtime?.startup?.backfill?.limit ?? fallback))
}

function resolveEmbeddingRefreshOptions(mainConfig = {}, kind = 'cycle2') {
  const cycleConfig = mainConfig?.memory?.[kind] ?? {}
  const refreshConfig = cycleConfig?.embeddingRefresh ?? {}
  const contextualizeItems = Math.max(
    4,
    Number(refreshConfig.contextualizeItems ?? MAX_MEMORY_CONTEXTUALIZE_ITEMS),
  )
  const perTypeLimit = Math.max(
    4,
    Number(refreshConfig.perTypeLimit ?? Math.max(16, Math.floor(contextualizeItems / 2))),
  )
  return { contextualizeItems, perTypeLimit }
}

function getStore() {
  const mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding ?? {}
  if (embeddingConfig.provider || embeddingConfig.ollamaModel) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
    })
  }
  return getMemoryStore(PLUGIN_DATA_DIR)
}

function readCycleConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function writeCycleConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

function resourceDir() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT
  try {
    const pluginJson = JSON.parse(readFileSync(join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', 'plugin.json'), 'utf8'))
    if (pluginJson?.version) return join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', pluginJson.version)
  } catch {}
  return join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', '0.0.1')
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

function parseClassificationCsv(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:csv)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : trimmed
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  const startIdx = lines[0]?.toLowerCase().includes('case_id') ? 1 : 0
  const items = []
  for (let i = startIdx; i < lines.length; i++) {
    // CSV 파싱: 따옴표 안의 쉼표 보호
    const parts = []
    let cur = '', inQuote = false
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === ',' && !inQuote) { parts.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    parts.push(cur.trim())
    if (parts.length < 3) continue
    // case_id,text,classification,topic,element,state
    items.push({
      case_id: parts[0],
      classification: parts[2] || '',
      topic: parts[3] || '',
      element: parts[4] || '',
      state: parts[5] || '',
    })
  }
  return items.length > 0 ? { items } : null
}

// Delegate to shared implementation
function cosineSimilarity(a, b) {
  return cosineSimilarityShared(a, b)
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))))]
}

export async function buildSemanticDayPlan(dayEpisodes) {
  const rows = dayEpisodes.map((ep, i) => ({ index: i, id: ep.id, role: ep.role, content: cleanMemoryText(ep.content ?? '') })).filter(r => r.content)
  if (rows.length <= 1) return { rows, segments: rows.length ? [{ start: 0, end: rows.length - 1 }] : [], threshold: 1 }
  const vectors = []
  for (const row of rows) {
    vectors.push(await embedText(String(row.content).slice(0, 320)))
  }
  const similarities = []
  for (let i = 0; i < vectors.length - 1; i++) similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]))
  const threshold = Math.max(0.42, percentile(similarities, 35))
  const segments = []
  let start = 0
  for (let i = 0; i < similarities.length; i++) { if (similarities[i] < threshold) { segments.push({ start, end: i }); start = i + 1 } }
  segments.push({ start, end: rows.length - 1 })
  return { rows, segments, threshold }
}

function buildCandidateSpan(dayEpisodes, episodeId, semanticPlan) {
  const targetIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(episodeId))
  if (targetIndex < 0) return ''
  let start = Math.max(0, targetIndex - 1), end = Math.min(dayEpisodes.length - 1, targetIndex + 2)
  if (semanticPlan?.rows?.length) {
    const si = semanticPlan.rows.findIndex(item => Number(item.id) === Number(episodeId))
    if (si >= 0) {
      const seg = semanticPlan.segments.find(s => si >= s.start && si <= s.end)
      if (seg) {
        const sr = semanticPlan.rows[Math.max(0, seg.start - 1)]
        const er = semanticPlan.rows[Math.min(semanticPlan.rows.length - 1, seg.end + 1)]
        if (sr) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(sr.id)); if (idx >= 0) start = idx }
        if (er) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(er.id)); if (idx >= 0) end = idx }
      }
    }
  }
  const rows = []
  for (let i = start; i <= end && rows.length < 6; i++) {
    const cleaned = cleanMemoryText(dayEpisodes[i]?.content ?? '')
    if (cleaned) rows.push(`${i === targetIndex ? '*' : '-'} ${dayEpisodes[i].role === 'user' ? 'user' : 'assistant'}: ${cleaned}`)
  }
  return rows.join('\n')
}

async function prepareConsolidationCandidates(candidates, maxPerBatch, dayEpisodes = []) {
  const seen = new Set()
  const prepared = []
  const plan = await buildSemanticDayPlan(dayEpisodes)
  for (const item of candidates) {
    const cleaned = cleanMemoryText(item?.content ?? '')
    if (!cleaned) continue
    const concept = classifyCandidateConcept(cleaned, item?.role ?? 'user')
    if (!concept.admit) continue
    const fp = cleaned.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!fp || seen.has(fp)) continue
    seen.add(fp)
    prepared.push({ ...item, content: cleaned, span_content: buildCandidateSpan(dayEpisodes, item?.episode_id, plan) || cleaned })
    if (prepared.length >= maxPerBatch) break
  }
  return prepared
}

async function resolveCycleLlmOutput(prompt, ws, options = {}) {
  if (typeof options.llm === 'function') {
    return await options.llm({
      prompt,
      ws,
      provider: options.provider ?? null,
      timeout: options.timeout ?? null,
      mode: options.mode ?? 'cycle',
      batchIndex: options.batchIndex ?? 0,
      dayKey: options.dayKey ?? null,
      candidates: options.candidates ?? [],
    })
  }
  const provider = options.provider || readMainConfig()?.memory?.cycle1?.provider || DEFAULT_CYCLE_PROVIDER
  return await callLLM(prompt, provider, { timeout: options.timeout ?? 180000, cwd: ws })
}

// ── Public API ──

export async function consolidateCandidateDay(dayKey, _ws, options = {}) {
  const store = options.store ?? getStore()
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY))
  const candidates = await prepareConsolidationCandidates(store.getCandidatesForDate(dayKey), maxPerBatch, store.getEpisodesForDate(dayKey))
  if (candidates.length === 0) return
  store.markCandidateIdsConsolidated(candidates.map(item => item.id))
  process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${candidates.length}, mode=classification-only\n`)
}

export async function consolidateRecent(dayKeys, ws, options = {}) {
  const targets = [...dayKeys].sort().reverse().slice(0, Math.max(1, Number(options.maxDays ?? MAX_MEMORY_CONSOLIDATE_DAYS))).sort()
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, options)
}

async function refreshEmbeddings(ws, options = {}) {
  const store = options.store ?? getStore()
  const mainConfig = readMainConfig()
  const contextualizeEnabled = mainConfig?.embedding?.contextualize !== false
  const contextualizeProvider = mainConfig?.memory?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER
  const kind = options.kind ?? 'cycle2'
  const refreshOptions = resolveEmbeddingRefreshOptions(mainConfig, kind)
  let contextMap = new Map()

  // Contextualize items for better embeddings (skipped when embedding.contextualize === false)
  if (contextualizeEnabled) {
    const promptPath = join(resourceDir(), 'defaults', 'memory-contextualize-prompt.md')
    if (existsSync(promptPath)) {
      const items = store.getEmbeddableItems({ perTypeLimit: refreshOptions.perTypeLimit }).slice(0, refreshOptions.contextualizeItems)
      if (items.length > 0) {
        const template = readFileSync(promptPath, 'utf8')
        const itemsText = items.map((item, i) => [`#${i + 1}`, `key=${item.key}`, `type=${item.entityType}`, item.subtype ? `subtype=${item.subtype}` : '', `content=${item.content}`].filter(Boolean).join('\n')).join('\n\n')
        try {
          const raw = await resolveCycleLlmOutput(template.replace('{{ITEMS}}', itemsText), ws, {
            mode: 'contextualize',
            provider: contextualizeProvider,
            timeout: 180000,
            candidates: items,
          })
          const parsed = extractJsonObject(raw)
          for (const row of parsed?.items ?? []) {
            if (row?.key && row?.context) contextMap.set(row.key, row.context)
          }
        } catch (e) { process.stderr.write(`[memory-cycle] contextualize failed: ${e.message}\n`) }
      }
    }
  } else {
    process.stderr.write('[memory-cycle] contextualize disabled by config (embedding.contextualize=false), embedding raw content\n')
  }

  const updated = await store.ensureEmbeddings({ perTypeLimit: refreshOptions.perTypeLimit, contextMap })
  process.stderr.write(`[memory-cycle] embeddings refreshed: ${updated}\n`)
}

export function readMainConfig() {
  const mainConfigPath = join(PLUGIN_DATA_DIR, 'config.json')
  try { return JSON.parse(readFileSync(mainConfigPath, 'utf8')) } catch { return {} }
}

async function sleepCycleImpl(ws) {
  const store = getStore()
  const now = Date.now()

  const config = readCycleConfig()
  const mainConfig = readMainConfig()
  const cycle2Config = mainConfig?.memory?.cycle2 ?? {}
  const isFirstRun = !config.lastSleepAt && !existsSync(join(HISTORY_DIR, 'context.md'))
  const backfillLimit = resolveCycleBackfillLimit(mainConfig, 120)

  process.stderr.write(`[memory-cycle] Starting.${isFirstRun ? ' (FIRST RUN)' : ''}\n`)
  store.backfillProject(ws, { limit: backfillLimit })

  // 1. Consolidation (pass cycle2 provider if configured)
  const MAX_DAYS = Math.max(1, Number(cycle2Config.maxDays ?? 7))
  const pendingDays = store.getPendingCandidateDays(MAX_DAYS, 1).map(d => d.day_key).sort()
  const consolidateOpts = { provider: cycle2Config.provider ?? DEFAULT_CYCLE_PROVIDER }
  await consolidateRecent(pendingDays, ws, consolidateOpts)

  // 2. Sync + embeddings + context
  store.syncHistoryFromFiles()
  if (pendingDays.length > 0 || isFirstRun) {
    await refreshEmbeddings(ws, { kind: 'cycle2' })
    store.writeContextFile()
  }

  // 3. Save timestamp
  writeCycleConfig({ ...config, lastSleepAt: now })

  // Update cycle state
  const cycleState = loadCycleState()
  cycleState.cycle2.lastRunAt = new Date().toISOString()
  saveCycleState(cycleState)

  process.stderr.write('[memory-cycle] Cycle complete.\n')
}

export async function sleepCycle(ws) {
  return enqueueCycleWrite('cycle2', () => sleepCycleImpl(ws))
}

export async function summarizeOnly(ws) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: resolveCycleBackfillLimit(mainConfig, 120) })
  const pendingDays = store.getPendingCandidateDays(3, 1).map(d => d.day_key).sort()
  if (pendingDays.length > 0) {
    const provider = mainConfig?.memory?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER
    await consolidateRecent(pendingDays, ws, { provider })
    await refreshEmbeddings(ws, { kind: 'cycle2' })
    store.writeContextFile()
  }
  store.syncHistoryFromFiles()
}

async function memoryFlushImpl(ws, options = {}) {
  const store = getStore()
  const maxDays = Math.max(1, Number(options.maxDays ?? MEMORY_FLUSH_DEFAULT_MAX_DAYS))
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES))
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MEMORY_FLUSH_DEFAULT_MAX_BATCHES))
  const minPending = Math.max(1, Number(options.minPending ?? MEMORY_FLUSH_DEFAULT_MIN_PENDING))
  const pendingDays = store.getPendingCandidateDays(maxDays * 3, minPending)
  if (!pendingDays.length) { process.stderr.write('[memory-cycle] no flushable batches.\n'); return }
  const targets = pendingDays.map(d => d.day_key).sort().slice(0, maxDays)
  const consolidateOpts = { maxCandidatesPerBatch: maxPerBatch, maxBatches }
  consolidateOpts.provider = options.provider ?? readMainConfig()?.memory?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, consolidateOpts)
  await refreshEmbeddings(ws)
  store.writeContextFile()
}

export async function memoryFlush(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => memoryFlushImpl(ws, options))
}

async function rebuildAllImpl(ws) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig, 120), 400) })
  store.syncHistoryFromFiles()
  store.resetConsolidatedMemory()
  const dayKeys = store.getPendingCandidateDays(10000, 1).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no candidate days.\n'); return }
  const provider = mainConfig?.memory?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, { maxCandidatesPerBatch: MAX_MEMORY_CANDIDATES_PER_DAY, maxBatches: 999, provider })
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws, { kind: 'cycle2' })
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] rebuilt ${dayKeys.length} day(s).\n`)
}

export async function rebuildAll(ws) {
  return enqueueCycleWrite('cycle2', () => rebuildAllImpl(ws))
}

async function rebuildRecentImpl(ws, options = {}) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig, 120), 240) })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.maxDays ?? 2))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.resetConsolidatedMemoryForDays(dayKeys)
  const mergedOptions = options.provider ? options : { ...options, provider: mainConfig?.memory?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER }
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, mergedOptions)
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws, { kind: 'cycle2' })
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] rebuilt recent ${dayKeys.length} day(s).\n`)
}

export async function rebuildRecent(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => rebuildRecentImpl(ws, options))
}

async function pruneToRecentImpl(ws, options = {}) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig, 120), 240) })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.maxDays ?? 5))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.pruneConsolidatedMemoryOutsideDays(dayKeys)
  await refreshEmbeddings(ws, { kind: 'cycle2' })
  store.writeContextFile()
  process.stderr.write(`[memory-cycle] pruned to ${dayKeys.join(', ')}.\n`)
}

export async function pruneToRecent(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => pruneToRecentImpl(ws, options))
}

let _flushLock = false

export async function autoFlush(ws) {
  if (_flushLock) return { flushed: false, reason: 'locked' }
  const store = getStore()
  const config = readCycleConfig()
  const mainConfig = readMainConfig()
  const cycle1MaxPending = Number(mainConfig?.memory?.cycle1?.maxPending ?? mainConfig?.memory?.cycle2?.maxCandidates ?? 0)
  const now = Date.now()
  const lastFlushAt = config.lastFlushAt ?? 0
  const pending = store.getPendingCandidateDays(100, 1)
  const totalPending = pending.reduce((sum, d) => sum + d.n, 0)
  if (totalPending === 0) return { flushed: false, candidates: 0 }

  const elapsed = now - lastFlushAt
  // Check worker1 maxPending threshold (auto-trigger regardless of interval)
  const exceedsMaxCandidates = cycle1MaxPending > 0 && totalPending >= cycle1MaxPending
  if (!exceedsMaxCandidates && totalPending < AUTO_FLUSH_THRESHOLD && elapsed < AUTO_FLUSH_INTERVAL_MS) {
    return { flushed: false, candidates: totalPending }
  }

  _flushLock = true
  try {
    const reason = exceedsMaxCandidates ? `maxPending(${cycle1MaxPending})` : 'threshold'
    process.stderr.write(`[auto-flush] triggered: ${totalPending} pending, ${Math.round(elapsed / 60000)}min elapsed, reason=${reason}\n`)
    await runCycle1(ws, mainConfig, { skipWaterfall: true, trigger: reason })
    writeCycleConfig({ ...readCycleConfig(), lastFlushAt: now })
    return { flushed: true, candidates: totalPending }
  } finally {
    _flushLock = false
  }
}

export function getCycleStatus() {
  const config = readCycleConfig()
  const mainConfig = readMainConfig()
  const store = getStore()
  const pending = store.getPendingCandidateDays(100, 1)
  const cycleState = loadCycleState()
  const memoryConfig = mainConfig?.memory ?? {}
  return {
    lastSleepAt: config.lastSleepAt ? new Date(config.lastSleepAt).toISOString() : null,
    lastCycle1At: config.lastCycle1At ? new Date(config.lastCycle1At).toISOString() : null,
    pendingDays: pending.length,
    pendingCandidates: pending.reduce((sum, d) => sum + d.n, 0),
    cycleState,
    memoryConfig: {
      cycle1: {
        interval: memoryConfig.cycle1?.interval ?? '5m',
        maxPending: memoryConfig.cycle1?.maxPending ?? null,
        provider: memoryConfig.cycle1?.provider?.connection ?? 'codex',
      },
      cycle2: { schedule: memoryConfig.cycle2?.schedule ?? '03:00', maxCandidates: memoryConfig.cycle2?.maxCandidates ?? null, provider: memoryConfig.cycle2?.provider?.connection ?? 'cli' },
    },
  }
}

// ── Cycle1: Lightweight interval-based memory extraction ──

function looksLowSignalCycle1(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  const shortKoreanMeaningful =
    hasKorean &&
    compact.length >= 2 &&
    (
      /[?？]$/.test(clean) ||
      /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) ||
      classifyCandidateConcept(clean, 'user')?.admit
    )
  if (compact.length < (hasKorean ? 4 : 8) && !shortKoreanMeaningful) return true
  return false
}

function loadClassificationPrompt() {
  const promptPath = join(resourceDir(), 'defaults', 'memory-classification-prompt.md')
  if (existsSync(promptPath)) return readFileSync(promptPath, 'utf8')
  return 'Fill the missing classification columns for each row. Output JSON only.\n\n{{ROWS}}'
}

function csvEscape(value) {
  const s = String(value ?? '').replace(/\n/g, ' ').trim()
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCycle1ClassificationRows(candidates = []) {
  return candidates.map(candidate => {
    const text = csvEscape(candidate.content?.slice(0, 150) || '')
    return [candidate.episode_id, text, '', '', '', ''].join(',')
  }).join('\n')
}

const DEFAULT_CYCLE_PROVIDER = { connection: 'codex', model: 'gpt-5.4', effort: 'medium', fast: true }

async function runCycle1Impl(ws, config, options = {}) {
  const store = options.store ?? getStore()
  const cycleConfig = readCycleConfig()
  const force = Boolean(options.force)

  const cycle1Config = config?.memory?.cycle1 ?? {}
  const batchSize = Math.max(1, Number(cycle1Config.batchSize ?? 50))
  const maxDays = force ? 9999 : Math.max(1, Number(cycle1Config.maxDays ?? 7))
  const provider = config?.memory?.cycle1?.provider || DEFAULT_CYCLE_PROVIDER
  const timeout = config?.memory?.cycle1?.timeout || 60000

  // pending candidates를 최근 maxDays 범위에서 가져옴
  // getCandidatesForDate는 이미 status='pending'만 반환
  const pendingDays = store.getPendingCandidateDays(maxDays, 1)
  if (pendingDays.length === 0) {
    writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })
    return { extracted: 0, classifications: 0 }
  }

  const allCandidates = []
  for (const { day_key } of pendingDays.sort((a, b) => b.day_key.localeCompare(a.day_key))) {
    const dayCandidates = store.getCandidatesForDate(day_key)
      .map(c => ({ ...c, content: cleanMemoryText(c.content) }))
      .filter(c => c.content && !looksLowSignalCycle1(c.content))
    allCandidates.push(...dayCandidates)
    if (!force && allCandidates.length >= batchSize) break
  }
  if (allCandidates.length === 0) {
    writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })
    return { extracted: 0, classifications: 0 }
  }

  let totalExtracted = 0, totalClassifications = 0

  // force: 전체 pending을 batchSize씩 연속 처리 / 주기: batchSize 1회
  const batches = []
  for (let i = 0; i < allCandidates.length; i += batchSize) {
    batches.push(allCandidates.slice(i, i + batchSize))
    if (!force) break
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const candidates = batches[bi]
    const extractionPrompt = loadClassificationPrompt()
      .replace('{{ROWS}}', buildCycle1ClassificationRows(candidates))

    let raw
    try {
      raw = await resolveCycleLlmOutput(extractionPrompt, ws, {
        ...options,
        mode: 'cycle1',
        batchIndex: bi,
        candidates,
        provider,
        timeout,
      })
    } catch (e) {
      process.stderr.write(`[cycle1] batch ${bi} LLM error: ${e.message}\n`)
      break
    }

    const parsed = extractJsonObject(raw) || parseClassificationCsv(raw)
    if (!parsed) {
      process.stderr.write(`[cycle1] batch ${bi}: unparseable response\n`)
      continue
    }

    const ts = new Date().toISOString()
    const classificationRows = Array.isArray(parsed.items)
      ? parsed.items.map(item => ({
          episode_id: Number(item?.case_id ?? 0),
          classification: String(item?.classification ?? '').trim(),
          topic: String(item?.topic ?? '').trim(),
          element: String(item?.element ?? '').trim(),
          state: String(item?.state ?? '').trim(),
          confidence: Number(item?.confidence ?? 0.6),
        }))
      : []
    store.upsertClassifications(classificationRows, ts, null)

    // 처리된 candidates를 consolidated로 마킹
    const processedIds = candidates.map(c => c.id).filter(id => id != null)
    if (processedIds.length > 0) {
      const placeholders = processedIds.map(() => '?').join(',')
      store.db.prepare(`
        UPDATE memory_candidates SET status = 'consolidated'
        WHERE id IN (${placeholders}) AND status = 'pending'
      `).run(...processedIds)
    }

    totalExtracted += candidates.length
    totalClassifications += classificationRows.length
    process.stderr.write(`[cycle1] batch ${bi}: ${candidates.length} candidates → ${classificationRows.length} classifications\n`)
  }

  if (totalExtracted > 0) {
    await refreshEmbeddings(ws, { store, kind: 'cycle1' })
    store.writeContextFile()
  }

  writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })

  // Update cycle state
  const cycleState = loadCycleState()
  cycleState.cycle1.lastRunAt = new Date().toISOString()
  saveCycleState(cycleState)

  const result = {
    extracted: totalExtracted,
    classifications: totalClassifications,
  }
  if (totalExtracted > 0) {
    process.stderr.write(`[memory-cycle1] extracted=${result.extracted} classifications=${result.classifications}\n`)
  }
  return result
}

export async function runCycle1(ws, config, options = {}) {
  return enqueueCycleWrite('cycle1', () => runCycle1Impl(ws, config, options))
}

export function parseInterval(s) {
  if (String(s).toLowerCase() === 'immediate') return 0
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) return 600000 // default 10m
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}

const WEEKDAY_MAP = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }

export function parseCycle3Day(day) {
  if (!day) return 0 // default sunday
  return WEEKDAY_MAP[String(day).toLowerCase()] ?? 0
}

// ── Cycle3: Weekly gradual decay ──

const CYCLE3_HEAT_THRESHOLD = 0.6
const CYCLE3_DEPRECATED_GRACE_DAYS = 30

function computeHeatScore(row) {
  const mentionCount = Number(row.mention_count ?? 0)
  const retrievalCount = Number(row.retrieval_count ?? 0)
  const lastSeen = row.last_seen ? new Date(row.last_seen).getTime() : 0
  const daysSinceLastSeen = lastSeen ? Math.max(0, (Date.now() - lastSeen) / 86400000) : 999
  const mentionTerm = Math.log1p(Math.max(0, mentionCount)) * 0.7
  const retrievalTerm = Math.log1p(Math.max(0, retrievalCount)) * 0.95
  const recencyTerm = Math.exp(-daysSinceLastSeen / 21) * 0.55
  return Number((mentionTerm + retrievalTerm + recencyTerm).toFixed(3))
}

async function runCycle3Impl(_ws, options = {}) {
  const store = getStore()
  const mainConfig = readMainConfig()
  const cycle3Config = mainConfig?.memory?.cycle3 ?? {}
  const threshold = Number(cycle3Config.threshold ?? options.threshold ?? CYCLE3_HEAT_THRESHOLD)
  const graceDays = Number(cycle3Config.graceDays ?? options.graceDays ?? CYCLE3_DEPRECATED_GRACE_DAYS)
  const hardDelete = Boolean(cycle3Config.hardDelete ?? options.hardDelete ?? false)
  const now = new Date()
  const nowISO = now.toISOString()

  process.stderr.write(`[memory-cycle3] Starting decay cycle (threshold=${threshold}, graceDays=${graceDays})\n`)

  let deprecatedClassifications = 0
  let deletedClassifications = 0

  const MIN_SURVIVAL_DAYS = 30
  const rows = store.db.prepare(`
    SELECT id, ts, retrieval_count, updated_at
    FROM classifications
    WHERE status = 'active'
  `).all()

  const coldIds = rows.filter(row => {
    const firstSeen = row.ts ? new Date(row.ts).getTime() : 0
    const ageDays = firstSeen ? (Date.now() - firstSeen) / 86400000 : 999
    if (ageDays < MIN_SURVIVAL_DAYS) return false
    return computeHeatScore({
      mention_count: 1,
      retrieval_count: row.retrieval_count,
      last_seen: row.ts,
    }) < threshold
  }).map(row => row.id)

  if (coldIds.length > 0) {
    const placeholders = coldIds.map(() => '?').join(',')
    deprecatedClassifications = Number(store.db.prepare(`
      UPDATE classifications
      SET status = 'deprecated'
      WHERE id IN (${placeholders})
    `).run(...coldIds).changes ?? 0)
  }

  if (hardDelete) {
    const graceThreshold = new Date(Date.now() - graceDays * 86400000).getTime()
    const deletable = store.db.prepare(`
      SELECT id
      FROM classifications
      WHERE status = 'deprecated'
        AND updated_at < ?
    `).all(graceThreshold).map(row => row.id)
    if (deletable.length > 0) {
      const placeholders = deletable.map(() => '?').join(',')
      deletedClassifications = Number(store.db.prepare(`
        DELETE FROM classifications
        WHERE id IN (${placeholders})
      `).run(...deletable).changes ?? 0)
    }
  }

  // Phase 3: Refresh context
  store.writeContextFile()

  // Phase 4: Update cycle state
  const cycleState = loadCycleState()
  cycleState.cycle3.lastRunAt = nowISO
  saveCycleState(cycleState)

  const result = {
    deprecated: { classifications: deprecatedClassifications },
    deleted: { classifications: deletedClassifications },
  }

  process.stderr.write(
    `[memory-cycle3] deprecated classifications=${deprecatedClassifications} | ` +
    `deleted classifications=${deletedClassifications}\n`
  )

  return result
}

export async function runCycle3(ws, options = {}) {
  return enqueueCycleWrite('cycle3', () => runCycle3Impl(ws, options))
}

export function shouldRunCycle3(config) {
  const cycle3Config = config?.memory?.cycle3 ?? {}
  const today = new Date()
  const cycleState = loadCycleState()
  const targetDayRaw = String(cycle3Config.day ?? 'sunday').toLowerCase()
  const schedule = String(cycle3Config.schedule ?? '03:00')
  const [targetHour, targetMinute] = schedule.split(':').map(value => Number(value) || 0)
  const schedulePassed =
    today.getHours() > targetHour ||
    (today.getHours() === targetHour && today.getMinutes() >= targetMinute)

  if (targetDayRaw === 'daily' || targetDayRaw === 'everyday') {
    if (!schedulePassed) return false
    if (!cycleState.cycle3.lastRunAt) return true
    const lastRun = new Date(cycleState.cycle3.lastRunAt)
    const sameDay =
      lastRun.getFullYear() === today.getFullYear() &&
      lastRun.getMonth() === today.getMonth() &&
      lastRun.getDate() === today.getDate()
    return !sameDay
  }

  const targetDay = parseCycle3Day(cycle3Config.day)
  const todayDay = today.getDay()
  if (todayDay !== targetDay || !schedulePassed) return false
  if (!cycleState.cycle3.lastRunAt) return true
  const lastRun = new Date(cycleState.cycle3.lastRunAt)
  const daysSinceLastRun = (today.getTime() - lastRun.getTime()) / 86400000
  return daysSinceLastRun >= 6
}
