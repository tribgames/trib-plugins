# Trib Memory Tuning Playbook

이 문서는 현재 `trib-memory`를 어떻게 점검하고 이어서 다듬을지에 대한 운영 기준입니다.

## 현재 기준 구조

지금 기준 메인 파이프라인:

```text
episodes
-> cycle1 classification
-> cycle2 correction
-> cycle3 context.md refresh
```

메인 저장 축:

- `episodes`
- `classifications`
- `history/context.md`

즉 예전의 `facts/tasks/signals/profiles/entities/relations/propositions`는 메인 파이프라인 기준으로 퇴역했습니다.

## 현재 핵심 점검 항목

1. `classifications`가 정상 적재되는지
2. `searchRelevantHybrid()`가 `classification -> episode` 중심으로 결과를 내는지
3. `buildInboundMemoryContext()`가 classification hint를 주는지
4. `context.md`가 classification 중심으로 갱신되는지
5. delta embedding이 정상 작동하는지

## 기본 smoke 체크

최소 smoke 시 기대 결과:

- episode append 가능
- classification upsert 가능
- classification 임베딩 가능
- query 시 `classification`이 1순위로 뜸
- hint에 `<hint type="classification" ...>`가 포함됨

## 현재 운영 포인트

- embedding 기본값: `ollama/bge-m3`
- `reranker`: 기본 `off`
- `temporalParser`: 기본 `off`
- AI 실행: 서버 내부 직접 spawn이 아니라 worker child를 통해 IPC로 호출

## worker 구조 점검

각 서버는 아래 패턴을 유지합니다.

```text
server
-> fork(worker)
-> IPC request/response
-> worker spawn(cli)
```

현재 반영 대상:

- `trib-memory`
- `trib-search`
- `trib-channels`

점검 포인트:

- 서버 시작 시 worker가 뜨는지
- 서버 종료 시 worker도 같이 내려가는지
- worker child에서만 CLI가 실행되는지
- 서버 본체가 직접 `codex` / `claude`를 장시간 물고 있지 않은지

## 지금부터의 개선 우선순위

1. 문서/설명/도구 스펙의 잔여 legacy 표현 제거
2. `memory.mjs`의 old schema helper 완전 제거
3. `memory-service.mjs`의 도구 표면을 `classifications + episodes` 기준으로 더 줄이기
4. 실제 데이터셋에서 classification coverage 확인
5. `context.md` 포맷 다듬기

## 더 이상 우선순위가 아닌 것

현재 기준으로는 아래는 메인 경로가 아닙니다.

- facts/task 기반 메모리 확장
- signal/profile/entity/relation graph 확장
- old proposition pipeline 복원

즉 새 구조 안정화 전에는 이 경로들을 다시 키우지 않습니다.

## 점검용 최소 실행 예시

개념적으로는 아래 흐름만 확인하면 됩니다.

1. episode 추가
2. classification 추가
3. classification 임베딩
4. 검색
5. hint 생성
6. context.md 생성

현재 기대 결과 예시:

```json
[
  {
    "type": "classification",
    "content": "업무 | 자동 바인딩 | 디스코드 | 확인 필요"
  },
  {
    "type": "episode",
    "content": "디스코드 자동 바인딩 상태 확인이 필요합니다"
  }
]
```

## 종료 기준

다음이 모두 만족되면 현재 단순화 라운드는 마감입니다.

- old runtime path가 실제 검색/힌트/컨텍스트 경로에서 더 이상 사용되지 않음
- classification/episode 중심 smoke가 안정적으로 통과
- context.md가 classification 중심으로 일관되게 생성됨
- 세 MCP 서버 worker 구조가 공통 패턴으로 맞춰짐

## 관련 문서

- [../RETRIEVAL-CLASSIFICATION-PLAN.md](../RETRIEVAL-CLASSIFICATION-PLAN.md)
- [../README.md](../README.md)
