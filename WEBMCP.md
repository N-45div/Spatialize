# Spatialize × WebMCP

**A building that answers your agent from geometry, and refuses it when it's wrong.**

Spatialize publishes a venue's floor plan to any agent in the browser as twelve
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
Generative Media Hackathon and **its last commit before the WebMCP Submission
Period opened was `04e9ad8`, dated 3 August 2026.**

The Submission Period opened 25 August 2026. **Every commit below is new work,
and the entire WebMCP surface lives in files that did not exist before it.**

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

`git log 04e9ad8..HEAD` reproduces exactly this list. Every commit builds,
typechecks, and passes its tests in isolation.

### What is new

| Added | File | Why it exists |
|---|---|---|
| WebMCP browser typings | `src/webmcp/types.ts` | WebMCP ships no TypeScript definitions yet |
| Route & accessibility engine | `src/webmcp/queries.ts` | Pathfinding, blocker detection, step-free audit, room geometry |
| The agent write gate | `src/webmcp/gate.ts` | Validates proposals, diffs their real-world impact |
| Tool surface (12 tools) | `src/webmcp/tools.ts` | The published contract |
| Registration hook | `src/webmcp/useWebMCP.ts` | Registers per venue, tears down via `AbortSignal` |
| Agent session store | `src/webmcp/session.ts` | Tool-call log, approval queue, refusals |
| Agent dock UI | `src/components/AgentPanel.tsx` | Watch the agent work, approve or reject its changes |
| Landmark bounds rule | `src/domain/spatial-scene.ts` | A validator hole this work exposed (see below) |
| 59 new tests | `tests/webmcp-*.test.ts` (58), `spatial-scene.test.ts` (1) | Both gate paths, every tool, the contract itself |

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

---

## The tool surface

Eight read tools (annotated `readOnlyHint` and `untrustedContentHint`) and four write tools. Every write is
named `propose_*`, because nothing an agent does goes live by itself.

| Tool | Kind | What it does |
|---|---|---|
| `get_venue_overview` | reads | Footprint, counts, review status, step-free summary |
| `list_destinations` | reads | Routable places with ids and confidence |
| `find_step_free_route` | reads | Turn-by-turn route, or the door that blocks it |
| `describe_room` | reads | Area, category, neighbours, door widths, confidence |
| `check_accessibility` | reads | Whole-venue step-free audit, every doorway width, open disputes |
| `list_data_issues` | reads | Open validator issues and low-confidence extractions |
| `list_disputed_claims` | reads | Reports the venue declined, kept on the record |
| `focus_view` | reads | Moves the page's 3D view so a person sees what the agent found |
| `propose_access_change` | proposes | A doorway became blocked, or was cleared |
| `propose_doorway` | proposes | A doorway the plan missed, named by the two rooms it joins |
| `propose_landmark` | proposes | A restroom/lift/destination the plan missed |
| `propose_label_correction` | proposes | The vision model misread a name |

The page publishes this contract to visitors too — the agent dock has a
**"Show the 12 tools this page publishes"** panel listing every tool, its
read/propose kind, and its typed parameters. You can read the surface without
opening the source.

---

## How WebMCP is implemented

Tools are registered on `document.modelContext` once per venue, tied to an
`AbortController` so that loading a different floor plan tears the old set down
and fires `toolchange` — an idle agent learns the building changed underneath
it. See `src/webmcp/useWebMCP.ts`:

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

## Honesty box

- This is **rehearsal** guidance, not live navigation, and no safety claim is made.
- Approving a proposal updates the scene in the browser session. Persisting
  approved scenes back through the B2-backed run store is the next step, not a
  shipped one.
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
