#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runClassificationBatch } from './lib/classification-core.mjs'

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

function loadRows(filePath) {
  const raw = readFileSync(resolve(String(filePath)), 'utf8').trim()
  if (!raw) return []
  return raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

const args = parseArgs(process.argv.slice(2))
if (!args.rows_file) {
  process.stderr.write('classification-batch: --rows-file is required\n')
  process.exit(1)
}

const rows = loadRows(args.rows_file)
if (rows.length === 0) {
  process.stderr.write('classification-batch: no rows found\n')
  process.exit(1)
}

const result = await runClassificationBatch(rows, {
  promptPath: args.prompt_file ? resolve(String(args.prompt_file)) : undefined,
  provider: args.provider_connection
    ? {
        connection: String(args.provider_connection),
        model: args.provider_model ? String(args.provider_model) : undefined,
        effort: args.provider_effort ? String(args.provider_effort) : undefined,
      }
    : undefined,
  includePrompt: Boolean(args.include_prompt),
})

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
