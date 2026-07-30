# Spatialize architecture

Spatialize is one FastAPI service + one React/Three.js web app + Backblaze B2,
with genblaze orchestrating every generative step. The design rule throughout:
**models propose, validators dispose** — no AI output reaches the scene or the
user without passing a deterministic gate.

## System overview

```mermaid
flowchart LR
    subgraph Browser
        UI["React + Three.js\nspatial twin, voice capture"]
    end

    subgraph API["FastAPI (one container)"]
        RUNS["Run service\nhashing, review workflow"]
        LOOP["Agentic extraction\ngenblaze AgentLoop"]
        VOICE["Voice harness\nLangGraph ReAct agent"]
        GATE{{"Topology gate\nPydantic SpatialScene"}}
        TOOLS["Scene tools\nread + gated mutations"]
    end

    subgraph Providers
        OR["OpenRouter / Gemini\nvision + reasoning"]
        AAI["AssemblyAI\nspeech-to-text"]
        TTS["Gemini TTS\ncustom genblaze provider"]
    end

    B2[("Backblaze B2\nplans · scenes · audio · manifests")]

    UI -->|"plan upload / voice question"| API
    RUNS --> B2
    LOOP --> OR
    LOOP --> GATE
    VOICE --> AAI
    VOICE --> TOOLS
    TOOLS --> GATE
    VOICE --> TTS
    TTS -->|"genblaze ObjectStorageSink"| B2
    B2 -->|"presigned URLs"| UI
```

## The agentic extraction loop

A genblaze `AgentLoop` composes a pipeline factory with an **Evaluator**. Ours
is not an LLM judge — it is the same deterministic geometric validator that
guards every write. Failed attempts feed their exact errors back as the next
prompt, and every iteration is `parent_run_id`-linked in manifest lineage.

```mermaid
sequenceDiagram
    participant U as Uploader
    participant A as API
    participant L as genblaze AgentLoop
    participant V as Vision model
    participant G as Topology gate
    participant B as B2

    U->>A: POST /api/runs (floor plan)
    A->>B: store hashed source plan
    U->>A: POST /api/runs/{id}/extract
    A->>L: run loop (max N iterations)
    loop until passed or budget spent
        L->>V: plan image + schema prompt (+ prior errors)
        V-->>L: candidate scene.json
        L->>G: validate geometry
        alt scene is sound
            G-->>L: passed
        else violations found
            G-->>L: "door X not on boundary of room Y", ...
            Note over L: errors become the next\niteration's refinement prompt
        end
    end
    A->>B: candidate scene + manifest (parent-linked lineage)
    A-->>U: status review-required
```

Checks the gate enforces (both in Zod on the client and Pydantic on the API):

- every polygon point inside scene bounds; unique entity ids
- every door on the boundary polyline of each room it connects (±0.15 m)
- route-edge distance equals node geometry (±10 %)
- cross-room edges reference a door that connects both rooms and lies on the segment
- accessible edges never pass through inaccessible doors
- route nodes inside their declared room; pixel↔metre scale consistency

## The voice loop

```mermaid
sequenceDiagram
    participant P as Person
    participant A as API
    participant B as B2
    participant S as AssemblyAI (genblaze)
    participant AG as LangGraph agent
    participant T as Scene tools
    participant G as Topology gate
    participant X as Gemini TTS (genblaze)

    P->>A: POST /ask (voice recording)
    A->>B: store recording, presign URL
    A->>S: transcribe(url)
    S-->>A: transcript + word timings + manifest hash
    Note over A: low confidence → ask to repeat,\nnever act on a shaky transcript
    A->>AG: question + scene session
    loop tool rounds (budgeted)
        AG->>T: resolve / route / mutate
        alt mutation
            T->>G: validate draft scene
            G-->>T: commit or exact errors
            Note over AG: errors return as tool output\n— the agent self-corrects
        end
        T-->>AG: grounded result
    end
    AG-->>A: speakable answer (+ mutation log)
    A->>B: new scene version (parent-linked, needs-review)
    A->>X: narrate(answer)
    X->>B: audio + embedded manifest via sink
    A-->>P: transcript, answer, captions, B2 audio URL, manifest hashes
```

Guardrails in the harness: answers come only from tool results; ambiguous
references trigger a clarifying question instead of action; severed-route
warnings **must** be spoken; provider failures degrade (captions + on-device
speech) rather than fail the answer; tool-round and rate budgets cap every
conversation.

## Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> source_stored: plan uploaded, hashed, in B2
    source_stored --> extracting: POST /extract
    extracting --> review_required: gate passed (scene v1)
    extracting --> failed: gate refused all iterations
    extracting --> source_stored: extractor unavailable (retryable)
    review_required --> review_required: voice edit → scene v2..vN, re-flagged
    review_required --> approved: human resolves issues\nPOST /approve
    approved --> review_required: later voice edit
    failed --> extracting: retry
```

## What lands in B2

```
spatialize/
├── runs/public/{date}/{run_id}/
│   ├── source/plan.png              # hashed original
│   ├── run.json                     # run record
│   ├── scene/candidate.json         # first gated extraction
│   ├── scene/versions/v0002.json    # every voice edit, parent-linked
│   ├── scene/approved.json          # human-approved publish
│   └── voice/questions/*.wav        # what was asked
├── generated/runs/{date}/{run_id}/  # genblaze ObjectStorageSink
│   ├── assets/*.wav                 # narrated answers
│   └── manifest.json                # SHA-256 canonical provenance
└── run-index/{run_id}.json          # O(1) run lookup
```

Voice edits carry `method: "human"` evidence quoting the spoken transcript, so
an auditor can trace any vertex to either a model manifest or a human utterance.

## Module map

| Path | Responsibility |
|---|---|
| `backend/spatialize_api/models.py` | `SpatialScene` contract + topology validator (the gate) |
| `backend/spatialize_api/workflow.py` | run lifecycle, scene versioning, review-gated approval |
| `backend/spatialize_api/agents/extraction.py` | AgentLoop factory + evaluator, vision providers (OpenRouter/Gemini) |
| `backend/spatialize_api/agents/tools.py` | scene reads, Dijkstra routing, draft-validate-commit mutations |
| `backend/spatialize_api/agents/voice.py` | LangGraph harness, guardrail prompt, provider fallbacks |
| `backend/spatialize_api/media/` | genblaze pipelines: STT, TTS provider, B2 sink |
| `backend/spatialize_api/storage.py` | run store: local disk or B2 (S3 API, presigned URLs) |
| `src/domain/spatial-scene.ts` | the same contract in Zod for the client |
| `src/components/SpatialCanvas.tsx` | deterministic Three.js compilation of a scene |
| `src/lib/routes.ts` | client-side accessible-route rehearsal |
