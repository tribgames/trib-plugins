function buildSchemaBlock() {
  return [
    'Return this shape:',
    '{',
    '  "profiles": [{ "key": "string", "value": "string", "confidence": 0.0 }],',
    '  "facts": [{ "type": "preference|constraint|decision|fact|resolution", "slot": "optional", "workstream": "optional", "text": "string", "confidence": 0.0 }],',
    '  "tasks": [{ "title": "string", "details": "optional", "workstream": "optional", "stage": "planned|implementing|wired|done", "evidence_level": "claimed|implemented|verified", "status": "active|done", "priority": "low|normal|high", "confidence": 0.0 }],',
    '  "signals": [{ "kind": "language|tone|interest|cadence|dev_pattern", "value": "string", "score": 0.0 }],',
    '  "entities": [{ "name": "string", "type": "project|tool|person|system", "description": "string" }],',
    '  "relations": [{ "source": "string", "target": "string", "type": "uses|depends_on|part_of|integrates_with", "description": "string", "confidence": 0.0 }]',
    '}',
  ].join('\n')
}

function buildRules(spec = {}) {
  const rules = [
    'Ignore chatter, acknowledgements, filler, and execution noise.',
    spec.taskBias === 'strong'
      ? 'Strongly prefer extracting concrete work as tasks. Only keep facts that are stable and durable.'
      : 'Prefer extracting concrete work as tasks when the text is about requested implementation or debugging work.',
    'Keep only stable preferences, constraints, decisions, active tasks, and behavioral signals.',
    'Facts must be self-contained and durable. Omit temporary implementation chatter.',
    'Do not keep benchmark/config bookkeeping or internal memory-pipeline notes as durable facts.',
    'Do not keep "the user asked us to do X" as a fact; that should become a task.',
    'Tasks need a clear subject and action. Use stage: planned|implementing|wired|done.',
    'Signals capture recurring patterns such as language, tone, cadence, and dev patterns.',
    'Entities/relations should only cover stable named things and stable connections.',
  ]

  if (spec.compact !== true) {
    rules.push('Do not turn maintenance rules, cleanup thresholds, or internal scheduling notes into durable facts.')
    rules.push('If a sentence is about concrete work to do, bug investigation, or follow-up implementation, prefer extracting it as a task rather than a fact.')
  }

  if (spec.keepLanguage) {
    rules.push('Preserve the source language of each extracted value. Do not translate technical terms or identifiers.')
  }

  if (spec.includeConflict) {
    rules.push('If existing memories or newer input conflict, prioritize the most recent information.')
  }

  if (spec.includeDates) {
    rules.push('Convert relative dates to absolute dates using {{TODAY}} as the reference date.')
  }

  if (spec.includeResolution) {
    rules.push('Extract final bug fixes or debugging outcomes as facts with type "resolution".')
  }

  return rules
}

export function buildCycle1VariantPrompt(spec = {}) {
  const lines = [
    'Extract durable memory from recent user messages. Output JSON only.',
    "Today's date: {{TODAY}}",
    '',
    'Rules:',
    ...buildRules(spec).map(rule => `- ${rule}`),
    '',
    buildSchemaBlock(),
    '',
    'Candidates:',
    '',
    '{{CANDIDATES}}',
  ]
  return lines.join('\n')
}

export function generateCycle1PromptVariants(limit = 50) {
  const variants = []
  const bools = [true, false]
  const taskBiases = ['normal', 'strong']

  variants.push({
    id: 'baseline',
    promptTemplate: buildCycle1VariantPrompt({
      compact: false,
      taskBias: 'normal',
      keepLanguage: true,
      includeConflict: true,
      includeDates: true,
      includeResolution: true,
    }),
    spec: {
      compact: false,
      taskBias: 'normal',
      keepLanguage: true,
      includeConflict: true,
      includeDates: true,
      includeResolution: true,
    },
  })

  for (const compact of bools) {
    for (const taskBias of taskBiases) {
      for (const keepLanguage of bools) {
        for (const includeConflict of bools) {
          for (const includeDates of bools) {
            for (const includeResolution of bools) {
              const spec = { compact, taskBias, keepLanguage, includeConflict, includeDates, includeResolution }
              const id = [
                compact ? 'compact' : 'full',
                taskBias,
                keepLanguage ? 'keep-lang' : 'drop-lang',
                includeConflict ? 'conflict' : 'no-conflict',
                includeDates ? 'dates' : 'no-dates',
                includeResolution ? 'resolution' : 'no-resolution',
              ].join('__')
              if (variants.some(item => item.id === id)) continue
              variants.push({
                id,
                promptTemplate: buildCycle1VariantPrompt(spec),
                spec,
              })
              if (variants.length >= limit) return variants
            }
          }
        }
      }
    }
  }

  return variants.slice(0, limit)
}
