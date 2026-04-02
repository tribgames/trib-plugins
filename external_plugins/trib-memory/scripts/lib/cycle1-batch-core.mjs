import { callLLM } from '../../lib/llm-provider.mjs'
import { extractJsonObject, loadCycle1Cases } from './cycle1-core.mjs'

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function scoreExpected(expected = [], actual = []) {
  if (expected.length === 0) return { hit1: 1, recall: 1, matched: 0, total: 0 }
  const normalizedActual = actual.map(normalizeText)
  let matched = 0
  for (const expectedItem of expected) {
    const normalizedExpected = normalizeText(expectedItem)
    if (normalizedActual.some(actualItem => actualItem.includes(normalizedExpected) || normalizedExpected.includes(actualItem))) {
      matched += 1
    }
  }
  return {
    hit1: matched > 0 ? 1 : 0,
    recall: matched / expected.length,
    matched,
    total: expected.length,
  }
}

function chunkCases(cases, batchSize) {
  const chunks = []
  for (let index = 0; index < cases.length; index += batchSize) {
    chunks.push(cases.slice(index, index + batchSize))
  }
  return chunks
}

function summarizeCandidate(caseId, candidate, index) {
  const candidateId = candidate?.id ? String(candidate.id).trim() : `${caseId}#${index + 1}`
  const role = String(candidate?.role ?? 'user').trim() || 'user'
  const content = String(candidate?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
  return `${candidateId} [${role}] ${content}`
}

function buildCasesTable(cases) {
  const lines = [
    '| case_id | today | candidate_ids | candidates |',
    '| --- | --- | --- | --- |',
  ]
  for (const testCase of cases) {
    const candidateIds = testCase.candidates
      .map((candidate, index) => candidate?.id ? String(candidate.id).trim() : `${testCase.id}#${index + 1}`)
      .join(', ')
    const candidates = testCase.candidates
      .map((candidate, index) => summarizeCandidate(testCase.id, candidate, index))
      .join(' <br> ')
    lines.push(`| ${testCase.id} | ${testCase.today} | ${candidateIds} | ${candidates} |`)
  }
  return lines.join('\n')
}

export function buildBatchPrompt(cases, options = {}) {
  const spec = options.spec ?? {}
  const taskBias = spec.taskBias === 'strong'
    ? 'Strongly prefer extracting concrete work as tasks. Only keep facts that are clearly durable.'
    : 'Prefer extracting concrete work as tasks. Keep only durable facts.'
  const rules = [
    'You are evaluating multiple cycle1 extraction cases at once.',
    'For each row, fill only the requested durable memory outputs.',
    'Do not add commentary outside JSON.',
    'Use case_id exactly as given.',
    taskBias,
    spec.keepLanguage === false
      ? 'Normalization is allowed if meaning stays intact.'
      : 'Preserve source language and technical identifiers as-is.',
    spec.includeDates === false
      ? 'Do not expand relative dates unless clearly necessary.'
      : 'Prefer absolute dates when the case explicitly includes relative time.',
    spec.includeResolution === false
      ? 'Do not force resolution facts unless a final fix is explicit.'
      : 'If a final fix is explicit, capture it as a resolution fact.',
    spec.includeConflict === false
      ? 'Do not infer conflicts unless directly stated.'
      : 'If newer input clearly supersedes older memory, keep the newer one.',
    spec.compact === true
      ? 'Keep outputs compact. Prefer 0-2 items per column unless clearly needed.'
      : 'Fill the columns carefully, but keep only durable items.',
  ]

  return [
    'Fill the missing extraction columns for each case row.',
    '',
    'Rules:',
    ...rules.map(rule => `- ${rule}`),
    '',
    'Return JSON only in this shape:',
    '{',
    '  "items": [',
    '    {',
    '      "case_id": "string",',
    '      "tasks": ["string"],',
    '      "facts": ["string"],',
    '      "entities": ["string"]',
    '    }',
    '  ]',
    '}',
    '',
    'Case table:',
    buildCasesTable(cases),
  ].join('\n')
}

function collectBatchOutputs(items = []) {
  const map = new Map()
  for (const item of items) {
    const caseId = String(item?.case_id ?? '').trim()
    if (!caseId) continue
    map.set(caseId, {
      tasks: Array.isArray(item?.tasks) ? item.tasks.map(value => String(value).trim()).filter(Boolean) : [],
      facts: Array.isArray(item?.facts) ? item.facts.map(value => String(value).trim()).filter(Boolean) : [],
      entities: Array.isArray(item?.entities) ? item.entities.map(value => String(value).trim()).filter(Boolean) : [],
    })
  }
  return map
}

async function runCycle1Batch(batchCases, options = {}) {
  const prompt = buildBatchPrompt(batchCases, options)
  const provider = options.provider
  const timeout = Number(options.timeout ?? 120000)
  const raw = await callLLM(prompt, provider, { timeout, cwd: options.cwd ?? process.cwd() })
  const parsed = extractJsonObject(raw)
  const outputs = collectBatchOutputs(parsed?.items ?? [])

  return batchCases.map(testCase => {
    const output = outputs.get(testCase.id) ?? { tasks: [], facts: [], entities: [] }
    return {
      id: testCase.id,
      label: testCase.label,
      today: testCase.today,
      outputs: output,
      scores: {
        tasks: scoreExpected(testCase.expected_tasks, output.tasks),
        facts: scoreExpected(testCase.expected_facts, output.facts),
        entities: scoreExpected(testCase.expected_entities, output.entities),
      },
      prompt: options.includePrompt ? prompt : undefined,
      raw: options.includeRaw ? raw : undefined,
    }
  })
}

export async function runCycle1BatchBenchmark(cases, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize ?? 30))
  const results = []
  const batchPrompts = []
  const totals = {
    tasks: { hit1: 0, recall: 0, total: 0 },
    facts: { hit1: 0, recall: 0, total: 0 },
    entities: { hit1: 0, recall: 0, total: 0 },
  }

  for (const batchCases of chunkCases(cases, batchSize)) {
    if (options.includePrompt) {
      batchPrompts.push(buildBatchPrompt(batchCases, options))
    }
    const batchResults = await runCycle1Batch(batchCases, options)
    for (const result of batchResults) {
      results.push(result)
      for (const key of Object.keys(totals)) {
        totals[key].hit1 += result.scores[key].hit1
        totals[key].recall += result.scores[key].recall
        totals[key].total += 1
      }
    }
  }

  const summary = {}
  for (const [key, value] of Object.entries(totals)) {
    summary[key] = {
      hit_at_1: value.total > 0 ? value.hit1 / value.total : 0,
      avg_recall: value.total > 0 ? value.recall / value.total : 0,
      total: value.total,
    }
  }

  return { results, summary, batch_prompts: options.includePrompt ? batchPrompts : undefined }
}

export { loadCycle1Cases }
