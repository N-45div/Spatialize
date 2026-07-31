# Devpost submission draft — Spatialize

**Tagline:** Speak to a floor plan — it answers, and it builds itself.

**Try it:** https://spatialize.onrender.com · **Code:** https://github.com/N-45div/Spatialize

## Inspiration

Blind and low-vision visitors often rehearse a route before entering an
unfamiliar building — but venue accessibility data is usually a stale PDF.
We wanted a floor plan you could *talk to*: ask it for a step-free route,
tell it "that door has steps," and trust every answer because nothing in it
is hallucinated.

## What it does

Upload a flat venue plan and Spatialize turns it into an explorable, audible,
voice-editable spatial twin:

- **Agentic extraction** — a vision model proposes `scene.json`; a
  deterministic topology validator (doors on walls, routes through doors,
  distances matching geometry) is the genblaze `AgentLoop`'s Evaluator.
  Validation errors feed the next iteration. Broken scenes cannot ship.
- **Voice conversations** — AssemblyAI transcribes your question, a LangGraph
  agent answers using tools that compute over validated geometry only, and the
  reply comes back as generated speech with follow-up memory.
- **Spoken edits** — "Mark the gallery door as not accessible" mutates the 3D
  scene through the same topology gate, and the venue warns you out loud when
  a destination loses its last step-free route.
- **Provenance everywhere** — every plan, transcript, scene version, and voice
  answer lands in Backblaze B2 with a SHA-256 genblaze manifest. Voice edits
  carry `method: "human"` evidence quoting the transcript.

## How we built it (Genblaze + B2)

- **genblaze `AgentLoop`** drives extraction with a *deterministic* evaluator —
  the loop's lineage (`parent_run_id`) records every refinement attempt.
- **genblaze pipelines** run AssemblyAI STT (word-level timings) and a
  three-tier TTS failover we orchestrated through custom `SyncProvider`s:
  Gemini TTS → Sarvam Bulbul v3 → self-hosted Kokoro-82M (open source).
  Two of those providers don't exist in genblaze's matrix — we wrote them.
- **Backblaze B2** stores sources, per-visitor demo scenes, scene versions,
  voice questions, generated narration (via `ObjectStorageSink` +
  `S3StorageBackend.for_backblaze`), and manifests — served with presigned URLs.
- FastAPI + LangGraph backend, React + Three.js front end, one Docker
  container deployed on Render.

## AI providers and models

| Capability | Provider / model |
|---|---|
| Vision extraction + agent | OpenRouter `google/gemini-3.6-flash` (Gemini API fallback) |
| Speech-to-text | AssemblyAI `universal-3-5-pro` |
| Narration (primary) | Google `gemini-2.5-flash-preview-tts` |
| Narration (fallback) | Sarvam `bulbul:v3` |
| Narration (open source) | Kokoro-82M int8, self-hosted |

## Challenges

Free-tier reality: quota ceilings, a 512MB container, browser autoplay
policies, and private-bucket URLs each broke the voice loop in a different way.
The fixes — provider failover, event-loop hygiene, presigned sink URLs,
gesture-primed audio — are what made it production-honest rather than demo-ware.

## What's next

Streaming STT for live transcription, multi-floor venues, and an eve-style
conversational channel layer — the genblaze service stays exactly as built.

## Honesty

Rehearsal guidance only — no live-navigation or safety claims. Publishing is
human-approved, always.
