# Spatialize × WebMCP

**A building that answers your agent from geometry, and refuses it when it's wrong.**

Spatialize publishes a venue's floor plan to any agent in the browser as fourteen
WebMCP tools. Read tools answer from geometry, so a step-free route is *computed*,
never estimated, and every doorway width is reported so the person applies their own
threshold rather than ours. Write tools cannot touch the scene: a proposed change is
checked against the plan's own topology rules and then waits for a person. If the
venue declines it, the report is kept as a disputed claim rather than deleted.

**Live app:** https://spatialize.onrender.com — open `#studio`
**Requires:** the ChatGPT app browser, or Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled.

---

## Prior work vs. work added during the Submission Period

Spatialize existed before this challenge. It was built for the Backblaze
Generative Media Hackathon, where it earned a **special mention**, and **its
last commit before the WebMCP Submission Period opened was `04e9ad8`, dated
3 August 2026.** The challenge rules allow submitting an existing app when
significant new WebMCP-related functionality is added during the Submission
Period; the WebMCP surface described in this document is that new
functionality, and this section marks the boundary so nothing prior is passed
off as challenge work.

The Submission Period opened 25 August 2026. **Everything after `04e9ad8` is new
work, and the entire WebMCP surface lives in files that did not exist before
it.** The seven commits below laid the layers in order; the commits after them
are the persistence, clearance and review-fix work described further down.

```
91316aa  feat(webmcp): make the agent surface legible, and stop asking the model to do arithmetic
d1a7ed9  feat(webmcp): show the agent working, and put a person in front of every write
19a2e5d  feat(webmcp): register the venue tool surface
4653423  feat(webmcp): gate every agent write through the topology validator
b571a4c  fix(scene): reject landmarks outside the building footprint
fe62ae0  feat(webmcp): compute routes and accessibility from validated geometry
3fa62f9  chore(webmcp): type the WebMCP browser API
----------------------------------------------------------------------
04e9ad8  ← everything at or below this commit is prior work (3 Aug 2026)
```

`git log --oneline 04e9ad8..HEAD` lists every commit added since the period
opened, these seven first. Each of the seven builds, typechecks and passes its
tests in isolation.

### What is new

| Added | File | Why it exists |
|---|---|---|
| WebMCP browser typings | `src/webmcp/types.ts` | WebMCP ships no TypeScript definitions yet |
| Route & accessibility engine | `src/webmcp/queries.ts` | Pathfinding, blocker detection, step-free audit, room geometry |
| The agent write gate | `src/webmcp/gate.ts` | Validates proposals, diffs their real-world impact |
| Tool surface (14 tools) | `src/webmcp/tools.ts` | The published contract |
| Registration hook | `src/webmcp/useWebMCP.ts` | Registers per venue, tears down via `AbortSignal` |
| Agent session store | `src/webmcp/session.ts` | Tool-call log, approval queue, refusals |
| Agent dock UI | `src/components/AgentPanel.tsx` | Watch the agent work, approve or reject its changes |
| Landmark bounds rule | `src/domain/spatial-scene.ts` | A validator hole this work exposed (see below) |
| Review ledger (server) | `backend/spatialize_api/review.py` | Proposals, decisions and audit persisted; the gate that counts |
| Review sync (client) | `src/webmcp/session.ts`, `src/lib/api.ts` | Hydrate from the ledger, post proposals, decide through the server |
| 135 new tests | `tests/webmcp-*.test.ts` (98), `tests/e2e` (1), `tests/evals` (2), `spatial-scene.test.ts` (1), `backend/tests/test_review.py` (21), `backend/tests/test_openai.py` (12) | Both gate paths, every tool, the contract, persistence, the result budget on a large venue, prompt injection through tool output, the whole loop through the real API |

### What is unchanged prior work

The 3D/2D spatial canvas, the floor-plan upload and Gemini vision extraction
loop, the voice question pipeline (AssemblyAI → LangGraph → Gemini TTS), the
Backblaze B2 provenance store, and the Zod/Pydantic scene contract. The WebMCP
layer consumes that contract; it did not change it, apart from the one bounds
rule noted above.

---

## What people and agents can now do together

**1. Ask a building a question it can actually answer.**
No venue on earth can answer *"can I get from the north entrance to the quiet
room without stairs?"* today. Google Maps knows whether a building has a
step-free entrance; it does not know the topology inside. Here the agent calls
`find_step_free_route` and gets a turn-by-turn answer computed by Dijkstra over
a validated route graph — with door names and clear widths.

**2. Be told *why* you can't get somewhere.**
When no step-free route exists, the tool does not return nothing. It re-runs
against the unrestricted graph and names the barrier:

```
There is NO step-free route from the main entrance to Quiet room.
The only available route is 24 m and is blocked by:
"Quiet-room doorway" (door-corridor-quiet) between North corridor and Quiet room.
```

That is the difference between "sorry" and something a person can act on.

**3. Fix the building's data by talking, and have the building refuse you.**
A visitor standing at a door tells their agent *"this has a step now."* The
agent calls `propose_access_change`. The gate validates it, computes what it
costs — *"removes step-free access to Quiet room"* — and queues it for the venue
team. Nothing goes live on the agent's say-so.

And when the agent proposes something impossible, it is told exactly why:

```
The topology gate rejected this change, so the venue data is unchanged.
Proposed: Add step-free doorway "Main lobby to Quiet room" between Main lobby and Quiet room
Rule violations (2):
- doors.4.position: Door is not on the boundary of "lobby"
- doors.4.position: Door is not on the boundary of "quiet"

Fix the specific violation above and call the tool again. The gate is
deterministic — the same input will always be rejected the same way.
```

The agent can self-correct from that. A DOM-scraping agent gets a silent
success and a corrupted building.

**4. Check a route against your own needs, not a generic label.**
`check_route_clearance` takes the narrowest doorway a specific person can pass,
in millimetres, and whether steps rule a route out. It answers `CLEAR`,
`BLOCKED` or `UNKNOWN` — and it says *unknown* rather than *clear* when a
doorway on the route was extracted at low confidence or is the subject of an
unresolved visitor dispute:

```
Verdict: UNKNOWN — the main entrance to Quiet room, 24 m.
Narrowest doorway on the route: Quiet-room doorway at 1100 mm clear.
Unconfirmed measurements: Quiet-room doorway (extracted at 78% confidence).
Widths come from the floor plan, checked for consistency, not measured on site.
Turning space, thresholds and gradients are not in this venue's data, so this
is a doorway-width and steps check only.
```

That last paragraph is deliberate. The scene model does not hold turning
circles, threshold heights or gradients, so the tool does not claim a
wheelchair fits. It claims exactly what the data supports.

**5. Ask what a closure would cost, before it happens.**
`simulate_closure` takes a doorway or a lift and answers which destinations
would stop being reachable without steps — *"If "Elevator" were out of use: 2
destinations would lose step-free access from the main entrance — Elevator,
Quiet room."* No button on any venue site does this. It is the question an
access manager has to answer before every planned works notice, and it changes
nothing: nothing is proposed or recorded.

**6. Know how old the answer is.**
Every clearance check ends with a freshness line: *"Quiet-room doorway: last
confirmed by a visitor today; Gallery threshold: never confirmed by a visitor
since the plan was read 29 days ago."* Accessibility data rots because nobody
says how old it is. Here the age is said out loud, and a report the venue
accepted is the freshest word on the doorways it touched.

## Proof

Three kinds of evidence, all in `tests/` and all run by `npm test`; the
numbers are in [EVALS.md](EVALS.md).

- **Deterministic journeys** — eight things a person wants, twelve tool calls in
  total, zero unauthorised mutations of the scene, every result inside the
  1.5K budget.
- **Tool selection by a model** — `google/gemini-3.6-flash`, given only the
  contract, chose the right tool for **20 of 20** things a person might say and
  the right arguments for **12 of 12** where the prompt implied one.
- **End to end through the real backend** — the backend is spawned, a visitor's
  agent asks and reports, the server applies and stores, the venue declines,
  the tab is wiped and hydrated, and a later agent hears both sides. About five
  seconds, every run.
- **Through a real WebMCP host** — `npm run host-check` launches Chrome with
  the flag on and drives the same journey through the browser's own
  `navigator.modelContextTesting.executeTool`, against the production bundle,
  with a real click on Reject and a real page reload. **13 of 13** on Chrome
  151. The first run was 8 of 13 and found a hydration race; see EVALS.md.

---

## Why WebMCP, and not an API or an MCP server

The fair question is what this does that a backend MCP server could not. An
MCP server acts *for* the agent, somewhere else. WebMCP acts *on the page the
person is looking at*. When the agent proposes that a doorway has a step, the
person watches the card land in the review queue on screen. When it names a
door, the 3D view moves to it. When the venue declines, the dispute is visible
to the visitor and to the next agent in the same place. The venue's session,
the venue's validator and the person's own eyes are in one window, and the
tools are registered and torn down as that window changes. That shared
visibility is the whole point here, and it is the thing an API cannot give.

## The tool surface

Fourteen tools, in four groups. Every read carries `readOnlyHint` and
`untrustedContentHint`; every write is named `propose_*`, because nothing an
agent does goes live by itself.

- **Ask** — `get_venue_overview`, `list_destinations`, `describe_room`, `list_data_issues`, `list_disputed_claims`
- **Check** — `find_step_free_route`, `check_route_clearance`, `check_accessibility`
- **Propose** — `propose_access_change`, `propose_doorway`, `propose_landmark`, `propose_label_correction`
- **What-if and page** — `simulate_closure`, `focus_view`

| Tool | Kind | What it does |
|---|---|---|
| `get_venue_overview` | reads | Footprint, counts, review status, step-free summary |
| `list_destinations` | reads | Routable places with ids and confidence |
| `find_step_free_route` | reads | Turn-by-turn route, or the door that blocks it |
| `describe_room` | reads | Area, category, neighbours, door widths, confidence |
| `check_accessibility` | reads | Whole-venue step-free audit, every doorway width, open disputes |
| `list_data_issues` | reads | Open validator issues and low-confidence extractions |
| `list_disputed_claims` | reads | Reports the venue declined, kept on the record |
| `check_route_clearance` | reads | One route against one person's width and step needs: clear, blocked or unknown, with freshness |
| `simulate_closure` | reads | What-if: a doorway closed or a lift out of use — which destinations lose step-free access |
| `focus_view` | reads | Moves the page's 3D view so a person sees what the agent found |
| `propose_access_change` | proposes | A doorway became blocked, or was cleared |
| `propose_doorway` | proposes | A doorway the plan missed, named by the two rooms it joins |
| `propose_landmark` | proposes | A restroom/lift/destination the plan missed |
| `propose_label_correction` | proposes | The vision model misread a name |

The page publishes this contract to visitors too — the agent dock has a
**"Show the 14 tools this page publishes"** panel listing every tool, its
read/propose kind, and its typed parameters. You can read the surface without
opening the source.

---

## How WebMCP is implemented

Tools are a function of page state, not a static list. They are registered on
`document.modelContext` tied to an `AbortController`, and re-registered when
either of two things changes: the venue on screen, or whether there is a venue
record to propose against. Without a record the four `propose_*` tools are not
offered at all — a proposal with nowhere to be kept would be a lie — and the
dock says so. Each change tears the old set down and fires `toolchange`, so an
idle agent learns the surface moved. See `src/webmcp/useWebMCP.ts`:

```js
document.modelContext.registerTool({
  name: "find_step_free_route",
  description:
    "Compute a route between two places in this venue and report it turn by turn. " +
    "By default it only returns step-free routes suitable for a wheelchair user. If no " +
    "step-free route exists, it names the exact door that blocks it rather than just refusing.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Destination landmark id or label." },
      from: { type: "string", description: "Starting landmark id or label. Defaults to the main entrance." },
      step_free: { type: "boolean", description: "Require a step-free route. Defaults to true." }
    },
    required: ["to"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  execute: async (input) => { /* Dijkstra over the validated route graph */ }
}, { signal: controller.signal });
```

Results are returned in canonical MCP content form
(`{ content: [{ type: "text", text }] , isError? }`) rather than bare strings, so
behaviour is identical across agent hosts.

### Designed against Chrome's published best practices

Two defects in our own first draft were found by reading
[Chrome's WebMCP best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)
and both are fixed:

- **"Use verbs that describe exactly what happens."** Write tools were originally
  named `report_access_change` / `correct_label`, implying they changed things.
  They do not — they queue proposals. All four are now `propose_*`.
- **"Accept raw user input; avoid requiring the model to perform calculations."**
  `propose_landmark` originally demanded metre coordinates, which made the model
  invent numbers. It now takes the **name of a room** and places the landmark at
  its centroid. `propose_doorway` takes the **names of the two rooms** a door
  joins and works out where it would have to sit. A test asserts that no tool in
  the surface accepts an `x` or `z` parameter.
- **"Validate strictly in code, loosely in schema, with descriptive errors
  enabling self-correction."** This is exactly what the topology gate is. Schemas
  stay permissive; the deterministic validator is strict and hands back field
  paths.

### And against the tool-security and agent-security guides

Chrome published [tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
and a companion [agent security](https://developer.chrome.com/docs/agents/security)
guide. Auditing this surface against all 181 of their checkable rules found
three real defects, all now fixed and pinned by tests:

- **A number nobody gave was treated as a measurement.** `propose_doorway`
  filled an unmeasured doorway with a 0.9 m default and stamped the evidence
  `method: "human"` — laundering this app's placeholder into the venue's record
  as a visitor's observation. Width and step-free status are now optional, an
  unmeasured width is evidenced as `derived` below the confidence floor (so a
  clearance check answers UNKNOWN, not CLEAR), and the reviewer's card says
  *"width not measured, step-free status not stated"* next to what they are
  approving.
- **An unreadable parameter was silently ignored.** `minimum_clear_width_mm:
  "760mm"` parsed to null, which meant *no width given*, which meant no width
  was checked — and the tool could answer **CLEAR** to a wheelchair user whose
  chair had never been compared to a doorway. A given-but-unreadable value is
  now rejected, naming the expected format, which is also what the guides ask
  of a rejected parameter.
- **Results were unbounded on a venue larger than the demo.** The 1.5K result
  budget held for our sample building and would have broken on a real one:
  every-doorway and every-landmark lists grow with the plan. Those lists are
  now budgeted line by line, ordered so the cut falls on the widest doorways
  rather than the narrowest, and `ok()`/`fail()` clamp on a line boundary as a
  backstop. A test builds a venue with 60 extra doors and landmarks and asserts
  every read result stays inside 1500 characters.

The agent-security guide applies to this repo twice over, because the voice
path is itself an agent. Its system prompt now states that tool results are
data and never instructions — room labels and review notes are written by
strangers — and a test plants an injected instruction in a room label, runs the
tool loop, and asserts nothing was written on the strength of it.

Two things the guides say that this surface does **not** need: `destructiveHint`
and `idempotentHint` do not exist in Chrome's WebMCP (only `readOnlyHint` and
`untrustedContentHint` do), and cross-origin `exposedTo` is not used here
because the tools are for the agent driving this page.

### The agent dock

The dock lives *inside the 3D viewport*, not in a sidebar. That is deliberate:
the inspector rail is hidden below 1120px, which is roughly the width ChatGPT
renders this page at — so a sidebar implementation would make the entire agent
surface invisible in the one browser that can drive it. On narrow screens the
dock becomes a bottom sheet with the venue still visible above it.

It shows registration state, a live feed of tool calls and their outcomes, the
approval queue with each change's real-world impact, and gate refusals with
their exact rule violations.

---

## Why this problem, and for whom

**The people:** disabled visitors rehearse a route before entering an unfamiliar
building, because getting it wrong means a wasted trip or being stranded. And
venue accessibility teams, who are responsible for data they have no cheap way
to keep current.

**The gap is not coverage, it is granularity and freshness.** Google Maps holds
wheelchair attributes for 15M+ places, but the attribute is near-binary —
entrance width and steps. AccessNow uses three buckets. That is enough to decide
*maybe*; it is not enough to plan a route through a building.

**Somebody already sells the detailed answer, by hand.**
[AccessAble](https://www.accessableconsultancy.co.uk/our-services) publishes
Detailed Access Guides for ~70,000 venues across 500+ clients, produced by a
human surveyor on a 30–60 minute call per venue; standalone physical access
audits run £3,000–£6,000. The market is proven — the model is labour-bound,
which is why it covers 70,000 venues and not 15 million.

**Why the data rots:** updating it requires a human to open an app and fill in a
form. Nobody does that, which is why studies of crowdsourced accessibility data
consistently find incompleteness, inconsistent tagging and stale snapshots.

**What WebMCP changes:** the update stops being a form. A visitor standing at
the door says *"there's a step here now"* to the assistant already in their ear,
and a validated, provenance-stamped proposal lands in the venue's queue.
Cost-per-update collapses — and quality goes *up*, not down, because the
validator rejects incoherent edits before a human ever sees one.

That is the substantial improvement WebMCP brings here, and it is not
cosmetic: it is the difference between accessibility data that is surveyed once
and decays, and accessibility data that is maintained by the people who
encounter the building.

---

## What the gate does and does not check

The gate checks that a change is **internally consistent with the rest of the
plan**: a doorway sits on the boundary of both rooms it joins, a landmark is
inside the building, a route marked step-free does not run through a door marked
blocked. It is deterministic, and it is why an agent cannot corrupt the venue's
topology.

**It cannot check whether a report is true of the building.** No software can.
The best published agentic wheelchair-accessibility auditing scores about
F1 0.60, and researchers working on this have been explicit that without a way
to measure against the real thing there is no way to calculate that statistic at
all. So "validated" here means *coherent*, never *verified on site* — and the
tools say so in their own output rather than leaving an agent to assume.

That distinction matters commercially as well as ethically. In January 2025 the
FTC entered a $1M order against an accessibility-overlay vendor for
"overstating a product's AI or other capabilities without adequate evidence".
The American Foundation for the Blind calls the failure mode *automated
inclusion*: once a system is automated, it becomes harder to challenge.

## Why a declined report is kept

A venue can decline any report. It cannot delete one.

That is a deliberate inversion. In the 2024 Euan's Guide Access Survey
(n=6,665), **77% of disabled respondents found venue-published access
information misleading or inaccurate** — the venue is the least reliable source
in the dataset. Giving it a veto over first-hand visitor accounts would hand the
least accurate party authority over the most accurate one, which is close to the
objection the National Federation of the Blind raised against overlay vendors:
that they fail to acknowledge disabled people know what is accessible.

So declining records a disagreement. `list_disputed_claims` reports both sides,
and `check_accessibility` flags when disputes are outstanding. An agent asking
about this venue is told what the venue says *and* what visitors said.

## Where the record lives

"Kept on the record" has to mean more than "kept in this tab". Every proposal
an agent makes is posted to the run's review ledger on the server and stored in
the same object store that holds the venue's scene versions. A page refresh, or
a different visitor's agent on a different device, hydrates from that ledger.

The server does not trust the browser's gate, and it does not accept a scene
from the browser at all. A proposal is the mutation — five fields — and the
backend applies it to *its own* copy of the venue, runs the same Pydantic
topology validator on the result, and computes the accessibility impact from
that. So a proposal cannot carry anything its description does not say: a
"rename this room" cannot also widen a door or clear the review issues, because
the server never sees a scene the client built. (The first version of this
feature did accept a client candidate, and a review proved exactly that attack.
It is fixed, and a test now asserts the installed scene differs from the base
only where the mutation says.)

A proposal drafted against a scene version the venue has since moved past is
refused when it is made, and again if it is somehow approved later. Approval
writes a new version through the same path every other scene change takes, and
drops the run back to needs-review with an issue naming the change, so
publishing stays a deliberate second step. Proposals are idempotent on their
id, and every write to one run's ledger is serialised behind a per-run lock —
without it, a proposal and its own audit entry arriving together lost one of
the two, every time.

```
GET  /api/runs/{id}/review                        the ledger
POST /api/runs/{id}/proposals                     apply the mutation server-side, validate, store
POST /api/runs/{id}/proposals/{pid}/approve       version check, new scene version, scene returned
POST /api/runs/{id}/proposals/{pid}/decline       kept, status "declined"
POST /api/runs/{id}/audit                         tool-call audit entries, batched
```

The dock shows, per proposal, whether it is on the venue record or held only
in the tab, so the difference is never hidden from the person reviewing.

## Measurements, not verdicts

CHI 2025 (N=190) found scooter users judged 46% of barriers impassable against
28% for cane users — manual and powered wheelchair users disagree significantly
with each other. A single "accessible: yes/no" bit is therefore wrong for
somebody by construction.

`check_accessibility` reports every doorway's clear width, narrowest first, and
`find_step_free_route` headlines the narrowest doorway on the route. The tools
supply the number and leave the threshold to the person, because the threshold
is theirs.

For context on how unusual that is: Mappedin's live venue format expresses
accessibility as a single bit in a 94-byte file, derived from the connection
type rather than measured. IMDF cannot express clear width, gradient or
turning circle at all.

## How to test it

Open the live app in the ChatGPT app browser, or in Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` on. Google's *WebMCP Inspector*
extension lists the tools a page registers and lets you call them by hand; the
dock in the bottom-right of the studio shows the same list and reads
**"14 tools live"** when registration worked.

Say these to your agent, in this order. Each one shows a different thing.

1. *"Is the quiet room step-free from the main entrance?"* — a route computed
   from geometry, with door widths. The 3D view moves.
2. *"My chair is 760 mm wide. Can I get to the quiet room?"* — a clearance
   verdict. It answers **unknown**, not clear, because that doorway was
   extracted at 78% confidence, and says how old the data is.
3. *"The quiet-room doorway has a step now, report it."* — the server applies
   the change to its own copy, computes what it costs (*"removes step-free
   access to Quiet room"*), and a card appears in the dock. Nothing is live.
4. *"Add a doorway between the main lobby and the quiet room."* — the gate
   refuses it with the exact rule and field path. The agent can correct itself.
5. In the dock, click **Reject** on the report. Then **refresh the page.** The
   dispute is still there: a venue can decline a report, not delete it.
6. *"Has anyone disagreed with the venue about access here?"* — the next agent
   hears both sides.
7. *"If the lift were out of service, what would I lose?"* — a what-if that
   changes nothing.

Without a WebMCP browser the page still works as a normal app, and the dock
explains how to enable the tools.

## Honesty box

- This is **rehearsal** guidance, not live navigation, and no safety claim is made.
- The review ledger is one JSON object per run, serialised behind a per-run
  lock *within one server process*. Two server instances would still race.
  Fine for a single-instance deployment, which is what this is.
- The venue role is a shared token in a header, not accounts. A reviewer
  arrives once with `?venue=<token>` and the browser keeps it; unset for the
  open demo, so anyone can approve or decline there.
- The voice path (`/ask`) files its edits as proposals through the same ledger
  as the WebMCP tools. It used to write scene versions directly; it no longer
  does. A spoken *"mark the gallery door inaccessible"* now lands in the same
  queue, with the spoken sentence as its provenance, and a person decides.
- Server-side impact matches the client's rule for a landmark without its own
  route node (nearest node). A landmark an agent proposes has no node of its
  own, so this parity is what keeps the two from disagreeing about it.
- Route quality is bounded by extraction quality. `list_data_issues` exists so an
  agent can surface exactly that rather than paper over it.
- WebMCP is an origin trial (Chrome 149–156). Outside a WebMCP browser the page
  still works fully as a human app and the dock explains how to enable it.
- The scene format is bespoke today. Speaking
  [IMDF](https://www.ogc.org/standards/indoor-mapping-data-format/), now an OGC
  Community Standard, is the obvious next move so this becomes a validation and
  agent layer over the format venues already export.

## Running the WebMCP tests

```bash
npm test        # includes tests/webmcp-{queries,gate,tools}.test.ts
```

Both gate paths are covered: a change that survives validation and reports its
impact, and a change the validator refuses with addressable field paths.

## Licence

MIT — see [LICENSE](LICENSE).
