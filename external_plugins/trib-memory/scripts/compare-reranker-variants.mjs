#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'

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

function toArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`
}

const args = parseArgs(process.argv.slice(2))
const benchmarkScript = resolve(import.meta.dirname, 'benchmark-recall.mjs')
const dataDir = args.data_dir || '/Users/jyp/.claude/plugins/data/trib-memory-tribgames'
const casesFile = args.cases_file || resolve(import.meta.dirname, 'benchmarks/tribgames-merged-cases.jsonl')
const topK = String(args.top_k ?? 3)
const models = toArray(args.models).length > 0
  ? toArray(args.models)
  : [
      'onnx-community/bge-reranker-v2-m3-ONNX',
      'Xenova/bge-reranker-large',
    ]

const rows = []

for (const modelId of models) {
  const started = performance.now()
  try {
    const stdout = execFileSync(process.execPath, [
      benchmarkScript,
      '--data-dir', dataDir,
      '--cases-file', casesFile,
      '--top-k', topK,
      '--format', 'json',
      '--refresh-copy',
    ], {
      env: {
        ...process.env,
        TRIB_MEMORY_ENABLE_RERANKER: '1',
        TRIB_MEMORY_RERANKER_MODEL_ID: String(modelId),
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
    const elapsedMs = performance.now() - started
    const parsed = JSON.parse(stdout)
    rows.push({
      model: modelId,
      seconds: +(elapsedMs / 1000).toFixed(1),
      final_hit1: parsed.summary?.final?.hit_at_1 ?? 0,
      final_hit3: parsed.summary?.final?.hit_at_k ?? 0,
      final_mrr: parsed.summary?.final?.mrr ?? 0,
      candidate_hit1: parsed.summary?.candidates?.hit_at_1 ?? 0,
    })
  } catch (error) {
    rows.push({
      model: modelId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

for (const row of rows) {
  if (row.error) {
    process.stdout.write(`${row.model}\n  error=${row.error}\n`)
    continue
  }
  process.stdout.write(
    `${row.model}\n` +
    `  time=${row.seconds}s final=${formatPercent(row.final_hit1)}/${formatPercent(row.final_hit3)} mrr=${Number(row.final_mrr).toFixed(3)} candidate=${formatPercent(row.candidate_hit1)}\n`,
  )
}
