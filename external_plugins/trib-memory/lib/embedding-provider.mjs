/**
 * embedding-provider.mjs — Embedding provider abstraction.
 *
 * Default path:
 *   local bge-m3 via Ollama
 *
 * Optional path:
 *   Python ML service (/embed) when explicitly enabled
 *
 * Last-resort path:
 *   local Xenova bge-m3
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOCAL_MODEL = 'Xenova/bge-m3'
const LOCAL_DIMS = 1024
const DEFAULT_PROVIDER = 'ollama'
const DEFAULT_OLLAMA_MODEL = 'bge-m3'
const ML_PORT_FILE = join(tmpdir(), 'trib-memory', 'ml-port')
const ML_TIMEOUT_MS = Number(process.env.CLAUDE2BOT_ML_TIMEOUT_MS || 15000)
const ML_WARMUP_RETRIES = 3
const ML_WARMUP_DELAY_MS = 1500

let extractorPromise = null
let cachedDims = null
let lastProviderSwitch = null
let mlServiceAvailable = null  // null = unknown, true/false = tested
let ollamaAvailable = null
let configuredProvider = DEFAULT_PROVIDER
let configuredOllamaModel = DEFAULT_OLLAMA_MODEL
const queryEmbeddingCache = new Map()
const QUERY_EMBEDDING_CACHE_LIMIT = 1000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readMlPort() {
  try {
    return Number(readFileSync(ML_PORT_FILE, 'utf8').trim())
  } catch {
    return 0
  }
}

function activateLocalXenova(reason, error = null) {
  const previousModelId = getEmbeddingModelId()
  mlServiceAvailable = false
  ollamaAvailable = false
  configuredProvider = 'xenova'
  extractorPromise = null
  cachedDims = LOCAL_DIMS
  lastProviderSwitch = {
    phase: 'runtime',
    previousModelId,
    currentModelId: LOCAL_MODEL,
    reason,
  }
  const suffix = error instanceof Error ? `: ${error.message}` : ''
  process.stderr.write(`[embed] ${reason}; using local ${LOCAL_MODEL}${suffix}\n`)
}

function cacheEmbedding(key, vector) {
  if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, vector)
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value
    if (oldestKey) queryEmbeddingCache.delete(oldestKey)
  }
}

function getCachedEmbedding(key) {
  if (!queryEmbeddingCache.has(key)) return null
  const value = queryEmbeddingCache.get(key)
  queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, value)
  return value
}

function shouldForceLocalEmbedding() {
  return process.env.TRIB_MEMORY_FORCE_LOCAL_EMBEDDING === '1'
}

function shouldUseMlService() {
  return process.env.TRIB_MEMORY_ENABLE_ML_SERVICE === '1' || configuredProvider === 'ml-service'
}

function shouldUseOllamaEmbedding() {
  return !shouldForceLocalEmbedding() && !shouldUseMlService() && (configuredProvider === 'ollama' || configuredProvider === 'local')
}

export function configureEmbedding(config = {}) {
  // Reset cached state — ML service port may have changed
  configuredProvider = String(config.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER
  configuredOllamaModel = String(config.ollamaModel ?? DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL
  extractorPromise = null
  cachedDims = null
  mlServiceAvailable = null
  ollamaAvailable = null
  queryEmbeddingCache.clear()
}

export function clearEmbeddingCache() {
  queryEmbeddingCache.clear()
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers')
      env.allowLocalModels = false
      return pipeline('feature-extraction', LOCAL_MODEL)
    })()
  }
  return extractorPromise
}

async function ollamaEmbed(text, timeoutMs = ML_TIMEOUT_MS) {
  const resp = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: configuredOllamaModel || DEFAULT_OLLAMA_MODEL,
      input: text,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${resp.statusText}`)
  const data = await resp.json()
  const vector = Array.isArray(data?.embeddings?.[0]) ? data.embeddings[0] : []
  return new Float32Array(vector)
}

async function mlEmbed(text, timeoutMs = ML_TIMEOUT_MS) {
  const port = readMlPort()
  if (!port) throw new Error('ML service port file not found')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`ML service ${resp.status}: ${resp.statusText}`)
    const data = await resp.json()
    return new Float32Array(data.vector)
  } finally {
    clearTimeout(timeout)
  }
}

export function getEmbeddingModelId() {
  if (configuredProvider === 'xenova') return LOCAL_MODEL
  if (shouldUseMlService() && mlServiceAvailable !== false) return 'ml-service/bge-m3'
  if (shouldUseOllamaEmbedding() && ollamaAvailable !== false) return `ollama/${configuredOllamaModel || DEFAULT_OLLAMA_MODEL}`
  return LOCAL_MODEL
}

export function getEmbeddingDims() {
  if (cachedDims) return cachedDims
  return mlServiceAvailable === false ? LOCAL_DIMS : LOCAL_DIMS
}

export function consumeProviderSwitchEvent() {
  const event = lastProviderSwitch
  lastProviderSwitch = null
  return event
}

export async function warmupEmbeddingProvider() {
  if (shouldForceLocalEmbedding()) {
    activateLocalXenova('forced local embedding')
    const extractor = await loadExtractor()
    await extractor('warmup', { pooling: 'mean', normalize: true })
    cachedDims = LOCAL_DIMS
    return true
  }

  if (shouldUseOllamaEmbedding()) {
    try {
      const vec = await ollamaEmbed('warmup')
      cachedDims = vec.length
      ollamaAvailable = true
      mlServiceAvailable = false
      process.stderr.write(`[embed] Ollama ${configuredOllamaModel} connected. dims=${cachedDims}\n`)
      return true
    } catch (e) {
      process.stderr.write(`[embed] Ollama ${configuredOllamaModel} unavailable: ${e.message}\n`)
    }
  }

  if (shouldUseMlService()) {
    for (let attempt = 1; attempt <= ML_WARMUP_RETRIES; attempt += 1) {
      try {
        const vec = await mlEmbed('warmup')
        cachedDims = vec.length
        mlServiceAvailable = true
        ollamaAvailable = false
        process.stderr.write(`[embed] ML service connected. dims=${cachedDims}\n`)
        return true
      } catch (e) {
        if (attempt < ML_WARMUP_RETRIES) {
          process.stderr.write(`[embed] ML service warmup retry ${attempt}/${ML_WARMUP_RETRIES}: ${e.message}\n`)
          await sleep(ML_WARMUP_DELAY_MS)
        }
      }
    }
  }

  activateLocalXenova('default embedding warmup failed')
  const extractor = await loadExtractor()
  await extractor('warmup', { pooling: 'mean', normalize: true })
  cachedDims = LOCAL_DIMS
  return true
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  const cacheKey = `${getEmbeddingModelId()}\n${clean}`
  const cached = getCachedEmbedding(cacheKey)
  if (cached) return [...cached]

  if (shouldForceLocalEmbedding()) {
    if (configuredProvider !== 'xenova') activateLocalXenova('forced local embedding')
    const extractor = await loadExtractor()
    const output = await extractor(clean, { pooling: 'mean', normalize: true })
    cachedDims = LOCAL_DIMS
    const vector = Array.from(output.data ?? [])
    cacheEmbedding(cacheKey, vector)
    return vector
  }

  if (shouldUseOllamaEmbedding() && ollamaAvailable !== false) {
    try {
      const vec = await ollamaEmbed(clean)
      if (!cachedDims && vec.length > 0) cachedDims = vec.length
      ollamaAvailable = true
      mlServiceAvailable = false
      const vector = Array.from(vec)
      cacheEmbedding(cacheKey, vector)
      return vector
    } catch (e) {
      process.stderr.write(`[embed] Ollama ${configuredOllamaModel} request failed: ${e.message}\n`)
    }
  }

  if (shouldUseMlService() && mlServiceAvailable !== false) {
    try {
      const vec = await mlEmbed(clean)
      if (!cachedDims && vec.length > 0) cachedDims = vec.length
      mlServiceAvailable = true
      ollamaAvailable = false
      const vector = Array.from(vec)
      cacheEmbedding(cacheKey, vector)
      return vector
    } catch (e) {
      activateLocalXenova('ML service embedding request failed', e)
    }
  }

  const extractor = await loadExtractor()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  cachedDims = LOCAL_DIMS
  const vector = Array.from(output.data ?? [])
  cacheEmbedding(cacheKey, vector)
  return vector
}
