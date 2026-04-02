#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCycle1Cases, runCycle1Benchmark } from './lib/cycle1-core.mjs'
import { buildBatchPrompt, runCycle1BatchBenchmark } from './lib/cycle1-batch-core.mjs'
import { generateCycle1PromptVariants } from './lib/cycle1-prompt-variants.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

function listFilesRecursive(root, results = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === 'results') continue
      listFilesRecursive(full, results)
    } else {
      results.push(full)
    }
  }
  return results
}

function hashFiles(paths) {
  const hash = createHash('sha1')
  for (const file of paths.sort()) {
    hash.update(file)
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function metricTuple(summary) {
  return [
    Number(summary.tasks?.hit_at_1 ?? 0),
    Number(summary.facts?.avg_recall ?? 0),
    Number(summary.entities?.avg_recall ?? 0),
  ]
}

function compareTuple(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = Number(left[i] ?? 0)
    const b = Number(right[i] ?? 0)
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
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
    return 'cycle1-tune-loop: provider unavailable or network lookup failed while calling cycle1 model'
  }
  return `cycle1-tune-loop: ${message}`
}

const args = parseArgs(process.argv.slice(2))
if (!args.cases_file) {
  process.stderr.write('cycle1-tune-loop: --cases-file is required\n')
  process.exit(1)
}

const caseFile = resolve(String(args.cases_file))
const cases = loadCycle1Cases(caseFile)
const maxIterations = Math.max(1, Number(args.max_iterations ?? 20))
const patience = Math.max(1, Number(args.patience ?? 4))
const resultsRoot = resolve(__dirname, 'results')
mkdirSync(resultsRoot, { recursive: true })
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = join(resultsRoot, `cycle1-loop-${runId}`)
mkdirSync(runDir, { recursive: true })
const providerOverride = buildProviderOverride(args)
const batchSize = Math.max(1, Number(args.batch_size ?? 1))
const promptVariants = args.prompt_file
  ? [{
      id: 'manual',
      promptPath: resolve(String(args.prompt_file)),
      promptTemplate: readFileSync(resolve(String(args.prompt_file)), 'utf8'),
      spec: { source: 'manual' },
    }]
  : generateCycle1PromptVariants(maxIterations)

const watchedFiles = [
  ...listFilesRecursive(resolve(__dirname, '../defaults')),
  ...listFilesRecursive(resolve(__dirname, '../lib')),
  ...listFilesRecursive(resolve(__dirname, './lib')),
].filter(file => /\.(mjs|md|jsonl)$/i.test(file))
if (args.prompt_file) watchedFiles.push(resolve(String(args.prompt_file)))

let best = null
let noImprovement = 0
const lines = []

for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  const variant = promptVariants[Math.min(iteration - 1, promptVariants.length - 1)]
  if (!variant) break
  const sourceHash = hashFiles(watchedFiles)
  lines.push(`iteration=${iteration} source_hash=${sourceHash} variant=${variant.id}`)
  let benchmark
  try {
    benchmark = batchSize > 1
      ? await runCycle1BatchBenchmark(cases, {
          provider: providerOverride,
          batchSize,
          spec: variant.spec,
          includePrompt: true,
        })
      : await runCycle1Benchmark(cases, {
          provider: providerOverride,
          promptTemplate: variant.promptTemplate,
          includePrompt: true,
        })
  } catch (error) {
    lines.push(`  status=failed reason=${summarizeCycle1Error(error)}`)
    writeFileSync(join(runDir, 'loop.log'), `${lines.join('\n')}\n`)
    process.stderr.write(`${summarizeCycle1Error(error)}\n`)
    process.exit(1)
  }
  writeFileSync(join(runDir, `iter-${String(iteration).padStart(2, '0')}.json`), `${JSON.stringify(benchmark, null, 2)}\n`)
  const promptText = batchSize > 1
    ? buildBatchPrompt(cases.slice(0, Math.min(batchSize, cases.length)), { spec: variant.spec })
    : variant.promptTemplate
  writeFileSync(join(runDir, `iter-${String(iteration).padStart(2, '0')}.prompt.md`), `${promptText}\n`)
  const tuple = metricTuple(benchmark.summary)
  lines.push(`  tasks_hit1=${(benchmark.summary.tasks.hit_at_1 * 100).toFixed(1)} facts_recall=${(benchmark.summary.facts.avg_recall * 100).toFixed(1)} entities_recall=${(benchmark.summary.entities.avg_recall * 100).toFixed(1)}`)
  const current = { iteration, sourceHash, tuple, summary: benchmark.summary, variant_id: variant.id, variant_spec: variant.spec }

  if (!best || compareTuple(tuple, best.tuple) > 0) {
    best = current
    noImprovement = 0
    writeFileSync(join(runDir, 'best-summary.json'), JSON.stringify(best, null, 2))
    writeFileSync(join(runDir, 'best-prompt.md'), `${promptText}\n`)
    lines.push('  status=best')
  } else {
    noImprovement += 1
    lines.push(`  status=no_improvement (${noImprovement}/${patience})`)
  }

  writeFileSync(join(runDir, 'loop.log'), `${lines.join('\n')}\n`)
  if (noImprovement >= patience) {
    lines.push('stopped=patience')
    break
  }
}

writeFileSync(join(runDir, 'loop.log'), `${lines.join('\n')}\n`)
process.stdout.write(`best_iteration=${best?.iteration ?? 'none'}\nresults_dir=${runDir}\n`)
