import { describe, expect, it } from "vitest";
import { sampleScene } from "../src/data/sample-scene";
import { SpatialSceneSchema } from "../src/domain/spatial-scene";
import { routeToLandmark } from "../src/lib/routes";

function copyScene() {
  return structuredClone(sampleScene);
}

describe("SpatialScene contract", () => {
  it("accepts the reference venue", () => {
    expect(SpatialSceneSchema.safeParse(sampleScene).success).toBe(true);
  });

  it("rejects geometry outside the declared physical bounds", () => {
    const scene = copyScene();
    scene.rooms[0].polygon[0] = [-1, 0];

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("outside scene dimensions"))).toBe(true);
  });

  it("rejects doors connected to unknown rooms", () => {
    const scene = copyScene();
    scene.doors[0].connects[1] = "imaginary-room";

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("unknown room"))).toBe(true);
  });

  it("requires a matching door when a route crosses rooms", () => {
    const scene = copyScene();
    delete scene.routeGraph.edges[1].doorId;

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("must reference a door"))).toBe(true);
  });

  it("rejects route distances that disagree with node geometry", () => {
    const scene = copyScene();
    scene.routeGraph.edges[0].distance = 99;

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("does not match"))).toBe(true);
  });

  it("rejects a route segment that misses its referenced doorway", () => {
    const scene = copyScene();
    scene.doors[0].position = [7, 4.8];

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("does not pass through"))).toBe(true);
  });

  it("rejects a landmark placed outside the declared physical bounds", () => {
    const scene = copyScene();
    scene.landmarks[0].position = [scene.dimensions.width + 5, 2];

    const result = SpatialSceneSchema.safeParse(scene);

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => issue.message.includes("Landmark is outside scene dimensions"))
    ).toBe(true);
  });
});

describe("accessible route finding", () => {
  it("finds the entrance-to-quiet-room route", () => {
    const route = routeToLandmark(sampleScene, "quiet-mark");

    expect(route[0]).toEqual([0.5, 2.5]);
    expect(route.at(-1)).toEqual([12.8, 11.2]);
  });

  it("returns no route when the only doorway edge is inaccessible", () => {
    const scene = copyScene();
    const edge = scene.routeGraph.edges.find((item) => item.doorId === "door-corridor-quiet");
    if (!edge) throw new Error("Expected quiet-room edge");
    edge.accessible = false;

    expect(routeToLandmark(scene, "quiet-mark")).toEqual([]);
  });
});
