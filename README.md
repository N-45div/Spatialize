# Spatialize

**A building that answers from its geometry and its evidence, and says so when it doesn't know.**

Spatialize turns a flat floor plan into a validated 3D spatial twin. On top of that twin it checks a route
against **one person's clear width**, keeps every access claim **sourced and reviewable in Sanity**, and lets
agents ask questions and propose changes. Agents work through fourteen WebMCP tools in the browser, an evidence
agent that reads a Sanity Context Knowledge Base, and a voice assistant. None of them can publish anything:
every change is checked by a deterministic gate and decided by a person, and every verdict is computed, never
written by a model.

**Live app:** https://spatialize-pink.vercel.app/#studio
**API:** https://spatialize.onrender.com (free instance; the first request after an idle spell wakes it, which
takes a few seconds)
**Docs:** [ACCESS_DESK.md](ACCESS_DESK.md) (evidence, Sanity, the evidence agent) ·
[WEBMCP.md](WEBMCP.md) (the agent surface) · [EVALS.md](EVALS.md) (every claim, measured) ·
[ARCHITECTURE.md](ARCHITECTURE.md)

The demo venue, Harbor Arts Centre, is fictional, and its reports and obstacles are labelled synthetic fixtures.

---

## Try it in two minutes

**In any browser: the Access Desk.** Open the live app and use the panel on the right.

1. **Learning studio at 800 mm: CLEAR.** Change the width to 1300 mm and it turns **BLOCKED**: the studio
   doorway is 1200 mm, and the 3D twin rings it.
2. **Gallery one: BLOCKED**, because a trolley stands in the route corridor. Open *Rehearse an obstacle move*
   and preview it at X 13.5, Z 5.3. The preview shows every room's verdict before and after (Gallery goes
   BLOCKED → CLEAR) and publishes nothing. Submit it, approve it with a reason, and the layout moves to
   access version 2, which survives a reload.
3. **Quiet room, with the Evidence agent on: "Is the quiet room step-free?"** The verdict, **UNKNOWN**,
   appears at once. Then the agent reads the Knowledge Base and sets the venue guide ("step-free") beside
   the disputed visitor report ("raised threshold") with their dates. Open **Context retrieval record** to
   see each MCP call it made and what came back.

**With a WebMCP agent.** Open the app in the ChatGPT app browser, or in Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` on. The agent dock reads **"14 tools live"** when registration
worked. Then say:

1. *"Is the quiet room step-free from the main entrance?"* The agent gets a turn-by-turn route **computed by
   Dijkstra over validated geometry**, with door widths, and the 3D view moves to it.
2. *"My chair is 760 mm wide. Can I get to the quiet room?"* The answer is **UNKNOWN**, not clear, because
   one doorway was extracted at 75% confidence, and it says how old the data is.
3. *"The quiet-room doorway has a step now, report it."* The server applies the change to **its own** copy,
   prices it (*"removes step-free access to Quiet room"*), and a card lands in the review queue. Nothing is
   live until a person approves it.
4. *"Add a doorway between the main lobby and the quiet room."* The topology gate **refuses** it, with the
   exact rule and field path, so the agent can correct itself.
5. Click **Reject** on the report, then refresh. The dispute is still there: a venue can decline a report,
   not delete it, and the next agent to ask hears both sides.

Without a WebMCP browser the page works fully as a human app.

## Evidence lives in Sanity

Access evidence is modelled as data, not pages, in Sanity project **`tubqyqod`**. The `production` dataset is
**public**, so you can
[query it directly](https://tubqyqod.api.sanity.io/v2026-09-01/data/query/production?query=*%5B_type%3D%3D%22accessClaim%22%5D%7Bproperty%2CstepFree%2CwidthMm%2Cstatus%2C%22about%22%3Aentity-%3Etitle%2C%22source%22%3Asource-%3Etitle%7D),
and it is edited in a hosted Studio at https://spatialize-tubqyqod.sanity.studio/.

- **Sources** say who reported something, and when. **Claims** state one fact about one door or room
  (`step-free`, or a clear width in millimetres), cite one source, and carry a review status: `verified`,
  `unverified` or `disputed`. **Notices** are closures with a start and an end. **Obstacles** are footprints
  in metres.
- The route check reads them live on every request. A verified closure blocks; an unverified one makes the
  answer UNKNOWN; an expired one is ignored. Disagreeing sources both stay on record.
- Published obstacle layouts and every review decision, approved or declined, are kept in a read-only,
  versioned publication document. Writes are guarded by a revision check, so two reviewers cannot both
  publish over the same version.

**The evidence agent** reads a **Sanity Context Knowledge Base** built from those documents by a GROQ
projection ([`sanity/knowledge-base.groq`](sanity/knowledge-base.groq)) that joins each source to the claims,
notices and obstacles citing it, with their status. Visitor-submitted review records are left out, so nothing
typed into the public app reaches the agent. The agent uses the Knowledge Base MCP endpoint (`initial_context`,
then `knowledge_base_read`) through the OpenAI Responses API. It explains the evidence and its disagreements;
the computed verdict is handed to it as authoritative, and it cannot change it.

When the Knowledge Base was first built, Sanity Context flagged the quiet-room conflict on its own. It stays
open by design: a standing Knowledge Base instruction keeps both claims side by side with their source, date
and status. Details, setup and the rebuild script are in [ACCESS_DESK.md](ACCESS_DESK.md).

## Nothing an agent says goes live

1. **The topology gate.** A deterministic validator (Zod in the browser for fast feedback, Pydantic on the
   server as the boundary) checks every proposal for internal consistency: a doorway must sit on the boundary
   of both rooms it joins, and a landmark must be inside the building. Refusals carry field paths, so agents
   self-correct.
2. **The server applies mutations itself.** A proposal is a few fields, not a scene. The backend applies it
   to *its own* copy of the venue, re-validates it, and computes the accessibility impact from that. A
   "rename this room" cannot also widen a door.
3. **A person decides.** Geometry proposals and obstacle moves wait in review records that survive a refresh
   or a second device. Obstacle moves are previewed and re-validated against the current scene and access
   versions before approval. Declining keeps a report as a dispute, forever.
4. **Verdicts are computed.** CLEAR, BLOCKED and UNKNOWN come from geometry and structured evidence. Model
   prose is shown separately and never replaces them.

## What a WebMCP agent can do

| Group | Tools |
|---|---|
| **Ask** | `get_venue_overview` · `list_destinations` · `describe_room` · `list_data_issues` · `list_disputed_claims` |
| **Check** | `find_step_free_route` · `check_route_clearance` · `check_accessibility` |
| **Propose** (gated, then reviewed by a person) | `propose_access_change` · `propose_doorway` · `propose_landmark` · `propose_label_correction` |
| **What-if & page** | `simulate_closure` · `focus_view` |

- **Questions only geometry can answer.** `find_step_free_route` computes a step-free route over the validated
  route graph. When none exists, it names the exact door that blocks it, with its clear width.
- **One person, not a generic label.** `check_route_clearance` takes the narrowest doorway *that person* can
  pass, in millimetres, and answers UNKNOWN rather than CLEAR whenever a doorway on the route is
  low-confidence or disputed.
- **Disagreement on the record.** `list_disputed_claims` tells any agent both sides, because venue-published
  access information is often wrong: 77% of disabled respondents found it misleading (Euan's Guide 2024,
  n=6,665).
- **Rehearse a closure.** `simulate_closure` answers which destinations lose step-free access if a doorway or
  lift goes out of use, and changes nothing.

Tools register per venue on `document.modelContext` and follow Chrome's published WebMCP
[best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices),
[tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools) and
[agent security](https://developer.chrome.com/docs/agents/security) guidance. Tests hold every result inside the
1.5K budget on a venue far larger than the demo. Full design notes are in [WEBMCP.md](WEBMCP.md).

## Speak instead of type

With `OPENAI_API_KEY` set, the voice path is a `gpt-5.6-luna` function-calling loop over the same scene tools,
with `gpt-4o-mini-transcribe` for speech and `gpt-4o-mini-tts` for the spoken answer, for about **0.6¢ per
question**. A spoken *"mark the gallery door inaccessible"* files a proposal through the same review records as
a WebMCP agent, with the spoken sentence as its provenance.

## Proof, with numbers

- **109 frontend tests, 65 backend tests and 5 Chrome journeys.** The journeys run against isolated local
  servers with external providers switched off, and cover clearance, conflicting evidence, reviewed moves that
  persist, invalid placements and the evidence agent's retrieval record.
- **Eight deterministic agent journeys**: twelve tool calls, zero unauthorised scene mutations, and every
  result inside Chrome's 1.5K budget.
- **Tool selection by a real model**: given only the published contract, `gemini-3.6-flash` chose the right
  tool for **20 of 20** requests, with the right arguments in **12 of 12**.
- **A real WebMCP host against the deployed app**: `npm run host-check` drives the journey through Chrome's own
  WebMCP surface. It passed **13 of 13** on Chrome 152.
- **Live Sanity and Context**: `scripts/verify-live.py` runs the Access Desk journey against the real project
  and Knowledge Base endpoint and records the result in
  [`sanity-live-verification.json`](sanity-live-verification.json), including the agent's actual
  `knowledge_base_read` call.

Full tables are in [EVALS.md](EVALS.md).

## How it's built

React 19 + Three.js studio · FastAPI backend · Sanity Content Lake, Studio and Context · Backblaze B2 object
store (plans, recordings, scene versions, review records, manifests) · genblaze pipelines with SHA-256
manifests for provenance.

| Capability | Provider |
|---|---|
| Access evidence and review publication | Sanity Content Lake, queried with GROQ; standalone Studio in [`sanity/`](sanity) |
| Evidence agent | OpenAI Responses API with the Sanity Context Knowledge Base MCP endpoint |
| Voice agent, speech-to-text, text-to-speech | OpenAI: `gpt-5.6-luna`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-tts` |
| Floor-plan extraction | Gemini vision inside genblaze's `AgentLoop` (generate, validate, refine), with the topology gate as evaluator |
| Voice fallback (no OpenAI key) | AssemblyAI speech-to-text · LangGraph + Gemini agent · Gemini text-to-speech |
| Storage and provenance | Backblaze B2 via the run store and genblaze's `ObjectStorageSink` |

Every provider is optional. Without Sanity the Access Desk runs on labelled local fixtures, and without a
model key the evidence agent is simply off.

## Run locally

Requirements: Node 22+, Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
npm ci
uv sync --project backend --extra dev
npm run dev:access          # web app on http://localhost:4174/#studio, API on :8788
```

Copy `.env.example` to `.env` at the repository root. Everything is optional:

```
SANITY_PROJECT_ID / SANITY_DATASET / SANITY_API_TOKEN   # evidence in Sanity (fixtures without)
SANITY_CONTEXT_URL / SANITY_CONTEXT_TOKEN               # evidence agent: Knowledge Base MCP + org token
OPENAI_API_KEY                                          # evidence agent and voice
B2_KEY_ID / B2_APP_KEY / B2_BUCKET / B2_REGION          # storage (local fallback without)
OPENROUTER_API_KEY                                      # extraction + tool-selection eval
GEMINI_API_KEY / ASSEMBLYAI_API_KEY                     # voice fallbacks
SPATIALIZE_VENUE_TOKEN                                  # reviewer role (open demo if unset)
SPATIALIZE_ALLOWED_ORIGINS                              # CORS ("*" for development)
```

Tokens stay on the server; nothing with a `VITE_` prefix holds a secret. The Sanity Studio runs with
`npm run dev:studio`, and [ACCESS_DESK.md](ACCESS_DESK.md) covers seeding, the schema and building the
Knowledge Base.

### Tests

```bash
npm test                    # frontend unit, journey and e2e suites
npm run lint && npm run build
npm run test:browser        # Chrome journeys against isolated local servers
uv run --project backend --extra dev pytest backend/tests -q
npm run evals               # model tool-selection evals (paid, network)
npm run host-check          # the journey through Chrome's own WebMCP host
python scripts/verify-live.py   # the Access Desk against live Sanity + Context
```

## Deploy

One container serves the API and the built web app:

```bash
docker build -t spatialize .
docker run -p 8787:8787 --env-file .env spatialize
```

The repo ships a [render.yaml](render.yaml) blueprint, including the Sanity settings, and a keepalive GitHub
Action that pings `/health` so a free instance stays warm.

## Honesty box

- This is **rehearsal** guidance, not live navigation, and no safety claim is made.
- **CLEAR is a screening result, not an accessibility certificate.** The check covers the stored route's
  corridor and doorway widths. Turning space, slope, headroom, thresholds and unrecorded obstacles are not in
  the data, and the answer says so.
- Widths come from the floor plan, checked for consistency, not measured on site. The gate checks that a
  change is consistent with the plan; only a person can check that it is true of the building.
- The evidence agent's text is a research note. It can be wrong; the verdict beside it is the computed one.
- Review records are serialised per run *within one server process*, which suits the single-instance
  deployment this is. Sanity publication adds a revision check but no distributed transaction with object
  storage.
- The venue role is a shared token in a header, not accounts. It is unset in the open demo, so anyone can
  play reviewer there.
- Multi-page PDFs use page 1 only. WebMCP is an origin trial (Chrome 149–156); outside a WebMCP browser the
  page works fully as a human app.

## Licence

MIT. See [LICENSE](LICENSE).
