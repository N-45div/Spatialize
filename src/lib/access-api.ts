import type { Point } from "../domain/spatial-scene";

export interface AccessSource {
  id: string; title: string; publisher: string; url: string | null;
  observedAt: string; synthetic: boolean; body: string;
}
export interface Obstacle {
  id: string; label: string; roomId: string; position: Point;
  width: number; depth: number; rotation: number; sourceId: string; verified: boolean;
}
export interface ObstacleMove {
  obstacleId: string; roomId: string; position: Point; rotation: number; reason: string;
  baseSceneVersion: number; baseAccessVersion: number;
}
export interface AccessProposal {
  id: string; move: ObstacleMove; status: "pending" | "approved" | "declined";
  decisionReason: string | null; resultingVersion: number | null;
}
export interface AccessSnapshot {
  venueId: string; version: number; sceneVersion: number; contentMode: "fixture" | "sanity";
  synthetic: boolean; agentConfigured: boolean; projectId: string | null;
  sources: AccessSource[]; obstacles: Obstacle[]; proposals: AccessProposal[];
  rooms: { id: string; label: string }[];
}
export interface AccessAnswer {
  verdict: "CLEAR" | "BLOCKED" | "UNKNOWN"; destinationId: string; destinationLabel: string;
  sceneVersion: number; accessVersion: number; checkedAt: string; clearanceMm: number;
  route: Point[]; distanceMeters: number | null; contentMode: "fixture" | "sanity";
  reasons: { entityId: string; message: string; sourceId?: string }[];
  evidence: AccessSource[]; limitations: string[];
  claims?: { id: string; entityId: string; property: string; value: boolean | number; status: string; sourceId: string }[];
  agentStatus: string; agentSummary: string | null; agentMessage?: string;
  contextReads: { tool: string; arguments: string; output: string; successful: boolean }[];
}
export interface MovePreview {
  obstacles: Obstacle[]; impact: { destination: string; before: string; after: string }[];
  clearanceMm: number; sceneVersion: number; accessVersion: number;
}
const base = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
export async function accessRequest<T>(runId: string, path = "", body?: unknown, decision = false): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem("spatialize-venue-token");
  if (decision && token) headers["X-Venue-Token"] = token;
  const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/access${path}`, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof error?.detail === "string" ? error.detail : `Access desk request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
