# Evals

Three kinds, in the sense Chrome's WebMCP evals guidance uses: deterministic
tool-chain journeys, a probabilistic tool-selection eval against a real model,
and an end-to-end run through the real backend. All three live in `tests/` and
run with `npm test`; the two eval suites alone run with `npm run evals`.

Numbers below are from a run on 27 August 2026 on commit `64f5799` plus the
changes in the commit that added this file.

## 1. Journeys — deterministic

Eight things a person actually wants, each expressed as the tool calls an
agent would make. Fixed inputs, fixed venue, no model. Measured per journey:
how many tool calls it took, how many were expected failures (the
refuse-and-recover journey deliberately proposes an impossible doorway first),
how many characters of context the results cost, whether anything an agent did
changed the scene the page holds (it must not — every write is a proposal),
and whether the page's own UI could have answered without an agent.

| journey | tool calls | errors (expected) | result chars | unauthorised mutations | via UI alone |
|---|---|---|---|---|---|
| route | 1 | 0 | 674 | 0 | partly |
| clearance | 1 | 0 | 443 | 0 | no |
| audit | 1 | 0 | 578 | 0 | no |
| report | 1 | 0 | 510 | 0 | no |
| refuse-and-recover | 2 | 1 | 999 | 0 | no |
| what-if | 1 | 0 | 252 | 0 | no |
| dispute | 3 | 0 | 1335 | 0 | no |
| orient | 2 | 0 | 732 | 0 | partly |

Twelve tool calls for eight complete journeys. No journey exceeds one call per
question except the two that are meant to: refuse-and-recover (a refusal, then
the corrected call) and dispute (report, list, re-check). Six of the eight are
not available through the page's UI at all — there is no button that returns a
clearance verdict for a 760 mm chair, or the set of destinations a closed lift
would strand. That is the honest form of the "fewer exchanges than the UI"
comparison: not faster, but possible.

"Unauthorised mutations" is the count that matters most, and it is zero by
construction: the scene object is serialised before the journey and compared
after. A write tool never touches it.

## 2. Tool selection — probabilistic

Twenty things a person might say, given to `google/gemini-3.6-flash` through
OpenRouter with the fourteen tools' names, descriptions and JSON schemas — and
nothing else. No examples, no system-prompt hints about which tool is which.
Temperature 0. Scored on whether the chosen tool was the expected one (two
prompts accept either of two tools) and, where a prompt implies a specific
argument, whether that argument was right.

| said | expected | chosen | tool | args |
|---|---|---|---|---|
| Is the quiet room step-free from the main entrance? | find_step_free_route | find_step_free_route | ✓ | ✓ |
| My chair is 700 mm wide. Can I get to the quiet room? | check_route_clearance | check_route_clearance | ✓ | ✓ |
| The quiet-room doorway has a step now. Please report it. | propose_access_change | propose_access_change | ✓ | ✓ |
| The ramp is back at the quiet-room doorway, it's step-free again. | propose_access_change | propose_access_change | ✓ | ✓ |
| There's a restroom in the north corridor that isn't on the plan. | propose_landmark | propose_landmark | ✓ | ✓ |
| The sign says the quiet room is actually called the Sensory room. | propose_label_correction | propose_label_correction | ✓ | ✓ |
| Add a doorway between the main lobby and the quiet room. | propose_doorway | propose_doorway | ✓ | – |
| Which places can't be reached without steps? | check_accessibility | check_accessibility | ✓ | – |
| Are there any doors narrower than 900 mm? | check_accessibility / check_route_clearance | check_accessibility | ✓ | – |
| What is this building? | get_venue_overview | get_venue_overview | ✓ | – |
| List the places I can go. | list_destinations | list_destinations | ✓ | – |
| Tell me about the learning studio. | describe_room | describe_room | ✓ | ✓ |
| Is anything in this plan unconfirmed or still under review? | list_data_issues | list_data_issues | ✓ | – |
| Has anyone disagreed with the venue about access here? | list_disputed_claims | list_disputed_claims | ✓ | – |
| Show me the gallery on the map. | focus_view | focus_view | ✓ | ✓ |
| Switch to the flat plan view. | focus_view | focus_view | ✓ | ✓ |
| If the lift were out of service, what would I lose? | simulate_closure | simulate_closure | ✓ | ✓ |
| Route me from the learning studio to the gallery. | find_step_free_route | find_step_free_route | ✓ | ✓ |
| I don't mind stairs. Fastest way to the quiet room? | find_step_free_route | find_step_free_route | ✓ | ✓ |
| How wide is the narrowest doorway on the way to the gallery? | find_step_free_route / check_route_clearance | find_step_free_route | ✓ | – |

**Tool selection: 100% (20/20). Argument accuracy: 100% (12/12).**

The cases were written before the eval was first run and not adjusted after.
The suite asserts only a 75% floor, because a model is not deterministic and a
test that fails on a bad day teaches nothing; the table is the result, the
floor is the guard. The eval skips when no `OPENROUTER_API_KEY` is present.

Why it comes out this high is not mysterious and is worth saying: the tools
follow Chrome's published guidance. One function per tool, verbs that say what
happens (`propose_`, not `report_`), names in plain language rather than ids,
no arithmetic asked of the model, and every description saying when to use the
tool as well as what it does. The eval is a check that the contract reads the
way it was meant to.

## 3. End to end — through the real backend

`tests/e2e/golden-journey.test.ts` spawns the FastAPI backend on a local port
with a temporary store and drives the tool surface against it through the same
client code the page uses. It asserts, in order:

1. a step-free route is computed;
2. a clearance check returns a verdict;
3. a visitor's report is applied **on the server**, its impact computed there
   ("Would remove step-free access to: Quiet room"), and comes back as saved;
4. an impossible doorway is refused by the gate and never reaches the server;
5. the venue declines the report through the server;
6. the tab forgets everything and hydrates from the record — the dispute is
   still there and the proposal is gone;
7. a later agent is told both sides, and a route check through the disputed
   doorway answers *unknown*;
8. nothing an agent did changed the scene the page holds;
9. a second report the venue accepts is installed by the server, which hands
   the new scene back, and the audit reflects it;
10. every tool call was recorded on the server.

It is skipped when the backend virtualenv is absent, and takes about five
seconds when it is not.

## 4. Through a real WebMCP host

`npm run host-check` (`scripts/host-journey.mjs`) launches headless Chrome
with the machine's own `chrome://flags` choices, opens the **production
bundle** served cross-origin from the API, and drives the golden journey
through Chrome's own testing surface — `navigator.modelContextTesting.listTools()`
and `executeTool()`. That is the browser calling the tools, not our code.
A Reject is a real click on the dock's button; the reload is a real
`Page.reload`.

Run on 30 August 2026, Chrome 151.0.0.0, flag `#enable-webmcp-testing`:

```
PASS  host sees a venue record; write tools published  14 tools live
PASS  host lists 14 tools
PASS  route computed via host
PASS  clearance verdict via host                       Verdict: UNKNOWN …
PASS  report queued and saved to the venue record
PASS  proposal card visible in the dock
PASS  impossible doorway refused by the gate
PASS  declined report shown as a dispute
PASS  dispute survives a page reload
PASS  a later agent hears both sides
PASS  route through the disputed door answers unknown
PASS  what-if changes nothing
PASS  every host call audited on the server
13/13 passed
```

The first run of this script was 8/13. It found that the store was hydrated
from the server by *replacing* local state, roughly a second after the tools
went live — so an agent that acted in that second had its proposal wiped
mid-flight. Hydration now merges. The fix is pinned by two unit tests and this
run.

## What is not measured

- Latency. The tools are pure functions over an in-memory scene; a route is
  microseconds. The interesting latency is the model's, and that is the
  model's.
- A DOM-scraping baseline. Measuring one honestly needs a browser-driving agent
  run against the page many times, and the page does not expose most of these
  answers in its DOM at all, so the comparison would be "possible vs not"
  rather than a number. The "via UI alone" column above is that comparison.
- The ChatGPT app browser specifically. Chrome is covered by section 4; the
  ChatGPT browser is a manual check on a machine that has it.
