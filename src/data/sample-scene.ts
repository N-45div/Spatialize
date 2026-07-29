import { SpatialSceneSchema } from "../domain/spatial-scene";

const evidence = (confidence: number, sourceRegion?: [number, number, number, number]) => ({
  confidence,
  method: "model" as const,
  sourceRegion
});

const entityEvidence = (
  labelConfidence: number,
  geometryConfidence: number,
  sourceRegion: [number, number, number, number]
) => ({
  label: evidence(labelConfidence, sourceRegion),
  geometry: evidence(geometryConfidence, sourceRegion)
});

export const sampleScene = SpatialSceneSchema.parse({
  schemaVersion: "1.1",
  id: "harbor-arts-ground",
  name: "Harbor Arts Centre · Ground floor",
  units: "meters",
  sourceAsset: "b2://spatialize-demo/runs/demo/source/ground-floor-plan.png",
  sourceSha256: "d89adf7afaca5a32b67f1e540c9d8823a617f28b2cc3702465d49bd768ec9f11",
  dimensions: { width: 15, depth: 13, ceilingHeight: 3.2 },
  sourceTransform: {
    widthPixels: 2480,
    heightPixels: 1754,
    metersPerPixel: [15 / 2480, 13 / 1754],
    origin: [0, 0],
    xAxis: "right",
    zAxis: "down"
  },
  extraction: {
    runId: "extract_demo_7f2a91",
    provider: "sample-vision-adapter",
    model: "sample-plan-v1",
    completedAt: "2026-07-29T16:00:00.000Z"
  },
  rooms: [
    {
      id: "lobby", label: "Main lobby", polygon: [[0, 0], [7, 0], [7, 5], [0, 5]],
      confidence: 0.98, category: "public", evidence: entityEvidence(0.99, 0.97, [0.03, 0.04, 0.46, 0.39])
    },
    {
      id: "gallery", label: "Gallery one", polygon: [[7, 0], [15, 0], [15, 6.5], [7, 6.5]],
      confidence: 0.95, category: "public", evidence: entityEvidence(0.97, 0.94, [0.47, 0.04, 0.97, 0.5])
    },
    {
      id: "studio", label: "Learning studio", polygon: [[0, 5], [7, 5], [7, 11], [0, 11]],
      confidence: 0.91, category: "public", evidence: entityEvidence(0.95, 0.89, [0.03, 0.4, 0.46, 0.85])
    },
    {
      id: "corridor", label: "North corridor", polygon: [[7, 6.5], [15, 6.5], [15, 9], [7, 9]],
      confidence: 0.89, category: "circulation", evidence: entityEvidence(0.92, 0.87, [0.47, 0.5, 0.97, 0.7])
    },
    {
      id: "quiet", label: "Quiet room", polygon: [[10.5, 9], [15, 9], [15, 13], [10.5, 13]],
      confidence: 0.78, category: "public", evidence: entityEvidence(0.9, 0.76, [0.69, 0.7, 0.97, 0.98])
    },
    {
      id: "service", label: "Staff service", polygon: [[7, 9], [10.5, 9], [10.5, 13], [7, 13]],
      confidence: 0.87, category: "restricted", evidence: entityEvidence(0.91, 0.85, [0.47, 0.7, 0.68, 0.98])
    }
  ],
  doors: [
    {
      id: "door-lobby-gallery", label: "Gallery threshold", position: [7, 2.7], width: 1.6,
      rotation: Math.PI / 2, connects: ["lobby", "gallery"], accessible: true, confidence: 0.94,
      evidence: { position: evidence(0.95), width: evidence(0.91), connectivity: evidence(0.97) }
    },
    {
      id: "door-lobby-studio", label: "Studio doorway", position: [3.5, 5], width: 1.2,
      rotation: 0, connects: ["lobby", "studio"], accessible: true, confidence: 0.92,
      evidence: { position: evidence(0.94), width: evidence(0.88), connectivity: evidence(0.95) }
    },
    {
      id: "door-gallery-corridor", label: "Gallery corridor doorway", position: [8.3, 6.5], width: 1.4,
      rotation: 0, connects: ["gallery", "corridor"], accessible: true, confidence: 0.9,
      evidence: { position: evidence(0.92), width: evidence(0.86), connectivity: evidence(0.94) }
    },
    {
      id: "door-corridor-quiet", label: "Quiet-room doorway", position: [12.8, 9], width: 1.1,
      rotation: 0, connects: ["corridor", "quiet"], accessible: true, confidence: 0.78,
      evidence: { position: evidence(0.78), width: evidence(0.75), connectivity: evidence(0.82) }
    }
  ],
  landmarks: [
    {
      id: "entrance", label: "Main entrance", type: "entrance", position: [0.5, 2.5],
      confidence: 0.99, evidence: entityEvidence(0.99, 0.99, [0.01, 0.16, 0.06, 0.24])
    },
    {
      id: "gallery-mark", label: "Gallery one", type: "destination", position: [11, 3],
      confidence: 0.96, evidence: entityEvidence(0.97, 0.95, [0.67, 0.18, 0.78, 0.28])
    },
    {
      id: "studio-mark", label: "Learning studio", type: "destination", position: [3.5, 8],
      confidence: 0.93, evidence: entityEvidence(0.95, 0.91, [0.19, 0.57, 0.3, 0.68])
    },
    {
      id: "lift", label: "Elevator", type: "elevator", position: [8.6, 8],
      confidence: 0.84, evidence: entityEvidence(0.89, 0.81, [0.54, 0.57, 0.61, 0.67])
    },
    {
      id: "quiet-mark", label: "Quiet room", type: "destination", position: [12.8, 11.2],
      confidence: 0.79, evidence: entityEvidence(0.91, 0.76, [0.8, 0.81, 0.91, 0.91])
    }
  ],
  routeGraph: {
    nodes: [
      { id: "n0", position: [0.5, 2.5], roomId: "lobby", landmarkId: "entrance" },
      { id: "n1", position: [6.3, 2.5], roomId: "lobby" },
      { id: "n2", position: [7.7, 3], roomId: "gallery" },
      { id: "n3", position: [11, 3], roomId: "gallery", landmarkId: "gallery-mark" },
      { id: "n4", position: [6.3, 4.5], roomId: "lobby" },
      { id: "n5", position: [3.5, 5.5], roomId: "studio" },
      { id: "n6", position: [3.5, 8], roomId: "studio", landmarkId: "studio-mark" },
      { id: "n7", position: [8.6, 8], roomId: "corridor", landmarkId: "lift" },
      { id: "n8", position: [12.8, 8], roomId: "corridor" },
      { id: "n9", position: [12.8, 11.2], roomId: "quiet", landmarkId: "quiet-mark" }
    ],
    edges: [
      { from: "n0", to: "n1", distance: 5.8, accessible: true },
      { from: "n1", to: "n2", distance: 1.49, accessible: true, doorId: "door-lobby-gallery" },
      { from: "n2", to: "n3", distance: 3.3, accessible: true },
      { from: "n1", to: "n4", distance: 2, accessible: true },
      { from: "n4", to: "n5", distance: 2.97, accessible: true, doorId: "door-lobby-studio" },
      { from: "n5", to: "n6", distance: 2.5, accessible: true },
      { from: "n2", to: "n7", distance: 5.08, accessible: true, doorId: "door-gallery-corridor" },
      { from: "n7", to: "n8", distance: 4.2, accessible: true },
      { from: "n8", to: "n9", distance: 3.2, accessible: true, doorId: "door-corridor-quiet" }
    ]
  },
  review: {
    status: "needs-review",
    issues: [
      { id: "quiet-door", message: "Confirm the quiet-room doorway position.", severity: "medium" }
    ]
  }
});
