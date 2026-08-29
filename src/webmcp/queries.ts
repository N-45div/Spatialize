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

/** Extraction confidence below which a measurement is reported as unconfirmed. */
export const CONFIDENCE_FLOOR = 0.85;

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

/**
 * Letters and digits in any script survive; everything else becomes a space.
 * A label written in Japanese must not normalise to the empty string, or it
 * would match every query that reaches the fallback matchers.
 */
function normalise(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Match on id first, then exact label, then a label that contains the query.
 * There is deliberately no "query contains the label" fallback: it made a
 * query for "Quiet-room doorway" resolve to the room called "Quiet room".
 */
function matchByIdOrLabel<T extends { id: string; label: string }>(
  items: T[],
  query: string
): T | null {
  const wanted = normalise(query);
  if (!wanted) return null;
  return (
    items.find((item) => normalise(item.id) === wanted) ??
    items.find((item) => normalise(item.label) === wanted) ??
    items.find((item) => {
      const label = normalise(item.label);
      return label !== "" && label.includes(wanted);
    }) ??
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
  // A node with no landmark must never match a venue with no entrance:
  // `undefined === undefined` would quietly start every route from it.
  return (
    scene.routeGraph.nodes.find(
      (node) =>
        Boolean(node.landmarkId) &&
        (node.landmarkId === entrance?.id || node.landmarkId === "entrance")
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

function adjacency(scene: SpatialScene, stepFree: boolean) {
  const neighbours = new Map<string, { node: string; edge: RouteEdge }[]>();
  for (const edge of scene.routeGraph.edges) {
    if (stepFree && !edge.accessible) continue;
    (neighbours.get(edge.from) ?? neighbours.set(edge.from, []).get(edge.from)!).push({
      node: edge.to,
      edge
    });
    (neighbours.get(edge.to) ?? neighbours.set(edge.to, []).get(edge.to)!).push({
      node: edge.from,
      edge
    });
  }
  return neighbours;
}

function dijkstra(scene: SpatialScene, startId: string, targetId: string, stepFree: boolean) {
  const nodes = new Map(scene.routeGraph.nodes.map((node) => [node.id, node]));
  const neighbours = adjacency(scene, stepFree);

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

    for (const { node: neighbour, edge } of neighbours.get(current) ?? []) {
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

export interface PlannedRoute {
  plan: RoutePlan;
  from: Landmark | null;
  to: Landmark | null;
  fallbackUsed: boolean;
  /** A starting point was asked for and nothing in the venue matched it. */
  fromUnresolved: boolean;
}

/**
 * Plan a route between two landmarks. When stepFree is asked for and no such
 * route exists, we deliberately fall back to the unrestricted graph so the
 * caller can be told which door is the barrier rather than a bare refusal.
 */
export function planRoute(
  scene: SpatialScene,
  options: { from?: string | null; to: string; stepFree?: boolean }
): PlannedRoute {
  const target = resolveLandmark(scene, options.to);
  const origin = options.from ? resolveLandmark(scene, options.from) : null;
  const fromUnresolved = Boolean(options.from) && origin === null;
  const base = { from: origin, to: target, fallbackUsed: false, fromUnresolved };

  if (!target || fromUnresolved) return { ...base, plan: EMPTY_PLAN };

  const startNode = origin ? nodeForLandmark(scene, origin) : entranceNode(scene);
  const targetNode = nodeForLandmark(scene, target);
  if (!startNode || !targetNode) return { ...base, plan: EMPTY_PLAN };

  const stepFree = options.stepFree ?? true;
  const direct = dijkstra(scene, startNode.id, targetNode.id, stepFree);
  if (direct) return { ...base, plan: toPlan(scene, direct, stepFree) };

  if (!stepFree) return { ...base, plan: EMPTY_PLAN };

  const anyRoute = dijkstra(scene, startNode.id, targetNode.id, false);
  if (!anyRoute) return { ...base, plan: EMPTY_PLAN };
  return { ...base, plan: toPlan(scene, anyRoute, false), fallbackUsed: true };
}

/**
 * Every landmark reachable from the main entrance without steps, by id. One
 * search from the entrance, not one per landmark — the same rule the server
 * applies when it computes a proposal's impact.
 */
export function stepFreeReachableIds(scene: SpatialScene): Set<string> {
  const start = entranceNode(scene);
  if (!start) return new Set();
  const neighbours = adjacency(scene, true);
  const seen = new Set<string>([start.id]);
  const frontier = [start.id];
  while (frontier.length) {
    const current = frontier.pop()!;
    for (const { node } of neighbours.get(current) ?? []) {
      if (!seen.has(node)) {
        seen.add(node);
        frontier.push(node);
      }
    }
  }
  return new Set(
    scene.landmarks
      .filter((item) => item.type !== "entrance")
      .filter((item) => {
        const node = nodeForLandmark(scene, item);
        return node !== null && seen.has(node.id);
      })
      .map((item) => item.id)
  );
}

/** Which destinations are reachable step-free from the main entrance. */
export function accessibilitySummary(scene: SpatialScene) {
  const reachableIds = stepFreeReachableIds(scene);
  const reachable: string[] = [];
  const blocked: { label: string; blockers: string[] }[] = [];

  for (const landmark of scene.landmarks) {
    if (landmark.type === "entrance") continue;
    if (reachableIds.has(landmark.id)) {
      reachable.push(landmark.label);
      continue;
    }
    // Only the blocked ones need the more expensive search, to name the barrier.
    const { plan, fallbackUsed } = planRoute(scene, { to: landmark.id, stepFree: true });
    blocked.push({
      label: landmark.label,
      blockers: plan.found && fallbackUsed ? plan.blockers.map((item) => item.doorLabel) : []
    });
  }

  return {
    reachable,
    reachableIds,
    blocked,
    inaccessibleDoors: scene.doors.filter((door) => !door.accessible).map((door) => door.label),
    inaccessibleDoorIds: new Set(scene.doors.filter((door) => !door.accessible).map((door) => door.id)),
    narrowDoors: scene.doors
      .filter((door) => door.width < 0.85)
      .map((door) => ({ label: door.label, width: door.width }))
  };
}

/** Entities the extraction was unsure about, plus any open review issues. */
export function dataIssues(scene: SpatialScene, threshold = CONFIDENCE_FLOOR) {
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

/** Closest points between two segments, and the distance between them. */
function closestBetweenSegments(a0: Point, a1: Point, b0: Point, b1: Point) {
  // Sample each segment finely enough that the answer is within a couple of
  // centimetres, which is well inside the gate's 15 cm boundary tolerance.
  // Exact segment-segment distance is more code than this earns.
  const steps = 40;
  let best = { point: a0, gap: Infinity };
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const a: Point = [a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t];
    for (let j = 0; j <= steps; j += 1) {
      const u = j / steps;
      const b: Point = [b0[0] + (b1[0] - b0[0]) * u, b0[1] + (b1[1] - b0[1]) * u];
      const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gap < best.gap) best = { point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], gap };
    }
  }
  return best;
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
  let best: { point: Point; gap: number } = { point: roomA.polygon[0], gap: Infinity };
  for (let i = 0; i < roomA.polygon.length; i += 1) {
    const a0 = roomA.polygon[i];
    const a1 = roomA.polygon[(i + 1) % roomA.polygon.length];
    for (let j = 0; j < roomB.polygon.length; j += 1) {
      const b0 = roomB.polygon[j];
      const b1 = roomB.polygon[(j + 1) % roomB.polygon.length];
      const candidate = closestBetweenSegments(a0, a1, b0, b1);
      if (candidate.gap < best.gap) best = candidate;
    }
  }
  return best;
}

export function formatMetres(value: number) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} m`;
}
