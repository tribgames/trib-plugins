# trib-memory

`trib-memory`는 `episodes`를 원본으로 저장하고, 그 위에서 `classifications`와 `context.md`를 만드는 장기 메모리 MCP 플러그인입니다.

현재 기준 메인 구조는 아래입니다.

```text
episodes
-> cycle1 classification
-> cycle2 correction
-> cycle3 context.md refresh
```

## 현재 canonical 구조

- 원본 소스 오브 트루스: `episodes`
- 파생 장기 메모리 저장: `classifications`
- 최종 장기 기억 출력: `history/context.md`

즉 예전의 `facts / tasks / signals / profiles / entities / relations / propositions` 중심 구조는 메인 경로에서 퇴역했고,
현재 검색/힌트/컨텍스트는 `classifications + episodes` 중심으로 동작합니다.

## 핵심 파일

- [lib/memory.mjs](./lib/memory.mjs)
  저장소, classification 저장, 검색, context 생성
- [lib/memory-cycle.mjs](./lib/memory-cycle.mjs)
  cycle1/2/3 파이프라인
- [lib/memory-context-builder.mjs](./lib/memory-context-builder.mjs)
  inbound hint 생성
- [services/memory-service.mjs](./services/memory-service.mjs)
  MCP/HTTP 진입점
- [lib/llm-provider.mjs](./lib/llm-provider.mjs)
  provider 추상화
- [lib/llm-worker-host.mjs](./lib/llm-worker-host.mjs)
  worker IPC host
- [services/llm-worker.mjs](./services/llm-worker.mjs)
  CLI worker child

## 현재 분류 스키마

1차 분류 필드는 아래 4개입니다.

- `classification`
- `topic`
- `element`
- `state`

예:

```json
{
  "classification": "업무",
  "topic": "자동 바인딩",
  "element": "디스코드",
  "state": "확인 필요"
}
```

## 검색 원칙

검색 본체는 아래 3개입니다.

- `keyword`
- `embedding`
- `time`

그리고 후반 보정은:

- `classification`
- `topic`
- `element`
- `state`
- `language`

순서로 약하게 곱 보정합니다.

즉 개념적으로는:

```text
base_score
* semantic_factor(classification/topic/element)
* state_factor
* time_factor
* language_factor
-> rerank
```

## 임베딩 정책

전체 재생성이 아니라 변경분만 갱신합니다.

- 새 `episode` 추가 후: 해당 episode만 임베딩
- 새 `classification` 반영 후: 해당 row만 임베딩
- 교정 후 변경된 row만 재임베딩

즉:

```text
delta update + spot update
```

## MCP worker 구조

비대화형 CLI 불안정을 줄이기 위해, 서버 내부에서 직접 CLI를 실행하지 않고 worker child를 띄웁니다.

구조:

```text
server
-> fork(worker)
-> IPC request
-> worker spawn(codex/claude/...)
-> IPC response
```

현재 이 패턴은 다음 서버들에 반영되어 있습니다.

- `trib-memory`
- `trib-search`
- `trib-channels`

## 운영 사이클

- `cycle1`
  새 episode를 읽고 `classifications`를 적재
- `cycle2`
  candidate 정리 / 교정
- `cycle3`
  `classifications` 기준 decay / cleanup + `context.md` 갱신

## 현재 recall 표면

현재 `recall_memory`의 핵심 모드는 두 개입니다.

- `search`
- `episodes`

주요 shortcut:

- `classifications`
- `episodes`
- `hints`

즉 broad long-term memory는 `classifications`, 상세 이벤트/날짜 추적은 `episodes`로 봅니다.

## 관련 문서

- [RETRIEVAL-CLASSIFICATION-PLAN.md](./RETRIEVAL-CLASSIFICATION-PLAN.md)
- [scripts/TUNING-PLAYBOOK.md](./scripts/TUNING-PLAYBOOK.md)

## 메모

- embedding 기본값은 `ollama/bge-m3`
- 일반 사용자 디폴트는 `reranker=off`, `temporalParser=off`
- `node_modules`, `scripts/results`, `services/__pycache__`는 커밋 대상이 아닙니다
