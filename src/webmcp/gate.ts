/**
 * The topology gate, as seen by an agent.
 *
 * Spatialize already refuses to accept a scene that does not survive its
 * deterministic geometric validator. This module puts that same validator in
 * front of every write an agent attempts, and — crucially — turns a rejection
 * into structured, addressable feedback instead of a failed call. An agent that
 * proposes an impossible edit gets told exactly which rule it broke and where,
 * so it can correct itself rather than guess again.
 */
import { SpatialSceneSchema, type SpatialScene } from "../domain/spatial-scene";
import { accessibilitySummary } from "./queries";

export type SceneMutation =
  | {
      kind: "set-door-accessible";
      doorId: string;
      accessible: boolean;
      reason: string;
      /** Also flip the route edges that depend on this door. */
      cascade?: boolean;
    }
  | { kind: "set-door-width"; doorId: string; width: number; reason: string }
  | {
      kind: "relabel";
      entityKind: "room" | "door" | "landmark";
      entityId: string;
      label: string;
      reason: string;
    }
  | {
      kind: "add-landmark";
      label: string;
      landmarkType: "entrance" | "elevator" | "stairs" | "restroom" | "destination";
      position: [number, number];
      reason: string;
    }
  | {
      kind: "add-door";
      label: string;
      connects: [string, string];
      position: [number, number];
      width: number;
      accessible: boolean;
      reason: string;
    };

export interface GateViolation {
  path: string;
  message: string;
}

export interface AccessibilityImpact {
  lostStepFree: string[];
  gainedStepFree: string[];
  newlyBlockedDoors: string[];
}

export type GateVerdict =
  | {
      status: "accepted";
      scene: SpatialScene;
      impact: AccessibilityImpact;
      mutation: SceneMutation;
    }
  | { status: "refused"; violations: GateViolation[]; mutation: SceneMutation };

function clone(scene: SpatialScene): SpatialScene {
  return structuredClone(scene);
}

/** Provenance stamp for anything an agent relayed on a person's behalf. */
function agentEvidence(reason: string) {
  return {
    confidence: 0.6,
    method: "human" as const,
    note: `Reported via agent: ${reason}`.slice(0, 240)
  };
}

function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "landmark"
  );
}

/** The labelled collection a relabel targets. */
function collectionFor(scene: SpatialScene, entityKind: "room" | "door" | "landmark") {
  if (entityKind === "room") return scene.rooms;
  if (entityKind === "door") return scene.doors;
  return scene.landmarks;
}

/** A slug that is not already taken by anything in `taken`. */
function freeId(label: string, taken: Set<string>) {
  const base = slugify(label);
  let id = base;
  let suffix = 2;
  while (taken.has(id)) id = `${base}-${suffix++}`;
  return id;
}

type Draft = SpatialScene;

function applyDoorAccessible(
  draft: Draft,
  mutation: Extract<SceneMutation, { kind: "set-door-accessible" }>
) {
  const door = draft.doors.find((item) => item.id === mutation.doorId);
  if (!door) return;
  door.accessible = mutation.accessible;
  door.evidence.connectivity = agentEvidence(mutation.reason);
  if (!mutation.cascade) return;
  for (const edge of draft.routeGraph.edges) {
    if (edge.doorId === door.id) edge.accessible = mutation.accessible;
  }
}

function applyDoorWidth(draft: Draft, mutation: Extract<SceneMutation, { kind: "set-door-width" }>) {
  const door = draft.doors.find((item) => item.id === mutation.doorId);
  if (!door) return;
  door.width = mutation.width;
  door.evidence.width = agentEvidence(mutation.reason);
}

function applyRelabel(draft: Draft, mutation: Extract<SceneMutation, { kind: "relabel" }>) {
  const entity = collectionFor(draft, mutation.entityKind).find(
    (item) => item.id === mutation.entityId
  );
  if (!entity) return;
  entity.label = mutation.label;
  // Rooms and landmarks carry label evidence; the door schema has no slot for
  // it, so a door rename simply carries none rather than mis-stamping another.
  if ("label" in entity.evidence) {
    entity.evidence.label = agentEvidence(mutation.reason);
  }
}

function applyAddLandmark(draft: Draft, mutation: Extract<SceneMutation, { kind: "add-landmark" }>) {
  draft.landmarks.push({
    id: freeId(mutation.label, new Set(draft.landmarks.map((item) => item.id))),
    label: mutation.label,
    type: mutation.landmarkType,
    position: mutation.position,
    confidence: 0.6,
    evidence: {
      label: agentEvidence(mutation.reason),
      geometry: agentEvidence(mutation.reason)
    }
  });
}

function applyAddDoor(draft: Draft, mutation: Extract<SceneMutation, { kind: "add-door" }>) {
  draft.doors.push({
    id: freeId(mutation.label, new Set(draft.doors.map((item) => item.id))),
    label: mutation.label,
    position: mutation.position,
    width: mutation.width,
    rotation: 0,
    connects: mutation.connects,
    accessible: mutation.accessible,
    confidence: 0.6,
    evidence: {
      position: agentEvidence(mutation.reason),
      width: agentEvidence(mutation.reason),
      connectivity: agentEvidence(mutation.reason)
    }
  });
}

/**
 * Produce the candidate scene for a mutation. This is deliberately allowed to
 * build an *invalid* scene — judging that is the gate's job, not ours.
 */
function applyMutation(scene: SpatialScene, mutation: SceneMutation): unknown {
  const draft = clone(scene);

  switch (mutation.kind) {
    case "set-door-accessible":
      applyDoorAccessible(draft, mutation);
      break;
    case "set-door-width":
      applyDoorWidth(draft, mutation);
      break;
    case "relabel":
      applyRelabel(draft, mutation);
      break;
    case "add-landmark":
      applyAddLandmark(draft, mutation);
      break;
    case "add-door":
      applyAddDoor(draft, mutation);
      break;
  }

  return draft;
}

function diffAccessibility(before: SpatialScene, after: SpatialScene): AccessibilityImpact {
  const previous = accessibilitySummary(before);
  const next = accessibilitySummary(after);
  const previousReachable = new Set(previous.reachable);
  const nextReachable = new Set(next.reachable);
  const previousBlockedDoors = new Set(previous.inaccessibleDoors);

  return {
    lostStepFree: previous.reachable.filter((label) => !nextReachable.has(label)),
    gainedStepFree: next.reachable.filter((label) => !previousReachable.has(label)),
    newlyBlockedDoors: next.inaccessibleDoors.filter((label) => !previousBlockedDoors.has(label))
  };
}

/**
 * Run a proposed mutation through the same Zod topology gate that guards every
 * other write in Spatialize. Nothing here trusts the caller.
 */
export function gateMutation(scene: SpatialScene, mutation: SceneMutation): GateVerdict {
  const candidate = applyMutation(scene, mutation);
  const parsed = SpatialSceneSchema.safeParse(candidate);

  if (!parsed.success) {
    return {
      status: "refused",
      mutation,
      violations: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  }

  return {
    status: "accepted",
    scene: parsed.data,
    mutation,
    impact: diffAccessibility(scene, parsed.data)
  };
}

/** One-line human summary of a mutation, used in the log and the review queue. */
export function describeMutation(scene: SpatialScene, mutation: SceneMutation): string {
  const doorLabel = (id: string) => scene.doors.find((item) => item.id === id)?.label ?? id;

  switch (mutation.kind) {
    case "set-door-accessible":
      return mutation.accessible
        ? `Mark "${doorLabel(mutation.doorId)}" as step-free again`
        : `Mark "${doorLabel(mutation.doorId)}" as not step-free`;
    case "set-door-width":
      return `Set "${doorLabel(mutation.doorId)}" clear width to ${mutation.width} m`;
    case "relabel": {
      const current =
        collectionFor(scene, mutation.entityKind).find((item) => item.id === mutation.entityId)
          ?.label ?? mutation.entityId;
      return `Rename ${mutation.entityKind} "${current}" to "${mutation.label}"`;
    }
    case "add-landmark":
      return `Add ${mutation.landmarkType} "${mutation.label}" at ${mutation.position
        .map((value) => value.toFixed(1))
        .join(", ")}`;
    case "add-door": {
      const roomLabel = (id: string) =>
        id === "outside" ? "outside" : (scene.rooms.find((item) => item.id === id)?.label ?? id);
      return (
        `Add ${mutation.accessible ? "step-free " : ""}doorway "${mutation.label}" between ` +
        `${roomLabel(mutation.connects[0])} and ${roomLabel(mutation.connects[1])}`
      );
    }
    default:
      return "Unknown change";
  }
}
