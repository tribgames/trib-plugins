# Memory Decay & Importance Plan

## Overview

Memory decay is not uniform. Some memories persist almost forever (rules, decisions),
while others fade quickly (one-off questions).

Single power-law curve, controlled by per-tag factor applied to the decay amount.

## Classification Schema

```
cycle1 output: topic, element, importance
```

3 fields. No state, no classification (대주제).

- **topic**: concise phrase, what the conversation is about
- **element**: central keyword/object, most discriminative field
- **importance**: tags from predefined set, comma-separated

## Importance Tags

LLM picks applicable tags. Empty if unclear.

| Tag | Meaning | tag_factor | Effect |
|-----|---------|-----------|--------|
| rule | Policy, constraint, prohibition | 0.0 | Never decays |
| directive | Strong user request, emphasis | 0.1 | Almost never |
| decision | Agreement, confirmed direction | 0.2 | Very slow |
| preference | Taste, style, personal choice | 0.15 | Very slow |
| incident | Something that happened, outage | 0.5 | Half speed |
| transient | One-off question, confirmation | 1.5 | Fast decay |
| (empty) | Default, no clear signal | 1.0 | Normal curve |

`interest` removed — day_count/frequency are unreliable signals
(long debugging sessions ≠ interest, "커밋하자" every day ≠ interest).

## Decay Model

### Power-Law Base Curve

```
decay = 1 / (1 + age / halfLife) ^ alpha

halfLife = 30 days
alpha = 0.3
```

### Tag Factor Applied to Loss

```
loss = 1 - decay
actual_loss = loss * tag_factor
time_factor = 1 - actual_loss
```

Examples at 90 days:

| Tag | tag_factor | time_factor |
|-----|-----------|-------------|
| rule | 0.0 | 1.00 |
| directive | 0.1 | 0.97 |
| preference | 0.15 | 0.95 |
| decision | 0.2 | 0.93 |
| incident | 0.5 | 0.83 |
| (default) | 1.0 | 0.66 |
| transient | 1.5 | 0.50 |

### Multiple Tags

When multiple tags present, use the **lowest tag_factor** (most important wins).

```
tag_factor = min(factors for all tags)
```

## Context.md Promotion

When cycle1 produces a tag with factor < 0.5 (rule/directive/decision/preference/incident):
- Check for duplicate in context.md (same element)
- New → append
- Duplicate → merge (newer version)
- Contradiction → supersede (replace old)

## Supersede Logic

Same element + contradicting content → replace.
Mark old as deprecated with `superseded_by` reference.

## Retrieval Count

Tracked in DB (retrieval_count column, already exists).
NOT used in decay calculation for now.
Reserved for future calibration when enough data accumulates.

## Cycle Integration

- **cycle1** (periodic): extract topic, element, importance → tag detected with factor < 0.5 → context.md promotion signal
- **cycle2** (daily): duplicate/merge/supersede validation
- **cycle3** (weekly): rebuild context.md from validated long-term entries

## Open Questions

1. Supersede aggressiveness — how similar must element+topic be to trigger?
2. Should rule/directive ever expire? (e.g., 1 year with 0 retrieval)
3. context.md max size — prune lowest-importance entries when full?
