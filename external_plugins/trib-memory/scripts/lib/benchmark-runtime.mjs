import { cpSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  configureEmbedding,
  consumeProviderSwitchEvent,
  getEmbeddingDims,
  getEmbeddingModelId,
} from '../../lib/embedding-provider.mjs'
import { readMainConfig } from '../../lib/memory-cycle.mjs'

export function resolveDataDir(explicitDataDir = '') {
  if (explicitDataDir && existsSync(join(explicitDataDir, 'memory.sqlite'))) {
    return explicitDataDir
  }
  if (process.env.CLAUDE_PLUGIN_DATA && existsSync(join(process.env.CLAUDE_PLUGIN_DATA, 'memory.sqlite'))) {
    return process.env.CLAUDE_PLUGIN_DATA
  }
  const dataRoot = join(homedir(), '.claude', 'plugins', 'data')
  const candidates = [
    join(dataRoot, 'trib-memory-trib-memory'),
    join(dataRoot, 'trib-memory-tribgames'),
  ]
  return candidates.find(dir => existsSync(join(dir, 'memory.sqlite'))) || null
}

function addUtcDays(value, days) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function monthRange(value) {
  const match = String(value).trim().match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null
  const start = `${match[1]}-${match[2]}-01`
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const endDate = new Date(Date.UTC(nextMonth.year, nextMonth.month - 1, 1))
  endDate.setUTCDate(endDate.getUTCDate() - 1)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

export function parseTimerange(timerangeArg) {
  if (!timerangeArg) return { trStart: null, trEnd: null }
  const now = new Date()
  const localDate = (value) => {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const today = localDate(now)
  const weekdayOffset = (now.getDay() + 6) % 7
  const weekStart = localDate(addUtcDays(now, -weekdayOffset))
  const lastWeekStart = localDate(addUtcDays(now, -(weekdayOffset + 7)))
  const lastWeekEnd = localDate(addUtcDays(now, -(weekdayOffset + 1)))
  const daysAgo = (n) => localDate(addUtcDays(now, -n))
  const normalized = String(timerangeArg).trim().toLowerCase()
  const dMatch = normalized.match(/^(\d+)d$/)
  const wMatch = normalized.match(/^(\d+)w$/)
  const rangeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  const dateMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})$/)
  const mRange = monthRange(normalized)
  if (dMatch) return { trStart: daysAgo(Number(dMatch[1])), trEnd: today }
  if (wMatch) return { trStart: daysAgo(Number(wMatch[1]) * 7), trEnd: today }
  if (normalized === 'today' || normalized === '오늘') return { trStart: today, trEnd: today }
  if (normalized === 'yesterday' || normalized === '어제') return { trStart: daysAgo(1), trEnd: daysAgo(1) }
  if (['this-week', 'this week', 'this_week', '이번주', '이번 주'].includes(normalized)) return { trStart: weekStart, trEnd: today }
  if (['last-week', 'last week', 'last_week', '지난주', '지난 주'].includes(normalized)) return { trStart: lastWeekStart, trEnd: lastWeekEnd }
  if (rangeMatch) return { trStart: rangeMatch[1], trEnd: rangeMatch[2] }
  if (mRange) return { trStart: mRange.start, trEnd: mRange.end }
  if (dateMatch) return { trStart: dateMatch[1], trEnd: dateMatch[1] }
  return { trStart: null, trEnd: null }
}

export function buildTemporalOverride(trStart, trEnd) {
  if (!trStart || !trEnd) return null
  return {
    start: trStart,
    end: trEnd,
    exact: trStart === trEnd,
  }
}

export function prepareWritableDataDir(sourceDir, options = {}) {
  if (!sourceDir) return null
  if (String(sourceDir).startsWith(tmpdir())) return sourceDir
  const suffix = options.suffix ? `-${options.suffix}` : (options.refresh ? `-${process.pid}-${Date.now()}` : '')
  const target = join(tmpdir(), 'trib-memory-runs', `${basename(String(sourceDir))}${suffix}`)
  if (options.refresh && existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
  if (!existsSync(join(target, 'memory.sqlite'))) {
    rmSync(target, { recursive: true, force: true })
    cpSync(sourceDir, target, { recursive: true })
  }
  return target
}

export function configureBenchmarkEmbedding(allowMlService = false) {
  const mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding
  process.env.TRIB_MEMORY_FORCE_LOCAL_EMBEDDING = '0'
  process.env.TRIB_MEMORY_ENABLE_ML_SERVICE = allowMlService ? '1' : '0'
  configureEmbedding({
    provider: embeddingConfig?.provider ?? 'ollama',
    ollamaModel: embeddingConfig?.ollamaModel ?? 'bge-m3',
  })
}

export async function prepareBenchmarkStore(store, reason = 'benchmark_prepare_dense') {
  await store.warmupEmbeddings()
  consumeProviderSwitchEvent()
  store.syncEmbeddingMetadata({
    vectorModel: getEmbeddingModelId(),
    vectorDims: getEmbeddingDims(),
    reason,
    reindexCompleted: true,
  })
}
