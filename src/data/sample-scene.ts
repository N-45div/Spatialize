import { SpatialSceneSchema } from "../domain/spatial-scene";

export const sampleScene = SpatialSceneSchema.parse({
  schemaVersion: "1.0",
  id: "harbor-arts-ground",
  name: "Harbor Arts Centre · Ground floor",
  units: "meters",
  sourceAsset: "local://harbor-arts-floor-plan.png",
  rooms: [
    { id: "lobby", label: "Main lobby", polygon: [[0, 0], [7, 0], [7, 5], [0, 5]], confidence: 0.98, category: "public" },
    { id: "gallery", label: "Gallery one", polygon: [[7.5, 0], [15, 0], [15, 6.5], [7.5, 6.5]], confidence: 0.95, category: "public" },
    { id: "studio", label: "Learning studio", polygon: [[0, 5.5], [7, 5.5], [7, 11], [0, 11]], confidence: 0.91, category: "public" },
    { id: "corridor", label: "North corridor", polygon: [[7.5, 7], [15, 7], [15, 9], [7.5, 9]], confidence: 0.89, category: "circulation" },
    { id: "quiet", label: "Quiet room", polygon: [[10.5, 9.5], [15, 9.5], [15, 13], [10.5, 13]], confidence: 0.78, category: "public" },
    { id: "service", label: "Staff service", polygon: [[7.5, 9.5], [10, 9.5], [10, 13], [7.5, 13]], confidence: 0.87, category: "restricted" }
  ],
  landmarks: [
    { id: "entrance", label: "Main entrance", type: "entrance", position: [0.5, 2.5], confidence: 0.99 },
    { id: "gallery-mark", label: "Gallery one", type: "destination", position: [11, 3], confidence: 0.96 },
    { id: "studio-mark", label: "Learning studio", type: "destination", position: [3.5, 8], confidence: 0.93 },
    { id: "lift", label: "Elevator", type: "elevator", position: [8.6, 8], confidence: 0.84 },
    { id: "quiet-mark", label: "Quiet room", type: "destination", position: [12.8, 11.2], confidence: 0.79 }
  ],
  routeGraph: {
    nodes: [
      { id: "n0", position: [0.5, 2.5], landmarkId: "entrance" },
      { id: "n1", position: [6.3, 2.5] },
      { id: "n2", position: [8.2, 3] },
      { id: "n3", position: [11, 3], landmarkId: "gallery-mark" },
      { id: "n4", position: [6.3, 6.2] },
      { id: "n5", position: [3.5, 6.2] },
      { id: "n6", position: [3.5, 8], landmarkId: "studio-mark" },
      { id: "n7", position: [8.6, 8], landmarkId: "lift" },
      { id: "n8", position: [12.8, 8] },
      { id: "n9", position: [12.8, 11.2], landmarkId: "quiet-mark" }
    ],
    edges: [
      { from: "n0", to: "n1", distance: 5.8, accessible: true },
      { from: "n1", to: "n2", distance: 2.1, accessible: true },
      { from: "n2", to: "n3", distance: 2.8, accessible: true },
      { from: "n1", to: "n4", distance: 3.7, accessible: true },
      { from: "n4", to: "n5", distance: 2.8, accessible: true },
      { from: "n5", to: "n6", distance: 1.8, accessible: true },
      { from: "n4", to: "n7", distance: 2.9, accessible: true },
      { from: "n7", to: "n8", distance: 4.2, accessible: true },
      { from: "n8", to: "n9", distance: 3.2, accessible: true }
    ]
  },
  review: {
    status: "needs-review",
    issues: [
      { id: "quiet-door", message: "Confirm the quiet-room doorway position.", severity: "medium" }
    ]
  }
});
