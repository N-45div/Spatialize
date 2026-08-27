import { beforeEach, describe, expect, it } from "vitest";
import { sampleScene } from "../src/data/sample-scene";
import type { SpatialScene } from "../src/domain/spatial-scene";
import { clearAgentSession, declineProposal, getAgentSession } from "../src/webmcp/session";
import { buildTools, describeToolSurface, type ToolContext } from "../src/webmcp/tools";

type Tool = ReturnType<typeof buildTools>[number];

function copyScene(): SpatialScene {
  return structuredClone(sampleScene);
}

function textOf(result: { content: { text: string }[] }) {
  return result.content.map((block) => block.text).join("\n");
}

function harness(scene: SpatialScene) {
  const focused: string[] = [];
  const modes: string[] = [];
  const context: ToolContext = {
    getScene: () => scene,
    focusLandmark: (id) => focused.push(id),
    setViewMode: (mode) => modes.push(mode)
  };
  const tools = new Map(buildTools(context).map((tool) => [tool.name, tool]));
  return { tools, focused, modes };
}

async function call(tools: Map<string, Tool>, name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute(args);
}

beforeEach(() => {
  clearAgentSession();
});

describe("tool registration contract", () => {
  it("registers every tool with a name, description and object schema", () => {
    const { tools } = harness(copyScene());

    expect(tools.size).toBe(12);
    for (const tool of tools.values()) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema?.type).toBe("object");
    }
  });

  it("marks the question-answering tools read-only and the writes not", () => {
    const { tools } = harness(copyScene());

    expect(tools.get("find_step_free_route")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("check_accessibility")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("propose_access_change")?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools.get("propose_landmark")?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("names every write tool so the verb matches what actually happens", () => {
    const { tools } = harness(copyScene());
    const writes = [...tools.values()].filter((tool) => !tool.annotations?.readOnlyHint);

    // Nothing goes live on the agent's say-so, so nothing is named as if it did.
    expect(writes).toHaveLength(4);
    for (const tool of writes) expect(tool.name.startsWith("propose_")).toBe(true);
  });

  it("declares required arguments on every write tool", () => {
    const { tools } = harness(copyScene());

    for (const name of [
      "propose_access_change",
      "propose_doorway",
      "propose_landmark",
      "propose_label_correction"
    ]) {
      expect(tools.get(name)?.inputSchema?.required).toContain("reason");
    }
  });

  it("never asks the model to compute coordinates", () => {
    const { tools } = harness(copyScene());

    // Agents are poor at arithmetic; every write takes names, not metres.
    for (const tool of tools.values()) {
      const properties = Object.keys(tool.inputSchema?.properties ?? {});
      expect(properties).not.toContain("x");
      expect(properties).not.toContain("z");
    }
  });
});

describe("context budgets", () => {
  // Chrome's WebMCP guidance: names <=30 chars, tool descriptions <=500,
  // parameter descriptions <=150, and a single tool result <=1.5K. Every tool
  // we publish is context an agent has to carry, so this is a real cost.
  const surface = () => describeToolSurface(sampleScene);

  it("keeps tool names inside the 30-character budget", () => {
    for (const tool of surface()) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(30);
    }
  });

  it("keeps tool descriptions inside the 500-character budget", () => {
    const tools = buildTools({
      getScene: () => sampleScene,
      focusLandmark: () => undefined,
      setViewMode: () => undefined
    });
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(500);
    }
  });

  it("keeps parameter descriptions inside the 150-character budget", () => {
    const tools = buildTools({
      getScene: () => sampleScene,
      focusLandmark: () => undefined,
      setViewMode: () => undefined
    });
    for (const tool of tools) {
      const properties = (tool.inputSchema?.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description?.length ?? 0, `${tool.name}.${name}`).toBeLessThanOrEqual(150);
      }
    }
  });

  it("keeps a single tool result inside the 1.5K-character budget", async () => {
    const { tools } = harness(copyScene());
    const results = await Promise.all([
      call(tools, "get_venue_overview"),
      call(tools, "check_accessibility"),
      call(tools, "list_destinations"),
      call(tools, "list_data_issues"),
      call(tools, "find_step_free_route", { to: "quiet-mark" }),
      call(tools, "describe_room", { room: "lobby" })
    ]);
    for (const result of results) {
      expect(textOf(result).length).toBeLessThanOrEqual(1500);
    }
  });
});

describe("read tools", () => {
  it("answers a route question from geometry and moves the page view", async () => {
    const { tools, focused } = harness(copyScene());

    const result = await call(tools, "find_step_free_route", { to: "Quiet room" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Step-free route");
    expect(focused).toContain("quiet-mark");
  });

  it("names the blocking door instead of refusing when no step-free route exists", async () => {
    const scene = copyScene();
    const door = scene.doors.find((item) => item.id === "door-corridor-quiet")!;
    door.accessible = false;
    for (const edge of scene.routeGraph.edges) {
      if (edge.doorId === door.id) edge.accessible = false;
    }
    const { tools } = harness(scene);

    const text = textOf(await call(tools, "find_step_free_route", { to: "quiet-mark" }));

    expect(text).toContain("NO step-free route");
    expect(text).toContain("Quiet-room doorway");
    expect(text).toContain("door-corridor-quiet");
  });

  it("coerces a string boolean, because agents send them", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(await call(tools, "find_step_free_route", { to: "quiet-mark", step_free: "false" }));

    expect(text).toContain("Route from");
  });

  it("summarises the venue and its step-free reachability", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(await call(tools, "get_venue_overview"));

    expect(text).toContain("Harbor Arts Centre");
    expect(text).toContain("Step-free from the main entrance");
  });

  it("switches the page view mode on request", async () => {
    const { tools, modes } = harness(copyScene());

    await call(tools, "focus_view", { target: "gallery-mark", mode: "2d" });

    expect(modes).toContain("2d");
  });

  it("rejects unknown entities with the valid options listed", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "describe_room", { room: "ballroom" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Main lobby");
  });
});

describe("write tools", () => {
  it("queues a valid write for human approval rather than applying it", async () => {
    const scene = copyScene();
    const { tools } = harness(scene);

    const text = textOf(
      await call(tools, "propose_access_change", {
        door: "Quiet-room doorway",
        step_free: false,
        reason: "there is a 15 cm step at this door now"
      })
    );

    expect(text).toContain("queued for human review");
    expect(getAgentSession().proposals).toHaveLength(1);
    // The live scene is untouched until a person approves.
    expect(scene.doors.find((item) => item.id === "door-corridor-quiet")?.accessible).toBe(true);
  });

  it("tells the reviewer what the change costs in plain terms", async () => {
    const { tools } = harness(copyScene());

    await call(tools, "propose_access_change", {
      door: "door-corridor-quiet",
      step_free: false,
      reason: "a step was installed"
    });

    expect(getAgentSession().proposals[0].impact.lostStepFree).toContain("Quiet room");
  });

  it("insists on provenance before accepting a report", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "propose_access_change", {
      door: "door-corridor-quiet",
      step_free: false
    });

    expect(result.isError).toBe(true);
    expect(getAgentSession().proposals).toHaveLength(0);
  });

  it("places a proposed landmark inside the room it was named for", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(
      await call(tools, "propose_landmark", {
        label: "Accessible restroom",
        type: "restroom",
        in_room: "North corridor",
        reason: "there is a restroom here the plan did not label"
      })
    );

    expect(text).toContain("queued for human review");
    const added = getAgentSession().proposals[0].scene.landmarks.find(
      (item) => item.label === "Accessible restroom"
    );
    // North corridor spans x 7..15, z 6.5..9.
    expect(added!.position[0]).toBeGreaterThan(7);
    expect(added!.position[0]).toBeLessThan(15);
    expect(added!.position[1]).toBeGreaterThan(6.5);
    expect(added!.position[1]).toBeLessThan(9);
  });

  it("accepts a doorway between two rooms that genuinely share a wall", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(
      await call(tools, "propose_doorway", {
        room_a: "North corridor",
        room_b: "Staff service",
        reason: "there is an unmarked door here"
      })
    );

    expect(text).toContain("queued for human review");
    expect(getAgentSession().refusals).toHaveLength(0);
  });

  it("hands an impossible doorway back as a structured, addressable refusal", async () => {
    const { tools } = harness(copyScene());

    // The lobby and the quiet room are at opposite corners and share no wall.
    const result = await call(tools, "propose_doorway", {
      room_a: "Main lobby",
      room_b: "Quiet room",
      reason: "an agent assumed these connect"
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("topology gate rejected");
    expect(textOf(result)).toContain("not on the boundary");
    expect(getAgentSession().proposals).toHaveLength(0);
    expect(getAgentSession().refusals).toHaveLength(1);
  });

  it("refuses a doorway from a room to itself", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "propose_doorway", {
      room_a: "Main lobby",
      room_b: "Main lobby",
      reason: "confused agent"
    });

    expect(result.isError).toBe(true);
    expect(getAgentSession().proposals).toHaveLength(0);
  });

  it("refuses to relabel an entity that does not exist", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "propose_label_correction", {
      entity: "not-a-real-thing",
      new_label: "Anything",
      reason: "guessing"
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No room, doorway or landmark");
  });

  it("relabels a room found by its name rather than its id", async () => {
    const { tools } = harness(copyScene());

    await call(tools, "propose_label_correction", {
      entity: "Quiet room",
      new_label: "Sensory room",
      reason: "the sign on the door says Sensory Room"
    });

    const proposal = getAgentSession().proposals[0];
    expect(proposal.scene.rooms.find((item) => item.id === "quiet")?.label).toBe("Sensory room");
  });
});

describe("declined reports stay on the record", () => {
  async function reportAndDecline(tools: Map<string, Tool>) {
    await call(tools, "propose_access_change", {
      door: "Quiet-room doorway",
      step_free: false,
      reason: "there is a 15 cm step here now"
    });
    const proposal = getAgentSession().proposals[0];
    return declineProposal(proposal.id);
  }

  it("keeps a declined report as a dispute rather than deleting it", async () => {
    const { tools } = harness(copyScene());

    const dispute = await reportAndDecline(tools);

    expect(dispute).not.toBeNull();
    expect(getAgentSession().proposals).toHaveLength(0);
    expect(getAgentSession().disputes).toHaveLength(1);
    expect(getAgentSession().disputes[0].reason).toContain("15 cm step");
  });

  it("tells an agent about the disagreement, in both voices", async () => {
    const { tools } = harness(copyScene());
    await reportAndDecline(tools);

    const text = textOf(await call(tools, "list_disputed_claims"));

    expect(text).toContain("Quiet-room doorway");
    expect(text).toContain("15 cm step");
    expect(text).toContain("venue declined");
  });

  it("says plainly when nothing is disputed", async () => {
    const { tools } = harness(copyScene());

    expect(textOf(await call(tools, "list_disputed_claims"))).toContain("Nothing is in dispute");
  });

  it("flags outstanding disputes from the venue-wide audit", async () => {
    const { tools } = harness(copyScene());
    await reportAndDecline(tools);

    expect(textOf(await call(tools, "check_accessibility"))).toContain("list_disputed_claims");
  });
});

describe("measurements over verdicts", () => {
  it("reports every doorway width, not only those under one threshold", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(await call(tools, "check_accessibility"));

    // A scooter user and a cane user disagree about what counts as passable,
    // so the audit reports the number and leaves the judgement to the person.
    for (const door of sampleScene.doors) {
      expect(text).toContain(`${door.label}: ${door.width} m clear`);
    }
  });

  it("headlines the narrowest doorway on a route", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(await call(tools, "find_step_free_route", { to: "quiet-mark" }));

    expect(text).toContain("Narrowest doorway on this route: 1.1 m clear");
  });

  it("states that the geometry was not verified against the building", async () => {
    const { tools } = harness(copyScene());

    const text = textOf(await call(tools, "find_step_free_route", { to: "quiet-mark" }));

    expect(text).toContain("not verified against the building");
  });
});

describe("agent activity log", () => {
  it("logs every call so a person can watch the agent work", async () => {
    const { tools } = harness(copyScene());

    await call(tools, "get_venue_overview");
    await call(tools, "check_accessibility");
    await call(tools, "list_data_issues");

    const { calls } = getAgentSession();
    expect(calls).toHaveLength(3);
    expect(calls.map((entry) => entry.tool)).toContain("check_accessibility");
  });

  it("records the outcome of each call, not just that it happened", async () => {
    const { tools } = harness(copyScene());

    await call(tools, "get_venue_overview");
    await call(tools, "describe_room", { room: "ballroom" });

    const outcomes = getAgentSession().calls.map((entry) => entry.outcome);
    expect(outcomes).toContain("answered");
    expect(outcomes).toContain("error");
  });
});
