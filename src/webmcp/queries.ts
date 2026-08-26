/**
 * Read-side engine for the WebMCP tool surface.
 *
 * Everything here is a pure function over a validated SpatialScene. That is the
 * whole point: an agent calling these tools cannot receive a sentence the
 * geometry does not support, because the sentences are computed from the
 * geometry rather than generated alongside it.
 */
import type { Point, SpatialScene } from "../domain/spatial-scene";

type Room = SpatialScene["rooms"][number];
type Door = SpatialScene["doors"][number];
type Landmark = SpatialScene["landmarks"][number];
type RouteNode = SpatialScene["routeGraph"]["nodes"][number];
type RouteEdge = SpatialScene["routeGraph"]["edges"][number];

export interface RouteStep {
  from: string;
  to: string;
  distance: number;
  accessible: boolean;
  doorId: string | null;
  doorLabel: string | null;
  doorWidth: number | null;
  fromRoom: string;
  toRoom: string;
}

export interface RoutePlan {
  found: boolean;
  stepFree: boolean;
  totalDistance: number;
  positions: Point[];
  steps: RouteStep[];
  /** Doors that force this route to be non-step-free. Empty on a clean route. */
  blockers: { doorId: string; doorLabel: string; between: [string, string] }[];
}

function normalise(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Match on id first, then exact label, then a contains-match on either side. */
function matchByIdOrLabel<T extends { id: string; label: string }>(
  items: T[],
  query: string
): T | null {
  const wanted = normalise(query);
  if (!wanted) return null;
  return (
    items.find((item) => normalise(item.id) === wanted) ??
    items.find((item) => normalise(item.label) === wanted) ??
    items.find((item) => normalise(item.label).includes(wanted)) ??
    items.find((item) => wanted.includes(normalise(item.label))) ??
    null
  );
}

export function resolveLandmark(scene: SpatialScene, query: string): Landmark | null {
  return matchByIdOrLabel(scene.landmarks, query);
}

export function resolveRoom(scene: SpatialScene, query: string): Room | null {
  return matchByIdOrLabel(scene.rooms, query);
}

export function resolveDoor(scene: SpatialScene, query: string): Door | null {
  return matchByIdOrLabel(scene.doors, query);
}

/** Shoelace area of a room polygon, in square metres. */
export function polygonArea(polygon: Point[]): number {
  const twiceArea = polygon.reduce((total, [x, z], index) => {
    const [nextX, nextZ] = polygon[(index + 1) % polygon.length];
    return total + (x * nextZ - nextX * z);
  }, 0);
  return Math.abs(twiceArea) / 2;
}

/** Rooms reachable from roomId through exactly one door. */
export function adjacentRooms(scene: SpatialScene, roomId: string) {
  return scene.doors
    .filter((door) => door.connects.includes(roomId))
    .map((door) => {
      const other = door.connects.find((side) => side !== roomId) ?? door.connects[0];
      const room = scene.rooms.find((item) => item.id === other);
      return {
        roomId: other,
        roomLabel: room?.label ?? (other === "outside" ? "Outside" : other),
        doorId: door.id,
        doorLabel: door.label,
        doorWidth: door.width,
        accessible: door.accessible
      };
    });
}

function entranceNode(scene: SpatialScene): RouteNode | null {
  const entrance = scene.landmarks.find((item) => item.type === "entrance");
  return (
    scene.routeGraph.nodes.find(
      (node) => node.landmarkId === entrance?.id || node.landmarkId === "entrance"
    ) ?? null
  );
}

/** Nearest route node to an arbitrary point, used when a landmark has no node. */
function nearestNode(scene: SpatialScene, position: Point): RouteNode | null {
  let best: RouteNode | null = null;
  let bestDistance = Infinity;
  for (const node of scene.routeGraph.nodes) {
    const distance = Math.hypot(node.position[0] - position[0], node.position[1] - position[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

function nodeForLandmark(scene: SpatialScene, landmark: Landmark): RouteNode | null {
  return (
    scene.routeGraph.nodes.find((node) => node.landmarkId === landmark.id) ??
    nearestNode(scene, landmark.position)
  );
}

function dijkstra(scene: SpatialScene, startId: string, targetId: string, stepFree: boolean) {
  const nodes = new Map(scene.routeGraph.nodes.map((node) => [node.id, node]));
  const usable = scene.routeGraph.edges.filter((edge) => (stepFree ? edge.accessible : true));

  const distances = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, { node: string; edge: RouteEdge }>();
  const remaining = new Set(nodes.keys());

  while (remaining.size) {
    let current: string | null = null;
    let currentDistance = Infinity;
    for (const candidate of remaining) {
      const distance = distances.get(candidate) ?? Infinity;
      if (distance < currentDistance) {
        currentDistance = distance;
        current = candidate;
      }
    }
    if (current === null || currentDistance === Infinity) break;
    remaining.delete(current);
    if (current === targetId) break;

    for (const edge of usable) {
      if (edge.from !== current && edge.to !== current) continue;
      const neighbour = edge.from === current ? edge.to : edge.from;
      if (!remaining.has(neighbour)) continue;
      const candidate = currentDistance + edge.distance;
      if (candidate < (distances.get(neighbour) ?? Infinity)) {
        distances.set(neighbour, candidate);
        previous.set(neighbour, { node: current, edge });
      }
    }
  }

  if (!distances.has(targetId)) return null;

  const chain: { node: RouteNode; edge: RouteEdge | null }[] = [];
  let cursor: string | undefined = targetId;
  while (cursor) {
    const step = previous.get(cursor);
    chain.unshift({ node: nodes.get(cursor)!, edge: step?.edge ?? null });
    if (cursor === startId) break;
    cursor = step?.node;
  }
  return chain;
}

function toPlan(
  scene: SpatialScene,
  chain: { node: RouteNode; edge: RouteEdge | null }[],
  stepFree: boolean
): RoutePlan {
  const doors = new Map(scene.doors.map((door) => [door.id, door]));
  const rooms = new Map(scene.rooms.map((room) => [room.id, room.label]));
  const steps: RouteStep[] = [];
  const blockers: RoutePlan["blockers"] = [];

  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1].node;
    const current = chain[index].node;
    const edge = chain[index].edge;
    const door = edge?.doorId ? doors.get(edge.doorId) ?? null : null;

    steps.push({
      from: previous.id,
      to: current.id,
      distance:
        edge?.distance ??
        Math.hypot(
          current.position[0] - previous.position[0],
          current.position[1] - previous.position[1]
        ),
      accessible: edge?.accessible ?? true,
      doorId: door?.id ?? null,
      doorLabel: door?.label ?? null,
      doorWidth: door?.width ?? null,
      fromRoom: rooms.get(previous.roomId) ?? previous.roomId,
      toRoom: rooms.get(current.roomId) ?? current.roomId
    });

    if (door && !door.accessible) {
      blockers.push({
        doorId: door.id,
        doorLabel: door.label,
        between: [
          rooms.get(previous.roomId) ?? previous.roomId,
          rooms.get(current.roomId) ?? current.roomId
        ]
      });
    }
  }

  return {
    found: true,
    stepFree,
    totalDistance: steps.reduce((total, step) => total + step.distance, 0),
    positions: chain.map((entry) => entry.node.position),
    steps,
    blockers
  };
}

const EMPTY_PLAN: RoutePlan = {
  found: false,
  stepFree: false,
  totalDistance: 0,
  positions: [],
  steps: [],
  blockers: []
};

/**
 * Plan a route between two landmarks. When stepFree is asked for and no such
 * route exists, we deliberately fall back to the unrestricted graph so the
 * caller can be told which door is the barrier rather than a bare refusal.
 */
export function planRoute(
  scene: SpatialScene,
  options: { from?: string | null; to: string; stepFree?: boolean }
): { plan: RoutePlan; from: Landmark | null; to: Landmark | null; fallbackUsed: boolean } {
  const target = resolveLandmark(scene, options.to);
  const origin = options.from ? resolveLandmark(scene, options.from) : null;
  if (!target) return { plan: EMPTY_PLAN, from: origin, to: null, fallbackUsed: false };

  const startNode = origin ? nodeForLandmark(scene, origin) : entranceNode(scene);
  const targetNode = nodeForLandmark(scene, target);
  if (!startNode || !targetNode) {
    return { plan: EMPTY_PLAN, from: origin, to: target, fallbackUsed: false };
  }

  const stepFree = options.stepFree ?? true;
  const direct = dijkstra(scene, startNode.id, targetNode.id, stepFree);
  if (direct) {
    return { plan: toPlan(scene, direct, stepFree), from: origin, to: target, fallbackUsed: false };
  }

  if (!stepFree) return { plan: EMPTY_PLAN, from: origin, to: target, fallbackUsed: false };

  const anyRoute = dijkstra(scene, startNode.id, targetNode.id, false);
  if (!anyRoute) return { plan: EMPTY_PLAN, from: origin, to: target, fallbackUsed: false };
  return { plan: toPlan(scene, anyRoute, false), from: origin, to: target, fallbackUsed: true };
}

/** Which destinations are reachable step-free from the main entrance. */
export function accessibilitySummary(scene: SpatialScene) {
  const reachable: string[] = [];
  const blocked: { label: string; blockers: string[] }[] = [];

  for (const landmark of scene.landmarks) {
    if (landmark.type === "entrance") continue;
    const { plan, fallbackUsed } = planRoute(scene, { to: landmark.id, stepFree: true });
    if (plan.found && !fallbackUsed) reachable.push(landmark.label);
    else if (plan.found) {
      blocked.push({ label: landmark.label, blockers: plan.blockers.map((item) => item.doorLabel) });
    } else blocked.push({ label: landmark.label, blockers: [] });
  }

  return {
    reachable,
    blocked,
    inaccessibleDoors: scene.doors.filter((door) => !door.accessible).map((door) => door.label),
    narrowDoors: scene.doors
      .filter((door) => door.width < 0.85)
      .map((door) => ({ label: door.label, width: door.width }))
  };
}

/** Entities the extraction was unsure about, plus any open review issues. */
export function dataIssues(scene: SpatialScene, threshold = 0.85) {
  const lowConfidence = [
    ...scene.rooms.map((item) => ({
      kind: "room" as const,
      id: item.id,
      label: item.label,
      confidence: item.confidence
    })),
    ...scene.doors.map((item) => ({
      kind: "door" as const,
      id: item.id,
      label: item.label,
      confidence: item.confidence
    })),
    ...scene.landmarks.map((item) => ({
      kind: "landmark" as const,
      id: item.id,
      label: item.label,
      confidence: item.confidence
    }))
  ].filter((item) => item.confidence < threshold);

  return {
    reviewStatus: scene.review.status,
    openIssues: scene.review.issues,
    lowConfidence
  };
}

/**
 * Area centroid of a room. Lets a caller name a room instead of inventing
 * coordinates — agents are poor at arithmetic and good at names.
 */
export function roomCentroid(polygon: Point[]): Point {
  let twiceArea = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x0, z0] = polygon[index];
    const [x1, z1] = polygon[(index + 1) % polygon.length];
    const cross = x0 * z1 - x1 * z0;
    twiceArea += cross;
    x += (x0 + x1) * cross;
    z += (z0 + z1) * cross;
  }
  if (twiceArea === 0) {
    return [
      polygon.reduce((total, point) => total + point[0], 0) / polygon.length,
      polygon.reduce((total, point) => total + point[1], 0) / polygon.length
    ];
  }
  return [x / (3 * twiceArea), z / (3 * twiceArea)];
}

/** Sample points along a polygon boundary at roughly `step` metre intervals. */
function sampleBoundary(polygon: Point[], step = 0.25): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const [x0, z0] = polygon[index];
    const [x1, z1] = polygon[(index + 1) % polygon.length];
    const length = Math.hypot(x1 - x0, z1 - z0);
    const count = Math.max(1, Math.ceil(length / step));
    for (let part = 0; part < count; part += 1) {
      const t = part / count;
      points.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  }
  return points;
}

/**
 * Where a doorway between two rooms would have to sit, and how far apart their
 * walls actually are. A non-zero gap means the rooms do not touch, which the
 * topology gate will reject — we place the best candidate and let it decide
 * rather than second-guessing the validator here.
 */
export function sharedBoundaryPoint(
  roomA: Room,
  roomB: Room
): { point: Point; gap: number } {
  const samplesA = sampleBoundary(roomA.polygon);
  const samplesB = sampleBoundary(roomB.polygon);

  let best: { point: Point; gap: number } = { point: samplesA[0], gap: Infinity };
  for (const a of samplesA) {
    for (const b of samplesB) {
      const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gap < best.gap) {
        best = { point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], gap };
      }
    }
  }
  return best;
}

export function formatMetres(value: number) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} m`;
}
