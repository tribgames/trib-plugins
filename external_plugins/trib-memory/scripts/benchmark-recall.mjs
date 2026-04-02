#!/usr/bin/env node

import { getMemoryStore } from '../lib/memory.mjs'
import {
  buildTemporalOverride,
  configureBenchmarkEmbedding,
  parseTimerange,
  prepareBenchmarkStore,
  prepareWritableDataDir,
  resolveDataDir,
} from './lib/benchmark-runtime.mjs'
import { loadCases, runBenchmarkCases } from './lib/benchmark-core.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2).replace(/-/g, '_')
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    if (args[key] === undefined) {
      args[key] = next
    } else if (Array.isArray(args[key])) {
      args[key].push(next)
    } else {
      args[key] = [args[key], next]
    }
    i += 1
  }
  return args
}

function summarizeItem(item, maxLen = 80) {
  const type = String(item?.type ?? 'unknown')
  const subtype = String(item?.subtype ?? '').trim()
  const content = String(item?.content ?? item?.text ?? '').replace(/\s+/g, ' ').trim()
  const short = content.length > maxLen ? `${content.slice(0, maxLen - 3)}...` : content
  const label = subtype ? `${type}/${subtype}` : type
  return `${label} ${short}`
}

function formatPercent(value, total) {
  if (!total) return '0.0%'
  return `${((value / total) * 100).toFixed(1)}%`
}

function formatMetric(value, digits = 3) {
  return Number(value || 0).toFixed(digits)
}

const args = parseArgs(process.argv.slice(2))
const sourceDataDir = resolveDataDir(args.data_dir)
if (!sourceDataDir) {
  process.stderr.write('benchmark-recall: data dir not found\n')
  process.exit(1)
}

if (!args.cases_file) {
  process.stderr.write('benchmark-recall: --cases-file is required\n')
  process.exit(1)
}

const dataDir = prepareWritableDataDir(sourceDataDir, { refresh: Boolean(args.refresh_copy) })
configureBenchmarkEmbedding(Boolean(args.allow_ml_service))

const defaults = {
  timerange: args.timerange ?? null,
  start_ts: args.start_ts ?? null,
  end_ts: args.end_ts ?? null,
  memory_kind: args.memory_kind,
  task_status: args.task_status,
  source_type: args.source_type,
  session_id: args.session_id,
}

const cases = loadCases(String(args.cases_file), defaults)
if (cases.length === 0) {
  process.stderr.write('benchmark-recall: no cases found\n')
  process.exit(1)
}

const store = getMemoryStore(dataDir)
await prepareBenchmarkStore(store, 'benchmark_recall_prepare_dense')
const limit = Math.max(1, Number(args.limit ?? 5))
const hitK = Math.max(1, Number(args.top_k ?? 3))
const benchmark = await runBenchmarkCases(store, cases, { limit, topK: hitK })
const { summary, cases: caseOutputs } = benchmark

const format = String(args.format ?? 'compact').toLowerCase()
if (format === 'json') {
  process.stdout.write(`${JSON.stringify({
    source_data_dir: sourceDataDir,
    data_dir: dataDir,
    top_k: hitK,
    cases: caseOutputs,
    summary,
  }, null, 2)}\n`)
  process.exit(0)
}

const lines = []
lines.push(`cases=${cases.length} top_k=${hitK}`)
lines.push(`source=${sourceDataDir}`)
lines.push(`data=${dataDir}`)
lines.push('')
lines.push(`hit@1=${formatPercent(summary.hit_at_1, 1)} hit@${hitK}=${formatPercent(summary.hit_at_k, 1)} mrr=${formatMetric(summary.mrr)} matched=${summary.matched}/${summary.total}`)

const showMisses = Number(args.show_misses ?? 5)
if (showMisses > 0) {
  const misses = caseOutputs.filter(item => item.rank == null).slice(0, showMisses)
  if (misses.length > 0) {
    lines.push('')
    lines.push(`misses (${misses.length})`)
    for (const miss of misses) {
      lines.push(`- ${miss.label}`)
      lines.push(`  expected_any=${miss.expected_any.join(' | ') || '-'} expected_all=${miss.expected_all.join(' | ') || '-'}`)
      const top = (miss.top ?? []).map(item => summarizeItem(item)).join(' || ') || '(empty)'
      lines.push(`  top=${top}`)
    }
  }
}

process.stdout.write(`${lines.join('\n')}\n`)
