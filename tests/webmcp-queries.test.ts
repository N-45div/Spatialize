import { describe, expect, it } from "vitest";
import { sampleScene } from "../src/data/sample-scene";
import type { SpatialScene } from "../src/domain/spatial-scene";
import {
  accessibilitySummary,
  adjacentRooms,
  dataIssues,
  planRoute,
  polygonArea,
  resolveDoor
} from "../src/webmcp/queries";

function copyScene(): SpatialScene {
  return structuredClone(sampleScene);
}

/** Turn the quiet-room doorway into a real barrier, edges included. */
function blockQuietRoom(scene: SpatialScene) {
  const door = scene.doors.find((item) => item.id === "door-corridor-quiet")!;
  door.accessible = false;
  for (const edge of scene.routeGraph.edges) {
    if (edge.doorId === door.id) edge.accessible = false;
  }
  return scene;
}

describe("route planning", () => {
  it("computes a step-free route to the quiet room in the reference venue", () => {
    const { plan, fallbackUsed } = planRoute(sampleScene, { to: "quiet-mark", stepFree: true });

    expect(plan.found).toBe(true);
    expect(fallbackUsed).toBe(false);
    expect(plan.blockers).toHaveLength(0);
    expect(plan.totalDistance).toBeGreaterThan(0);
    expect(plan.steps.some((step) => step.doorId === "door-corridor-quiet")).toBe(true);
  });

  it("walks the route in order from the entrance to the destination", () => {
    const { plan } = planRoute(sampleScene, { to: "quiet-mark" });

    expect(plan.steps[0].fromRoom).toBe("Main lobby");
    expect(plan.steps[plan.steps.length - 1].toRoom).toBe("Quiet room");
    for (let index = 1; index < plan.steps.length; index += 1) {
      expect(plan.steps[index].from).toBe(plan.steps[index - 1].to);
    }
  });

  it("names the blocking door instead of giving up when no step-free route exists", () => {
    const { plan, fallbackUsed } = planRoute(blockQuietRoom(copyScene()), {
      to: "quiet-mark",
      stepFree: true
    });

    expect(fallbackUsed).toBe(true);
    expect(plan.found).toBe(true);
    expect(plan.blockers.map((item) => item.doorId)).toContain("door-corridor-quiet");
  });

  it("still routes through the barrier when steps are acceptable", () => {
    const { plan, fallbackUsed } = planRoute(blockQuietRoom(copyScene()), {
      to: "quiet-mark",
      stepFree: false
    });

    expect(plan.found).toBe(true);
    expect(fallbackUsed).toBe(false);
  });

  it("resolves landmarks by label as well as by id", () => {
    const byLabel = planRoute(sampleScene, { to: "Quiet room" });
    const byId = planRoute(sampleScene, { to: "quiet-mark" });

    expect(byLabel.to?.id).toBe(byId.to?.id);
  });

  it("routes between two arbitrary landmarks, not only from the entrance", () => {
    const { plan, from } = planRoute(sampleScene, { from: "studio-mark", to: "gallery-mark" });

    expect(from?.id).toBe("studio-mark");
    expect(plan.found).toBe(true);
  });

  it("reports no route for an unknown destination rather than throwing", () => {
    const { plan, to } = planRoute(sampleScene, { to: "rooftop helipad" });

    expect(to).toBeNull();
    expect(plan.found).toBe(false);
  });
});

describe("venue geometry", () => {
  it("measures room area from the polygon", () => {
    const lobby = sampleScene.rooms.find((room) => room.id === "lobby")!;

    // 7 m x 5 m rectangle.
    expect(polygonArea(lobby.polygon)).toBeCloseTo(35, 5);
  });

  it("lists the rooms a room connects to and through which door", () => {
    const neighbours = adjacentRooms(sampleScene, "lobby");

    expect(neighbours.map((item) => item.roomId).sort()).toEqual(["gallery", "studio"]);
    expect(neighbours.every((item) => item.doorId.startsWith("door-"))).toBe(true);
  });

  it("matches doors by label as well as by id", () => {
    expect(resolveDoor(sampleScene, "Quiet-room doorway")?.id).toBe("door-corridor-quiet");
  });
});

describe("accessibility audit", () => {
  it("reports every destination as step-free in the clean reference venue", () => {
    const summary = accessibilitySummary(sampleScene);

    expect(summary.reachable).toContain("Quiet room");
    expect(summary.blocked).toHaveLength(0);
    expect(summary.inaccessibleDoors).toHaveLength(0);
  });

  it("moves a destination into the blocked list once its door is a barrier", () => {
    const summary = accessibilitySummary(blockQuietRoom(copyScene()));

    expect(summary.reachable).not.toContain("Quiet room");
    expect(summary.blocked.map((item) => item.label)).toContain("Quiet room");
    expect(summary.inaccessibleDoors).toContain("Quiet-room doorway");
  });

  it("surfaces low-confidence extractions and open review issues", () => {
    const issues = dataIssues(sampleScene);

    expect(issues.reviewStatus).toBeDefined();
    expect(issues.lowConfidence.some((item) => item.id === "door-corridor-quiet")).toBe(true);
  });
});
