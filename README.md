# Spatialize

**A building that answers your agent from geometry — and refuses it when it's wrong.**

Spatialize turns a flat floor plan into a validated 3D spatial twin, then
publishes that twin to any agent in the browser as **fourteen WebMCP tools** on
`document.modelContext`. An agent can ask the building questions no venue can
answer today, check a route against one specific person's needs, and fix the
building's data by talking — but nothing an agent says goes live. Every write
is a proposal: checked by a deterministic topology gate, priced in real-world
impact, decided by a person, and kept on the record even when the venue says no.

Built for the **OpenAI WebMCP Challenge**.

**Live app:** https://spatialize.onrender.com — open `#studio`
**The agent surface, in depth:** [WEBMCP.md](WEBMCP.md)
**Every claim, measured:** [EVALS.md](EVALS.md)
**System architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Try it in two minutes

Open the live app in the **ChatGPT app browser**, or in **Chrome 149+** with
`chrome://flags/#enable-webmcp-testing` switched on. The agent dock in the
bottom-right of the studio reads **"14 tools live"** when registration worked
(Google's *WebMCP Inspector* extension shows the same list).

Then say these to your agent, in order — each shows a different thing:

1. *"Is the quiet room step-free from the main entrance?"* — a turn-by-turn
   route **computed by Dijkstra over validated geometry**, with door widths.
   The 3D view moves to what the agent found.
2. *"My chair is 760 mm wide. Can I get to the quiet room?"* — a clearance
   verdict for that person. It answers **UNKNOWN**, not clear, because one
   doorway was extracted at 78% confidence — and it says how old the data is.
3. *"The quiet-room doorway has a step now, report it."* — the server applies
   the change to **its own** copy, computes what it costs (*"removes step-free
   access to Quiet room"*), and a card lands in the review queue on screen.
   Nothing is live until a person approves it.
4. *"Add a doorway between the main lobby and the quiet room."* — the topology
   gate **refuses** it, with the exact rule and field path, so the agent can
   self-correct instead of corrupting the venue.
5. Click **Reject** on the report in the dock, then **refresh the page**. The
   dispute is still there — a venue can decline a report, not delete it — and
   *"has anyone disagreed with the venue about access here?"* tells the next
   agent both sides.

Without a WebMCP browser the page still works fully as a human app, and the
dock explains how to enable the tools.

## What an agent can do here

- **Ask questions only geometry can answer.** `find_step_free_route` runs
  Dijkstra over the validated route graph — a step-free route is *computed*,
  never estimated. Google Maps knows whether a building has an accessible
  entrance; it does not know the topology inside.
- **Hear *why*, not just *no*.** When no step-free route exists, the tool
  re-runs against the unrestricted graph and names the exact door that blocks
  it, with its clear width.
- **Check a route against one person, not a generic label.**
  `check_route_clearance` takes the narrowest doorway *that person* can pass,
  in millimetres, and answers CLEAR, BLOCKED or UNKNOWN — saying *unknown*
  rather than *clear* whenever a doorway on the route is low-confidence or
  disputed. Measurements, not verdicts: the threshold belongs to the person.
- **Fix the building by talking — and be refused when wrong.** Four
  `propose_*` tools file visitor reports through the same deterministic
  validator that guards the rest of the app, then wait for a person. An
  impossible change comes back with the rule and field path that killed it.
- **Disagree with the building, on the record.** A venue can decline a report;
  it cannot delete one. Declined reports stay as disputed claims, and
  `list_disputed_claims` tells any agent both sides — because venue-published
  access information is the least reliable source there is (77% of disabled
  respondents found it misleading — Euan's Guide 2024, n=6,665).
- **Rehearse a closure before it happens.** `simulate_closure` answers which
  destinations lose step-free access if a doorway or lift goes out of use —
  the question an access manager faces before every works notice — and
  changes nothing.

## The fourteen tools

| Group | Tools |
|---|---|
| **Ask** | `get_venue_overview` · `list_destinations` · `describe_room` · `list_data_issues` · `list_disputed_claims` |
| **Check** | `find_step_free_route` · `check_route_clearance` · `check_accessibility` |
| **Propose** (gated, then reviewed by a person) | `propose_access_change` · `propose_doorway` · `propose_landmark` · `propose_label_correction` |
| **What-if & page** | `simulate_closure` · `focus_view` |

Tools are a **function of page state**, not a static list: they register per
venue on `document.modelContext` tied to an `AbortController`, and the four
`propose_*` tools are only offered when there is a venue record to propose
against. Every read carries `readOnlyHint`; results use canonical MCP content
form; the dock publishes the full typed contract on screen, so the surface can
be read without opening the source. The surface is built against Chrome's
published guidance — [best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices),
[tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools) and
[agent security](https://developer.chrome.com/docs/agents/security) — and a
test suite holds it there: every result inside the 1.5K budget on a venue far
larger than the demo, every parameter description inside 150 characters, and no
tool that accepts raw coordinates. Full design notes in [WEBMCP.md](WEBMCP.md).

## Nothing an agent says goes live

Three layers stand between an agent and the venue record:

1. **The topology gate.** A deterministic validator (Zod in the browser for
   fast feedback, Pydantic on the server as the boundary) checks every proposal
   for internal consistency — a doorway must sit on the boundary of both rooms
   it joins, a landmark must be inside the building. Refusals carry field
   paths, so agents self-correct.
2. **The server applies mutations itself.** A proposal is five fields, not a
   scene. The backend applies it to *its own* copy of the venue, re-validates,
   and computes the accessibility impact from that — so a "rename this room"
   cannot also widen a door. It never accepts a scene the client built.
3. **A person decides.** Proposals wait in a review ledger persisted in the
   same object store as the scene versions — a refresh or a second device
   hydrates the same record. Approval writes a new scene version through the
   same path as every other change and drops the venue back to needs-review.
   Declining keeps the report as a dispute, forever.

## Proof, with numbers

All of it runs with `npm test`; full tables in [EVALS.md](EVALS.md).

- **Eight deterministic journeys** — twelve tool calls, zero unauthorised
  scene mutations, every result inside Chrome's 1.5K budget. Six of the eight
  are not possible through the page's UI at all.
- **Tool selection by a real model** — given only the published contract,
  `gemini-3.6-flash` chose the right tool for **20 of 20** things a person
  might say, with the right arguments in **12 of 12** where one was implied.
- **End to end through the real backend** — spawned FastAPI, real store: ask,
  report, refuse, decline, wipe the tab, hydrate, and the next agent hears
  both sides. About five seconds per run.
- **Through a real WebMCP host** — `npm run host-check` drives the same
  journey through Chrome's own `navigator.modelContextTesting.executeTool`
  against the production bundle: **13 of 13** on Chrome 151. The first run was
  8 of 13 and caught a real hydration race, since fixed and pinned by tests.

## Prior work vs. new work

Spatialize existed before this challenge. It was built for the **Backblaze
Generative Media Hackathon**, where it earned a **special mention** — that
prior project is the spatial canvas, the plan extraction loop, the voice
pipeline, and the B2 provenance store, and **its last commit before the WebMCP
Submission Period was `04e9ad8`, 3 August 2026**.

The challenge rules allow an existing app when significant new WebMCP
functionality is added during the Submission Period, so this submission is
everything after that commit: the entire WebMCP surface (`src/webmcp/`), the
server-side review ledger, the OpenAI voice stack, and the 121 tests added
with them. The commit-by-commit boundary is documented in
[WEBMCP.md](WEBMCP.md#prior-work-vs-work-added-during-the-submission-period).

## Speak instead of type — the same rules apply

The voice path runs on the **OpenAI SDK** when `OPENAI_API_KEY` is set:
a `gpt-5.6-luna` function-calling loop over the same scene tools,
`gpt-4o-mini-transcribe` for speech (from the clip's bytes, so voice works
without B2), and `gpt-4o-mini-tts` for the narrated answer — about **0.6¢ per
spoken question**. A spoken *"mark the gallery door inaccessible"* files a
proposal through the **same review ledger** as a WebMCP agent, with the spoken
sentence as its provenance, and waits for the same human decision. Nothing —
typed, spoken, or agent-made — writes to the venue directly.

## How it's built

React 19 + Three.js studio · FastAPI backend · Backblaze B2 object store
(plans, recordings, scene versions, review ledgers, manifests) · genblaze
pipelines with SHA-256 manifests for provenance.

| Capability | Provider |
|---|---|
| Voice agent + STT + TTS (`OPENAI_API_KEY` set) | OpenAI — `gpt-5.6-luna`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts` |
| Floor-plan extraction | Gemini vision inside genblaze's `AgentLoop` — generate → validate → refine, with the deterministic topology gate as the loop's evaluator |
| Voice fallback (no OpenAI key) | AssemblyAI STT · LangGraph + Gemini agent · Gemini TTS |
| Storage & provenance | Backblaze B2 via the run store and genblaze's `ObjectStorageSink` |

Every provider key is optional; each capability degrades gracefully without it.

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

Copy `.env.example` to `.env`:

```
OPENAI_API_KEY                                   # voice: agent + STT + TTS
B2_KEY_ID / B2_APP_KEY / B2_BUCKET / B2_REGION   # storage (local fallback without)
OPENROUTER_API_KEY                               # extraction + tool-selection eval
GEMINI_API_KEY / ASSEMBLYAI_API_KEY              # voice fallbacks
SPATIALIZE_VENUE_TOKEN                           # reviewer role (open demo if unset)
SPATIALIZE_ALLOWED_ORIGINS                       # CORS ("*" for development)
```

### Tests

```bash
npm test                # 110 frontend tests, including the e2e and eval suites
cd backend && .venv/Scripts/python -m pytest    # 52 API / gate / review / voice tests
npm run evals           # journey + model tool-selection evals — EVALS.md
npm run host-check      # the journey driven by Chrome's own WebMCP host
```

## Deploy

One container serves the API and the built web app:

```bash
docker build -t spatialize .
docker run -p 8787:8787 --env-file .env spatialize
```

The repo ships a [render.yaml](render.yaml) blueprint and a keepalive GitHub
Action that pings `/health` so a free instance stays warm.

## Honesty box

- This is **rehearsal** guidance, not live navigation; no safety claim is made.
- The gate checks that a change is *consistent with the plan*. It cannot check
  whether a report is true of the building — only a person can — and the tools
  say so in their own output rather than letting an agent assume otherwise.
- Widths come from the floor plan, checked for consistency, not measured on
  site. Turning space, thresholds and gradients are not in the data, so
  clearance checks say exactly that.
- The review ledger is serialised behind a per-run lock *within one server
  process* — fine for the single-instance deployment this is.
- The venue role is a shared token in a header, not accounts; unset for the
  open demo, so anyone can play reviewer there.
- Multi-page PDFs use page 1 only. WebMCP is an origin trial (Chrome 149–156);
  outside a WebMCP browser the page works fully as a human app.

## Licence

MIT — see [LICENSE](LICENSE).
