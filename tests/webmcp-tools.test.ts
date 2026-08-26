import { beforeEach, describe, expect, it } from "vitest";
import { sampleScene } from "../src/data/sample-scene";
import type { SpatialScene } from "../src/domain/spatial-scene";
import { clearAgentSession, getAgentSession } from "../src/webmcp/session";
import { buildTools, type ToolContext } from "../src/webmcp/tools";

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

    expect(tools.size).toBe(10);
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
    expect(tools.get("report_access_change")?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools.get("propose_landmark")?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("declares required arguments on every write tool", () => {
    const { tools } = harness(copyScene());

    for (const name of ["report_access_change", "propose_landmark", "correct_label"]) {
      expect(tools.get(name)?.inputSchema?.required).toContain("reason");
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
      await call(tools, "report_access_change", {
        door: "Quiet-room doorway",
        step_free: false,
        reason: "there is a 15 cm step at this door now"
      })
    );

    expect(text).toContain("queued for human approval");
    expect(getAgentSession().proposals).toHaveLength(1);
    // The live scene is untouched until a person approves.
    expect(scene.doors.find((item) => item.id === "door-corridor-quiet")?.accessible).toBe(true);
  });

  it("tells the reviewer what the change costs in plain terms", async () => {
    const { tools } = harness(copyScene());

    await call(tools, "report_access_change", {
      door: "door-corridor-quiet",
      step_free: false,
      reason: "a step was installed"
    });

    expect(getAgentSession().proposals[0].impact.lostStepFree).toContain("Quiet room");
  });

  it("hands an impossible write back as a structured, addressable refusal", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "propose_landmark", {
      label: "Rooftop bar",
      type: "destination",
      x: 900,
      z: 900,
      reason: "an agent invented this"
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("topology gate rejected");
    expect(getAgentSession().proposals).toHaveLength(0);
    expect(getAgentSession().refusals).toHaveLength(1);
  });

  it("insists on provenance before accepting a report", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "report_access_change", {
      door: "door-corridor-quiet",
      step_free: false
    });

    expect(result.isError).toBe(true);
    expect(getAgentSession().proposals).toHaveLength(0);
  });

  it("refuses to relabel an entity that does not exist", async () => {
    const { tools } = harness(copyScene());

    const result = await call(tools, "correct_label", {
      entity_id: "not-a-real-id",
      new_label: "Anything",
      reason: "guessing"
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No room, door or landmark");
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
