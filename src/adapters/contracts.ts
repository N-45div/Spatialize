import type { SpatialScene } from "../domain/spatial-scene";

export interface GenerationAdapter {
  analyzeFloorPlan(input: File): Promise<SpatialScene>;
  narrateRoute(scene: SpatialScene, destinationId: string): Promise<Blob>;
}

export interface StorageAdapter {
  saveScene(scene: SpatialScene): Promise<{ key: string; versionId: string }>;
  uploadAsset(key: string, data: Blob): Promise<{ url: string }>;
}
