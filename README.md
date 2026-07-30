# Spatialize

**Speak to a floor plan — it answers, and it builds itself.**

Spatialize turns a flat venue plan into an explorable, audible, *editable*
spatial twin. Ask it questions with your voice and hear grounded, step-free
route guidance. Tell it about the world ("the gallery door has steps") and the
3D scene updates itself — but only if the change survives a machine-checked
topology gate. Every word and every vertex is provenance-stamped in Backblaze B2.

Built for the **Backblaze Generative Media Hackathon** with
[Genblaze](https://github.com/backblaze-labs/genblaze) + B2.

**Live app:** https://spatialize.onrender.com
**Architecture deep-dive:** [ARCHITECTURE.md](ARCHITECTURE.md)

## Why this matters

Blind and low-vision visitors rehearse routes before entering an unfamiliar
building. Venue teams keep accessibility data alive by *talking* to the plan.
Nothing is hallucinated: the agent can only phrase what validated geometry
computes, and no scene ships without passing the same gate plus human review.

## AI providers and models

| Capability | Provider / model | How it is used |
|---|---|---|
| Floor-plan extraction | OpenRouter `google/gemini-3.6-flash` (or Gemini API) | genblaze **`AgentLoop`**: a vision step proposes `scene.json`; the Pydantic topology gate is the loop's **Evaluator**; validation errors feed the next iteration; every attempt is `parent_run_id`-linked |
| Voice questions (STT) | AssemblyAI `universal-3-5-pro` | `genblaze-assemblyai` pipeline step — hash-verified transcript with word-level timings |
| Agent reasoning | OpenRouter `google/gemini-3.6-flash` (or Gemini API) | LangGraph ReAct agent over scene-grounded tools; reads answer from validated geometry; writes pass the same topology gate |
| Narrated answers (TTS) | Google `gemini-2.5-flash-preview-tts` | custom **`GeminiTTSProvider(SyncProvider)`** — fills the Google-TTS gap in genblaze's provider matrix |
| Storage & provenance | **Backblaze B2** | source plans, voice recordings, scene versions, generated audio, genblaze manifests — via the app's run store *and* genblaze `ObjectStorageSink` |

## How B2 and Genblaze are used (the short version)

- **Genblaze pipelines** run speech-to-text, narration synthesis, and the
  agentic extraction loop. Each run yields a SHA-256 canonical **manifest**;
  the API returns manifest hashes with every transcript and every audio answer.
- **Genblaze `AgentLoop`** is the heart of extraction: generate → validate →
  refine, with lineage. The evaluator is not an LLM judge — it is a
  deterministic geometric validator, so a broken scene *cannot* pass.
- **B2 holds everything**: hashed source plans, per-run records, every scene
  version (voice edits create parent-linked versions), voice question
  recordings, and generated narration (uploaded through genblaze's
  `S3StorageBackend.for_backblaze` sink, served via presigned URLs).

## Run locally

```bash
npm install && npm run dev          # web app on http://localhost:4173
```

API in a second terminal:

```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"   # or: uv sync --extra dev
.venv/Scripts/python -m uvicorn spatialize_api.app:app --reload --port 8787
```

Copy `.env.example` to `.env`. Every provider key is optional — each
capability degrades gracefully when its key is missing:

```
B2_KEY_ID / B2_APP_KEY / B2_BUCKET / B2_REGION   # storage (local fallback without)
OPENROUTER_API_KEY                               # agent + vision extraction
GEMINI_API_KEY                                   # TTS (and agent/vision fallback)
ASSEMBLYAI_API_KEY                               # speech-to-text (needs B2 mode)
```

Tests:

```bash
npm test                            # 8 frontend tests
cd backend && .venv/Scripts/python -m pytest    # 17 API/agent/gate tests
```

## Deploy

One container serves the API and the built web app:

```bash
docker build -t spatialize .
docker run -p 8787:8787 --env-file .env spatialize
```

The repo ships a [render.yaml](render.yaml) blueprint (the live deployment) and
a keepalive GitHub Action that pings `/health` so the free instance stays warm.

## Honesty box

- No live-navigation or safety claim is made — this is **rehearsal** guidance.
- Nothing publishes without passing schema + topology validation **and** human
  review; voice edits always re-flag the scene as `needs-review`.
- Multi-page PDFs use page 1 only, and conversations are single-turn today.
