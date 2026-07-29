import type { SpatialScene } from "../domain/spatial-scene";

export interface SourceUpload {
  key: string;
  etag: string;
  versionId?: string;
  sha256: string;
}

export interface GeneratedMediaAsset {
  runId: string;
  assetId: string;
  url: string;
  sha256: string;
  mimeType: string;
  manifestUri: string;
  canonicalHash: string;
}

export interface VisionExtractionAdapter {
  analyzeFloorPlan(input: SourceUpload): Promise<SpatialScene>;
}

export interface GenblazeMediaAdapter {
  narrateRoute(scene: SpatialScene, destinationId: string): Promise<GeneratedMediaAsset>;
  generateLandmark(scene: SpatialScene, landmarkId: string): Promise<GeneratedMediaAsset>;
}

export interface SceneStorageAdapter {
  uploadSource(input: File): Promise<SourceUpload>;
  saveScene(scene: SpatialScene): Promise<{
    key: string;
    etag: string;
    versionId?: string;
  }>;
}
