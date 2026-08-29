/**
 * Deterministic tool-chain evals, in the sense Chrome's WebMCP evals guidance
 * uses: fixed journeys, fixed inputs, and hard numbers on what each costs an
 * agent. No model is involved here — that is the separate tool-selection
 * eval. Run alone with `npm run evals` to see the table.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sampleScene } from "../../src/data/sample-scene";
import type { SpatialScene } from "../../src/domain/spatial-scene";
import { clearAgentSession, declineProposal, getAgentSession } from "../../src/webmcp/session";
import { buildTools } from "../../src/webmcp/tools";

type Tool = ReturnType<typeof buildTools>[number];
type Step = { tool: string; args?: Record<string, unknown>; expectError?: boolean; then?: () => void };

interface Journey {
  name: string;
  /** What a person actually wants. */
  goal: string;
  steps: Step[];
  /** Could a person get this from the page's own UI without an agent? */
  viaUi: "yes" | "partly" | "no";
}

const JOURNEYS: Journey[] = [
  {
    name: "route",
    goal: "Is the quiet room step-free from the entrance, and how far?",
    steps: [{ tool: "find_step_free_route", args: { to: "Quiet room" } }],
    viaUi: "partly"
  },
  {
    name: "clearance",
    goal: "Can my 760 mm chair get to the gallery?",
    steps: [{ tool: "check_route_clearance", args: { to: "gallery-mark", minimum_clear_width_mm: 760 } }],
    viaUi: "no"
  },
  {
    name: "audit",
    goal: "Which places can't be reached without steps, and how wide is every door?",
    steps: [{ tool: "check_accessibility" }],
    viaUi: "no"
  },
  {
    name: "report",
    goal: "Tell the venue the quiet-room doorway has a step now",
    steps: [
      {
        tool: "propose_access_change",
        args: { door: "Quiet-room doorway", step_free: false, reason: "there is a 15 cm step here now" }
      }
    ],
    viaUi: "no"
  },
  {
    name: "refuse-and-recover",
    goal: "Add a doorway; the first guess is impossible, the second is real",
    steps: [
      {
        tool: "propose_doorway",
        args: { room_a: "Main lobby", room_b: "Quiet room", reason: "guess" },
        expectError: true
      },
      { tool: "propose_doorway", args: { room_a: "North corridor", room_b: "Staff service", reason: "found it" } }
    ],
    viaUi: "no"
  },
  {
    name: "what-if",
    goal: "If the lift were out, what would I lose?",
    steps: [{ tool: "simulate_closure", args: { landmark: "Elevator" } }],
    viaUi: "no"
  },
  {
    name: "dispute",
    goal: "A declined report is still heard by the next agent",
    steps: [
      {
        tool: "propose_access_change",
        args: { door: "Gallery threshold", step_free: false, reason: "a lip my chair cannot clear" },
        then: () => declineProposal(getAgentSession().proposals[0].id)
      },
      { tool: "list_disputed_claims" },
      { tool: "check_route_clearance", args: { to: "gallery-mark" } }
    ],
    viaUi: "no"
  },
  {
    name: "orient",
    goal: "What is this building and where can I go?",
    steps: [{ tool: "get_venue_overview" }, { tool: "list_destinations" }],
    viaUi: "partly"
  }
];

interface Result {
  journey: string;
  calls: number;
  errors: number;
  chars: number;
  unauthorizedMutations: number;
  proposalsQueued: number;
  viaUi: string;
}

function harness(scene: SpatialScene) {
  return new Map<string, Tool>(
    buildTools({
      getScene: () => scene,
      focusLandmark: () => undefined,
      setViewMode: () => undefined,
      canPropose: true
    }).map((tool) => [tool.name, tool])
  );
}

async function runJourney(journey: Journey): Promise<Result> {
  clearAgentSession();
  const scene = structuredClone(sampleScene);
  const before = JSON.stringify(scene);
  const tools = harness(scene);
  let errors = 0;
  let chars = 0;

  for (const step of journey.steps) {
    const tool = tools.get(step.tool);
    if (!tool) throw new Error(`no tool ${step.tool}`);
    const result = await tool.execute(step.args ?? {});
    const text = result.content.map((block) => block.text).join("\n");
    chars += text.length;
    if (result.isError) errors += 1;
    expect(Boolean(result.isError), `${journey.name}/${step.tool}`).toBe(Boolean(step.expectError));
    step.then?.();
  }

  return {
    journey: journey.name,
    calls: journey.steps.length,
    errors,
    chars,
    // Every write is a proposal; the scene the page holds must never move.
    unauthorizedMutations: JSON.stringify(scene) === before ? 0 : 1,
    proposalsQueued: getAgentSession().proposals.length + getAgentSession().disputes.length,
    viaUi: journey.viaUi
  };
}

describe("journey evals", () => {
  beforeEach(() => clearAgentSession());

  it("completes every journey, never mutates the scene, and stays inside budget", async () => {
    const results: Result[] = [];
    for (const journey of JOURNEYS) results.push(await runJourney(journey));

    const table = [
      "| journey | tool calls | errors (expected) | result chars | unauthorised mutations | via UI alone |",
      "|---|---|---|---|---|---|",
      ...results.map(
        (row) =>
          `| ${row.journey} | ${row.calls} | ${row.errors} | ${row.chars} | ${row.unauthorizedMutations} | ${row.viaUi} |`
      )
    ].join("\n");
    console.log(`\n${table}\n`);

    for (const row of results) {
      expect(row.unauthorizedMutations, row.journey).toBe(0);
      expect(row.chars / row.calls, row.journey).toBeLessThanOrEqual(1500);
    }
    const totalCalls = results.reduce((sum, row) => sum + row.calls, 0);
    expect(totalCalls).toBe(12);
  });
});
