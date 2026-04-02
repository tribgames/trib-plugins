# RAG Trends & Memory Systems Research (2024-2025)

Comparison with trib-memory architecture.

---

## 1. RAG Architecture Trends (2024-2025)

### 1.1 Multi-Stage Retrieval Pipeline

The dominant pattern in production RAG systems has shifted from single-pass retrieval to multi-stage pipelines:

```
Query → Rewrite/Expand → Retrieve (hybrid) → Rerank → Filter → Generate
```

**Key stages:**

| Stage | Method | Purpose |
|-------|--------|---------|
| Query Rewriting | HyDE, Query2Doc, step-back prompting | Improve recall by expanding/transforming queries |
| First-pass Retrieval | BM25 + dense (bi-encoder) | Cast a wide net with hybrid search |
| Reranking | Cross-encoder (ColBERT, BGE-reranker) | Precision ranking on smaller candidate set |
| Post-filtering | Metadata, time, access control | Domain-specific constraints |

**trib-memory comparison:**
- trib-memory already uses a multi-stage approach: `hybrid search → late score adjustment → rerank`
- Current reranker: `Xenova/bge-reranker-large` cross-encoder — aligned with the industry standard
- **Gap:** No query rewriting stage. Adding HyDE (Hypothetical Document Embedding) or query expansion could improve recall for vague/short queries

### 1.2 Hybrid Search (BM25 + Dense)

Hybrid search combining sparse (BM25/FTS) and dense (embedding) retrieval is now considered baseline, not optional.

**Reciprocal Rank Fusion (RRF)** is the most common merge strategy:

```
RRF_score(d) = Σ 1 / (k + rank_i(d))
```

where k is typically 60. Alternative: linear combination with tunable alpha.

**trib-memory comparison:**
- Current: `base_score = keyword_score + embedding_score + time_retrieval_score` — additive combination
- Industry standard leans toward **RRF** or **learned weighted fusion** rather than raw score addition
- **Potential improvement:** Replace additive fusion with RRF or normalized score fusion. Raw BM25 scores and cosine similarities are on different scales, making addition unreliable without normalization

### 1.3 Adaptive / Router-Based RAG

**Self-RAG** (Aslan et al., 2023) and **CRAG** (Corrective RAG, Yan et al., 2024) introduced the concept of adaptive retrieval:

- Decide whether retrieval is needed at all
- Evaluate retrieved documents for relevance
- Self-correct by re-retrieving or falling back

**Routing patterns:**
- Simple queries → direct LLM answer (no retrieval)
- Factual queries → dense retrieval
- Temporal queries → filtered episode retrieval
- Policy/rule queries → structured lookup

**trib-memory comparison:**
- Intent classification (`profile/task/event/history/decision/policy`) already performs basic routing
- `looksLowSignalQuery` skips retrieval for trivial inputs
- **Gap:** No post-retrieval relevance evaluation. If retrieved documents are poor, the system doesn't self-correct or fall back to a different strategy

### 1.4 Late Chunking & Contextual Embedding

**Jina AI's Late Chunking** (2024) and **Anthropic's Contextual Retrieval** (2024):

- Instead of embedding isolated chunks, embed chunks with document-level context prepended
- Reduces "lost in the middle" problem
- Anthropic's approach: prepend a short context summary before each chunk before embedding

**trib-memory comparison:**
- Episodes are embedded as-is without surrounding context
- Classifications (classification/topic/element/state) are embedded as concatenated tags
- **Potential improvement:** Prepend episode context (e.g., session topic, speaker, preceding turn summary) to embedding input for richer semantic capture

---

## 2. Personal Memory Systems

### 2.1 MemGPT / Letta (Packer et al., 2023-2024)

Core concept: Treat LLM memory like an OS — with working memory, archival memory, and explicit memory management functions.

**Architecture:**
```
Working Memory (context window)
  ↕ memory_read / memory_write
Archival Memory (vector DB)
  ↕ search / insert
Recall Memory (conversation log)
```

Key innovations:
- LLM actively manages its own memory via function calls
- Paging mechanism for context overflow
- Self-directed memory consolidation

**trib-memory comparison:**
- Similar 3-tier approach: context.md (working), classifications (archival), episodes (recall)
- trib-memory's `recall_memory` with 7 modes parallels MemGPT's memory functions
- **Key difference:** MemGPT lets the LLM decide when/what to memorize. trib-memory uses automated cycle-based extraction (cycle1/2/3). The automated approach is more reliable for a plugin architecture but less adaptive

### 2.2 Episode-Based Memory

Research trend: storing conversations as **episodes** (timestamped interaction segments) rather than extracted facts.

**Benefits:**
- Preserves temporal ordering and context
- Enables "what did we discuss on Tuesday?" queries
- No information loss from extraction errors

**Implementations:**
- Google's Gemini memory: episode-first with periodic summarization
- ChatGPT memory: extracted facts + conversation references
- trib-memory: episodes as source-of-truth → classification extraction → context.md summary

**trib-memory comparison:**
- trib-memory's episode-first approach is well-aligned with this trend
- The cycle1→cycle2→cycle3 pipeline (extract → correct → summarize) follows the best practice of keeping raw episodes while building derived views
- **Strength:** This is one of trib-memory's strongest design decisions

### 2.3 Context Summarization (context.md pattern)

Long-running assistants need compressed "state of the world" summaries:

- **Claude Code auto-memory:** MEMORY.md index + individual memory files
- **Cursor/Windsurf:** .cursorrules / context files
- **trib-memory:** context.md generated from classifications via cycle3

**Industry pattern:** Hierarchical summarization with decay:
```
Recent episodes (full detail)
  → Session summaries (medium detail)
    → Long-term context (key facts only)
```

**trib-memory comparison:**
- context.md serves the "long-term context" tier well
- **Gap:** No intermediate "session summary" tier. Going from full episodes to context.md is a large jump. A session-level summary layer could improve retrieval for "what did we do last session?" queries

---

## 3. Scoring / Ranking Methods

### 3.1 Semantic Factor & Classification-Based Boosting

Using classification tags to adjust retrieval scores is an emerging pattern:

**Common approaches:**
1. **Tag-as-filter:** Hard filter by category (traditional, lossy)
2. **Tag-as-boost:** Soft multiplier based on tag match (trib-memory's approach)
3. **Tag-as-embedding:** Concatenate tags into embedding input
4. **Learned tag weights:** Train per-tag relevance weights from click/usage data

**trib-memory comparison:**
- Current: `semantic_factor = 1 + (w_class*class + w_topic*topic + w_element*element) * gain`
- This is approach #2 (tag-as-boost), which is reasonable
- **Potential improvement:** Also use approach #3 — include classification tags in the embedding text to improve dense retrieval alignment. This is complementary to the boost approach

### 3.2 Time Decay Models

**Common models:**

| Model | Formula | Characteristics |
|-------|---------|-----------------|
| Linear | `1 - age * rate` | Simple, trib-memory's current approach |
| Exponential | `exp(-λ * age)` | Faster initial drop, widely used |
| Power-law | `1 / (1 + age)^α` | Matches human memory curves |
| Frequency-adjusted | `decay * (1 + log(access_count))` | Rewards frequently accessed memories |

**Research (Ebbinghaus curve models):**
- Memories accessed more frequently should decay slower
- Spaced repetition research shows log-frequency is optimal

**trib-memory comparison:**
- Current: linear decay with `decayPerDay=0.02`, clamped to `[0.8, 1.4]`, plus `recentBoostDays=3` binary boost
- `decayConfidence` in memory-decay-utils: linear penalty `age/180 * 0.25`
- **Potential improvement:**
  1. Switch to exponential or power-law decay for more natural memory curves
  2. Add access-frequency factor — memories recalled more often should decay slower
  3. The binary recent boost (`recentBoostDays: 3 → 1.2x`) could be replaced by a smooth curve

### 3.3 Intent-Based Routing & Scoring

Modern systems route queries to different scoring strategies based on intent:

```
"What did I say yesterday?" → temporal routing → episode lookup, time-weighted
"How should I address the user?" → profile routing → policy lookup, frequency-weighted
"What's the status of X?" → task routing → task lookup, recency-weighted
```

**trib-memory comparison:**
- Intent classification already exists with prototype-based cosine similarity
- `getIntentTypeCaps` adjusts result type distribution by intent
- `getIntentSubtypeBonus` applies per-intent score adjustments
- **Strength:** This is already well-implemented. The prototype embedding approach is pragmatic and effective
- **Potential improvement:** Per-intent scoring weight profiles (e.g., time decay matters more for event queries, semantic match matters more for topic queries)

---

## 4. Key Papers & Projects

### 4.1 Core RAG Papers

| Paper | Year | Key Contribution | Relevance to trib-memory |
|-------|------|-----------------|-------------------------|
| **RAPTOR** (Sarthi et al.) | 2024 | Recursive tree summarization for retrieval | Hierarchical context.md could use tree-based summarization |
| **Self-RAG** (Aslan et al.) | 2023 | Self-reflective retrieval with critique tokens | Post-retrieval relevance check before injection |
| **CRAG** (Yan et al.) | 2024 | Corrective RAG with web search fallback | Fallback strategy when local retrieval fails |
| **HyDE** (Gao et al.) | 2023 | Hypothetical document embedding for query expansion | Improve recall for vague queries |
| **ColBERT v2** (Santhanam et al.) | 2022 | Late-interaction reranking | More efficient than full cross-encoder reranking |
| **RankGPT** (Sun et al.) | 2023 | LLM-based listwise reranking | LLM reranking as alternative to cross-encoder |

### 4.2 Memory-Specific Papers

| Paper | Year | Key Contribution | Relevance to trib-memory |
|-------|------|-----------------|-------------------------|
| **MemGPT** (Packer et al.) | 2023 | OS-like memory management for LLMs | Architecture validation — trib-memory follows similar tiered approach |
| **LongMem** (Wang et al.) | 2023 | Decoupled memory for long-term retention | Separate memory network from main model |
| **Memorag** (Qian et al.) | 2024 | Memory-augmented RAG with global memory | Dual-system: clue generation + retrieval |
| **HippoRAG** (Gutierrez et al.) | 2024 | Hippocampus-inspired indexing for RAG | Pattern separation + completion for memory |
| **MemoryBank** (Zhong et al.) | 2024 | Ebbinghaus-curve memory with forgetting | Psychologically-grounded decay functions |

### 4.3 Relevant Open-Source Projects

| Project | Description | Relevance |
|---------|-------------|-----------|
| **Mem0** (formerly EmbedChain) | Production memory layer for AI apps | Competing approach: graph-based memory + vector search |
| **Letta** (MemGPT) | Self-managing memory agent framework | Reference for memory management patterns |
| **Cognee** | Memory enrichment pipeline | Graph extraction + vector hybrid |
| **LangGraph** | Stateful agent framework with persistence | Checkpoint-based memory pattern |

---

## 5. Classification + Embedding Hybrid Approaches

### 5.1 Tag-Enhanced Retrieval

The pattern of combining classification tags with embedding search:

**Method 1: Pre-retrieval tag routing**
```
Query → classify intent → select tag filter → retrieve within filter
```
Risk: Hard filters can miss cross-category results.

**Method 2: Post-retrieval tag boosting** (trib-memory's current approach)
```
Query → retrieve all → boost by tag match → rerank
```
Safe but tags have limited influence.

**Method 3: Tag-embedded retrieval**
```
Embed("업무 | 자동 바인딩 | 디스코드 | 진행 중 | <actual content>")
```
Tags become part of the semantic space. Best of both worlds.

**Method 4: Faceted search with learned weights**
```
score = α * semantic_sim + β * tag_overlap + γ * temporal_score
where α, β, γ are learned from user feedback
```

**trib-memory comparison:**
- Currently Method 2 (post-retrieval boosting)
- **Recommendation:** Add Method 3 as complement — when building embedding text for classifications, prepend the tag fields. This way dense retrieval naturally benefits from classification data without needing explicit boosting. The existing boosting can remain as a secondary adjustment

### 5.2 Dynamic Weight Learning

Instead of static `w_class=0.5, w_topic=0.3, w_element=0.2`:

- Track which weight configurations lead to used (clicked/referenced) results
- Periodically adjust weights based on feedback signals
- Even simple EMA (exponential moving average) of "which factor predicted useful results" would help

**trib-memory comparison:**
- Current weights are static defaults
- **Potential improvement:** Log retrieval outcomes (was the hint used?) and periodically adjust weights. Even manual tuning based on logged data would be valuable

---

## 6. Improvement Recommendations for trib-memory

Ordered by estimated impact and implementation effort.

### High Impact, Moderate Effort

1. **Score Normalization / RRF Fusion**
   - Replace additive `keyword + embedding + time` with RRF or min-max normalized fusion
   - Current additive approach mixes incompatible scales
   - Implementation: modify `memory-score-utils.mjs` base_score calculation

2. **Contextual Embedding Input**
   - When embedding episodes, prepend context: `"[업무 | 메모리 구조 | trib-memory] 실제 대화 내용..."`
   - When embedding classifications, include source episode summary
   - Implementation: modify embedding input construction in `memory.mjs`

3. **Exponential Time Decay**
   - Replace linear `1 - age * 0.02` with `exp(-0.03 * age)` or power-law `1 / (1 + age/7)^0.5`
   - Add access-frequency multiplier: `decay * (1 + 0.1 * log(access_count + 1))`
   - Implementation: modify `computeTimeFactor` in `memory-score-utils.mjs` and `decayConfidence` in `memory-decay-utils.mjs`

### Medium Impact, Low Effort

4. **Per-Intent Scoring Profiles**
   - Different weight distributions for different intents:
     - `event/history`: time weight high, semantic weight low
     - `task`: state weight high, time weight medium
     - `profile/policy`: semantic weight high, time weight low
   - Implementation: extend `memory-tuning.mjs` with per-intent scoring configs

5. **Query Expansion for Short Queries**
   - For queries under ~3 tokens, generate expanded query variants
   - `generateQueryVariants` in `memory-text-utils.mjs` already exists but could be enhanced
   - Add simple HyDE-like expansion: ask LLM to generate what a relevant memory might look like

6. **Session Summary Layer**
   - Add intermediate summarization between episodes and context.md
   - Per-session summaries (~1 paragraph each) as a new retrieval type
   - Improves "what did we discuss last time?" queries

### Lower Priority, Worth Tracking

7. **Post-Retrieval Relevance Check**
   - After retrieval, use a lightweight check (could be the existing cross-encoder) to filter truly irrelevant results before injection
   - Reduces noise in `<memory-context>` hints

8. **Retrieval Outcome Logging**
   - Log which hints were actually referenced by Claude (via response analysis)
   - Use for weight tuning and quality measurement

9. **Focus Vector Enhancement**
   - `buildRecentFocusVector` already exists — enhance with weighted recency (recent turns count more)
   - Consider multi-vector focus (separate vectors for topic vs. entity vs. intent)

---

## 7. Architecture Comparison Summary

```
                    trib-memory          Industry Best Practice (2025)
─────────────────────────────────────────────────────────────────────
Source of truth      episodes             episodes / documents
Extraction           cycle1 classify      chunk + extract entities
Correction           cycle2 correct       quality filters / dedup
Summarization        cycle3 context.md    hierarchical summarization
Hybrid search        BM25 + dense         BM25 + dense (same)
Score fusion         additive             RRF or normalized blend
Reranking            cross-encoder        cross-encoder (same)
Time decay           linear + boost       exponential / power-law
Classification use   post-retrieval boost tag-in-embedding + boost
Intent routing       prototype cosine     classifier + per-intent config
Query expansion      basic variants       HyDE / query rewrite
Context injection    passive hints + active recall   similar patterns
Memory management    automated cycles     LLM-directed or automated
```

trib-memory's overall architecture is sound and well-aligned with current trends. The episode-first design, classification-based scoring, and dual-path injection (passive + active) are strong foundations. The main gaps are in score fusion methodology, embedding enrichment, and decay modeling — all addressable with targeted modifications to existing code.
