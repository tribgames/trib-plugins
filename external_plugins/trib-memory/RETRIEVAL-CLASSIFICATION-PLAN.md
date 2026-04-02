# Retrieval / Classification Working Plan

이 문서는 `trib-memory`의 현재 합의안을 계속 갱신하는 작업 문서입니다.
앞으로 분류 기준, 점수식, 임베딩 정책, MCP worker 구조가 바뀌면 이 문서를 기준으로 먼저 수정합니다.

## 1. 현재 최종 방향

- 원본 소스 오브 트루스는 `episodes`입니다.
- 장기기억은 별도 복잡한 메모리 테이블이 아니라 `context.md`입니다.
- 따라서 메인 파이프라인은:

```text
episodes
-> 1차 분류
-> 2차 교정
-> 3차 context.md 반영
```

- 예전의 `facts / tasks / signals / profiles / entities / relations`는 메인 장기 구조로 두지 않습니다.
- 검색 본체는 `단어 검색 + 시간 검색` 중심으로 유지합니다.
- 분류값은 검색을 뒤엎는 하드 필터가 아니라 `약한 후반 보정`으로만 사용합니다.

## 2. 1차 분류 스키마

1차에서 뽑는 필드는 아래 4개만 사용합니다.

- `분류`
- `주제`
- `요소`
- `상태`

각 필드는 기본적으로 `1개씩` 뽑습니다.

### 2.1 분류

대화의 가장 큰 성격입니다.

예:

- `업무`
- `일상`
- `상담`
- `해당 없음`

원칙:

- 반드시 하나는 고를 수 있어야 합니다.
- 가장 큰 방향만 잡습니다.
- 세부 소분류는 현재 메인 스키마에서 제외합니다.

### 2.2 주제

지금 무엇에 대해 이야기하는지 나타내는 핵심 논점입니다.

예:

- `자동 바인딩`
- `메모리 구조`
- `종교`

원칙:

- 너무 세밀한 태그보다 대표 주제 1개를 고릅니다.
- 검색용 키워드와 겹쳐도 괜찮지만, 가능하면 `무슨 얘기인가`에 가깝게 둡니다.

### 2.3 요소

대화에서 가장 중심이 되는 대상/키워드입니다.

예:

- `디스코드`
- `trib-memory`
- `하느님`

원칙:

- 주제와 다를 수 있습니다.
- 가능한 한 대표 요소 1개만 둡니다.

### 2.4 상태

현재 상태나 진행도를 짧게 나타냅니다.

예:

- `확인 필요`
- `진행 중`
- `완료`

원칙:

- 상태는 애매할 수 있으므로 가장 약하게 취급합니다.
- 뚜렷하지 않으면 비우는 것도 허용합니다.

## 3. 검색과 점수 보정

## 3.1 검색 본체

검색 원점수는 아래 축을 중심으로 만듭니다.

- `키워드/단어`
- `임베딩 유사도`
- `시간`

즉 기본 점수는 대략 아래처럼 생각합니다.

```text
base_score = keyword_score + embedding_score + time_retrieval_score
```

## 3.2 분류/주제/요소 보정

`분류 / 주제 / 요소`는 총량 `1.0` 안에서 비율을 나눠 갖습니다.

```text
w_class + w_topic + w_element = 1.0
```

권장 시작값:

- `w_class = 0.5`
- `w_topic = 0.3`
- `w_element = 0.2`

이 값으로 semantic 보정 원값을 만듭니다.

```text
semantic_raw =
  (w_class * class_match) +
  (w_topic * topic_match) +
  (w_element * element_match)
```

그리고 이것을 약한 multiplier로 바꿉니다.

```text
semantic_factor = 1 + (semantic_raw * semantic_gain)
```

권장 시작값:

- `semantic_gain = 0.35`

즉 `분류 / 주제 / 요소`는 더하기보다, 하나의 의미 보정값으로 합쳐서 곱해집니다.

## 3.3 상태 / 시간 / 언어 보정

나머지 보정은 별도 multiplier로 둡니다.

```text
final_score =
  base_score
  * semantic_factor
  * state_factor
  * time_factor
  * language_factor
```

권장 원칙:

- `time_factor`: 가장 강함
- `state_factor`: 가장 약함
- `language_factor`: 마지막 미세 조정

예시 범위:

- `state_factor`: `0.9 ~ 1.1`
- `time_factor`: `0.8 ~ 1.4`
- `language_factor`: `0.95 ~ 1.05`

## 3.4 리랭크

최종 후보 정렬 뒤에 필요 시 리랭크를 붙입니다.

```text
retrieve
-> late score adjustment
-> rerank
```

즉 구조는:

- 검색 본체: `키워드 + 임베딩 + 시간`
- 후반 보정: `분류 / 주제 / 요소 / 상태 / 언어`
- 마지막 정리: `rerank`

## 4. 2차 / 3차 역할

## 4.1 2차

2차는 새 필드를 만드는 단계가 아닙니다.
1차 결과를 교정하고 정리하는 단계입니다.

역할:

- 중복 제거
- 표현 통일
- 오분류 수정
- 요소/주제 경계 교정
- 상태 과잉 추출 정리

즉 2차는 `분류 / 주제 / 요소 / 상태`를 더 안정적으로 만드는 단계입니다.

## 4.2 3차

3차는 `context.md` 반영 단계입니다.

역할:

- 대화 종료 여부 반영
- 상태/진척 갱신
- 장기적으로 남길 항목 선별
- `context.md` 갱신

즉 3차는 새 분류를 더 만드는 게 아니라, 장기기억으로 올릴 내용을 최종 정리하는 단계입니다.

## 5. 임베딩 정책

임베딩은 전체 재생성이 아니라 `변경분만` 갱신합니다.

원칙:

- 초기 episode 저장 후: 변경/추가분만 임베딩
- 1차 분류 후: 변경된 컬럼만 반영해서 임베딩
- 2차/3차 교정 후: 바뀐 부분만 다시 임베딩

즉 전체 정책은:

```text
delta update + spot update
```

### 5.1 왜 이렇게 하나

- 중간 단계마다 전체 재임베딩은 비용이 큽니다.
- 분류/주제/요소/상태 중 일부만 바뀌는 경우가 많습니다.
- 따라서 컬럼 단위 변경 감지 후, 해당 row의 검색 표현만 다시 만드는 편이 적절합니다.

## 6. MCP 서버 리팩토링 방향

현재 `-p` 계열 비대화형 CLI 호출이 불안정한 문제가 있으므로, 각 MCP 서버는 worker 프로세스를 하나 따로 띄우는 방향으로 정리합니다.

기본 구조:

```text
run-mcp.mjs
-> server.mjs
-> child_process.fork('worker.mjs')
-> worker가 CLI spawn
-> IPC로 결과 반환
```

세부 흐름:

1. `server.mjs` 시작 시 `worker.mjs`를 `fork()`로 띄웁니다.
2. 서버가 AI 요청을 받으면 IPC로 worker에 전달합니다.
3. worker가 실제 CLI(`codex`, `claude` 등)를 `spawn()`합니다.
4. worker가 결과를 IPC로 서버에 돌려줍니다.
5. MCP 서버 종료 시 worker도 같이 kill합니다.
6. worker가 물고 있는 하위 CLI 프로세스도 함께 정리합니다.

### 6.1 장점

- 비대화형 CLI의 불안정성을 서버 본체 밖에서 격리할 수 있습니다.
- timeout / retry / cancel / shutdown 처리를 공통화할 수 있습니다.
- CLI 세션/프로세스 관리 책임을 분리할 수 있습니다.

### 6.2 적용 범위

현재 `tribgames`의 MCP 서버는 배포 단위가 각각 다르므로, 구현은 각 서버별로 따로 적용합니다.

대상:

- `trib-memory`
- `trib-search`
- `trib-channels`

원칙:

- 설계는 동일하게
- 구현은 서버별로 개별 적용
- 필요하면 인터페이스만 맞추고 내부 구현은 각 서버 맥락에 맞춤

권장 적용 순서:

1. `trib-memory`
2. `trib-search`
3. `trib-channels`

## 7. 현재 결정 사항 요약

- 메인 스키마는 `분류 / 주제 / 요소 / 상태`
- 원본은 `episodes`
- 장기기억은 `context.md`
- 검색은 `키워드 + 임베딩 + 시간`
- 후반 보정은 `분류 / 주제 / 요소` 총량 1 분배 + `상태 / 시간 / 언어` 곱 보정
- 임베딩은 전체 재생성이 아니라 `변경분만`
- 2차는 교정, 3차는 `context.md` 반영
- AI 실행 계층은 `server -> worker fork -> CLI spawn -> IPC 반환`

## 8. 다음 작업

1. `trib-memory` 기준으로 `worker.mjs` 계층 도입
2. `분류 / 주제 / 요소 / 상태` 기준 프롬프트 재정리
3. late score 계산식 구현
4. `context.md` 갱신 규칙 정리
5. 같은 구조를 `trib-search`, `trib-channels`에 개별 적용

## 한 줄 결론

현재 `trib-memory` 계열은 `episodes -> 1차 분류(분류/주제/요소/상태) -> 2차 교정 -> 3차 context.md 반영` 구조로 단순화하고, 검색은 `키워드+임베딩+시간`, 후반은 `분류/주제/요소` 비율 보정과 `상태/시간/언어` multiplier로 정리하는 것이 맞습니다.
