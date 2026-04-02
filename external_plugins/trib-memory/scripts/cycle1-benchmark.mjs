#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCycle1Cases, runCycle1Benchmark } from './lib/cycle1-core.mjs'
import { runCycle1BatchBenchmark } from './lib/cycle1-batch-core.mjs'

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
    args[key] = next
    i += 1
  }
  return args
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`
}

function buildProviderOverride(args) {
  if (!args.provider_connection) return undefined
  return {
    connection: String(args.provider_connection),
    model: args.provider_model ? String(args.provider_model) : undefined,
    effort: args.provider_effort ? String(args.provider_effort) : undefined,
    fast: args.provider_fast != null ? String(args.provider_fast).toLowerCase() === 'true' : undefined,
    baseUrl: args.provider_base_url ? String(args.provider_base_url) : undefined,
  }
}

function summarizeCycle1Error(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /chatgpt\.com|codex\/responses|failed to lookup address information|stream disconnected|Command failed: codex exec/i.test(message)
  ) {
    return 'cycle1-benchmark: provider unavailable or network lookup failed while calling cycle1 model'
  }
  return `cycle1-benchmark: ${message}`
}

const args = parseArgs(process.argv.slice(2))
if (!args.cases_file) {
  process.stderr.write('cycle1-benchmark: --cases-file is required\n')
  process.exit(1)
}

const cases = loadCycle1Cases(resolve(String(args.cases_file)))
if (cases.length === 0) {
  process.stderr.write('cycle1-benchmark: no cases found\n')
  process.exit(1)
}

let benchmark
try {
  const sharedOptions = {
    timeout: args.timeout ? Number(args.timeout) : undefined,
    provider: buildProviderOverride(args),
    promptPath: args.prompt_file ? resolve(String(args.prompt_file)) : undefined,
    includePrompt: Boolean(args.include_prompt),
  }
  const batchSize = Math.max(1, Number(args.batch_size ?? 1))
  benchmark = batchSize > 1
    ? await runCycle1BatchBenchmark(cases, { ...sharedOptions, batchSize })
    : await runCycle1Benchmark(cases, sharedOptions)
} catch (error) {
  process.stderr.write(`${summarizeCycle1Error(error)}\n`)
  process.exit(1)
}

if (String(args.format ?? 'compact').toLowerCase() === 'json') {
  process.stdout.write(`${JSON.stringify(benchmark, null, 2)}\n`)
  process.exit(0)
}

const lines = []
lines.push(`cases=${cases.length}`)
for (const [key, value] of Object.entries(benchmark.summary)) {
  lines.push(`${key.padEnd(10)} hit@1=${formatPercent(value.hit_at_1)} recall=${formatPercent(value.avg_recall)}`)
}
process.stdout.write(`${lines.join('\n')}\n`)
