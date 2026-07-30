# Spatialize

Speak to a floor plan — it answers, and it builds itself. Spatialize turns flat
venue plans into explorable, audible, editable spatial twins, with every word
and vertex provenance-stamped in Backblaze B2.

Built for the Backblaze Generative Media Hackathon with **Genblaze** + **B2**.

## AI providers and models

| Capability | Provider / model | How |
|---|---|---|
| Floor-plan extraction | Google `gemini-2.5-pro` | genblaze `AgentLoop`: a vision step proposes `scene.json`; the Pydantic topology gate is the loop's Evaluator; validation errors feed the next iteration; every attempt is `parent_run_id`-linked |
| Voice questions (STT) | AssemblyAI `universal-3-pro` | `genblaze-assemblyai` pipeline step — hash-verified transcript + word timings |
| Agent reasoning | Google `gemini-2.5-flash` | LangGraph ReAct agent over scene-grounded tools; reads answer from validated geometry, writes pass the same topology gate |
| Narrated answers (TTS) | Google `gemini-2.5-flash-preview-tts` | custom `GeminiTTSProvider(SyncProvider)` — fills the Google-TTS gap in genblaze's provider matrix |
| Storage & provenance | Backblaze B2 | source plans, voice recordings, scene versions, generated audio, and genblaze manifests |

This foundation contains:

- a metric spatial-scene contract with extraction evidence and topology validation
- an agentic extraction loop that cannot ship geometrically broken scenes
- a voice agent that answers wayfinding questions and applies spoken edits,
  gated by the same topology validator
- a Three.js compiler for rooms, doorway openings, landmarks, and accessible routes
- a FastAPI ingestion service with content hashing and review-gated scene persistence
- B2 object storage via both the app's run store and genblaze `ObjectStorageSink`

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

Run the API in a second terminal:

```bash
cd backend
uv sync --extra dev          # or: python -m venv .venv && pip install -e ".[dev]"
uv run uvicorn spatialize_api.app:app --reload --port 8787
```

Local development writes artifacts beneath `backend/.local-data`. Copy
`.env.example` to `.env` and select `SPATIALIZE_STORAGE_BACKEND=b2` to use a
bucket-scoped Backblaze application key.

Provider keys (all optional — every capability degrades gracefully when unset):

```
GEMINI_API_KEY=        # extraction, voice agent, TTS
ASSEMBLYAI_API_KEY=    # speech-to-text (voice questions; needs b2 storage)
```

Deploy as one container (API + built web app):

```bash
docker build -t spatialize .
docker run -p 8787:8787 --env-file .env spatialize
```

Run both test suites:

```bash
npm test
cd backend && uv run pytest
```

## Architecture

```
plan upload ──► agentic extraction ──► topology gate ──► human review ──► approved scene
                (Gemini vision in a         (Pydantic,                        │
                 genblaze AgentLoop;         doors-on-walls,                  ▼
                 errors fed back as          routes-through-doors)      Three.js twin
                 refinement prompts)                                          │
voice question ──► AssemblyAI STT ──► LangGraph agent ──► Gemini TTS ──► spoken answer
  (B2 + manifest)  (word timings)     (scene-grounded     (genblaze       (+ captions)
                                       tools; edits pass   manifest in
                                       the same gate)      the audio)
```

Every voice edit carries `method: "human"` evidence quoting the transcript, and
every generated artifact lands in B2 with a genblaze provenance manifest.

No live navigation or safety claim is made. Published packages require human approval.
