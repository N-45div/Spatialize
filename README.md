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
**WebMCP agent surface:** [WEBMCP.md](WEBMCP.md)

## Agent-native: fourteen WebMCP tools

> Built for the **OpenAI WebMCP Challenge**. Everything in `src/webmcp/` is new
> work added after 25 August 2026; prior work ends at commit `04e9ad8`
> (3 Aug 2026). Full breakdown in [WEBMCP.md](WEBMCP.md).

This venue publishes itself to any agent in the browser via
`document.modelContext`. Open the app in the ChatGPT app browser, or Chrome 149+
with `chrome://flags/#enable-webmcp-testing`, and your agent can:

- **Ask the building questions it can actually answer.** `find_step_free_route`
  runs Dijkstra over the validated route graph, so a step-free route is
  *computed*, never estimated. No venue can answer "can I reach the quiet room
  without stairs?" today — Google Maps knows about entrances, not topology.
- **Be told *why* you can't get somewhere.** When no step-free route exists the
  tool names the exact door that blocks it, with its clear width, instead of
  returning nothing.
- **Fix the building's data by talking — and be refused when wrong.** Four
  `propose_*` tools let a visitor report what they found on the ground. Every one
  runs through the same deterministic topology validator that guards the rest of
  the app, then waits for a person on the venue team. An impossible change comes
  back with the exact rule and field path, so the agent can self-correct.
- **Disagree with the building, on the record.** A venue can decline a visitor's
  report. It cannot delete one. Declined reports stay as disputed claims and
  `list_disputed_claims` tells any agent both sides, because the venue is the
  least reliable source on its own accessibility.

| reads | proposes (checked, then reviewed by a person) |
|---|---|
| `get_venue_overview` · `list_destinations` · `find_step_free_route` · `describe_room` · `check_accessibility` · `list_data_issues` · `list_disputed_claims` · `check_route_clearance` · `simulate_closure` · `focus_view` | `propose_access_change` · `propose_doorway` · `propose_landmark` · `propose_label_correction` |

The agent dock inside the 3D viewport shows registration state, a live feed of
tool calls, the approval queue with each change's real-world impact, and gate
refusals with their violations — plus the full published tool contract, so the
surface can be read without opening the source.

**Why it matters:** detailed venue accessibility data is sold today by human
surveyors (AccessAble: ~70,000 venues, 30–60 min call each; standalone audits
£3,000–£6,000), and it rots because updating it means filling in a form. WebMCP
turns the update into a sentence spoken at the door — and the validator means
quality goes up rather than down. See
[WEBMCP.md](WEBMCP.md#why-this-problem-and-for-whom).

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
npm test                            # 100 frontend tests (92 added for WebMCP; includes e2e + evals)
cd backend && .venv/Scripts/python -m pytest    # 38 API/agent/gate/review tests (19 added)
npm run evals                       # journey + model tool-selection evals, see EVALS.md
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
- Agent writes are proposals, never edits: they clear the topology gate *and* a
  human before anything changes. Every proposal, decision and tool call is
  written to the run's review ledger in the same store that holds scene
  versions, so a refresh or a second device sees the same record. The server
  re-validates every candidate scene itself and computes the accessibility
  impact from its own copy; the browser's gate is fast feedback, not the
  boundary.
- The gate checks that a change is consistent with the plan. It cannot check
  whether a report is true of the building — only a person can, and the tools
  say so in their own output rather than letting an agent assume otherwise.
- A venue can decline a report but cannot delete it. Declined reports stay on
  the record as disputed claims, because venue-published access information is
  the least reliable source in the published survey data (77% of disabled
  respondents found it misleading, Euan's Guide 2024, n=6,665).
