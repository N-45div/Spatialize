import { z } from "zod";

export const PointSchema = z.tuple([z.number(), z.number()]);
const UnitInterval = z.number().min(0).max(1);
const SourceRegionSchema = z.tuple([UnitInterval, UnitInterval, UnitInterval, UnitInterval])
  .refine(([xMin, yMin, xMax, yMax]) => xMin < xMax && yMin < yMax, {
    message: "Source region must have ordered, non-zero bounds"
  });

export const ExtractionEvidenceSchema = z.object({
  confidence: UnitInterval,
  method: z.enum(["model", "human", "derived"]),
  sourceRegion: SourceRegionSchema.nullish(),
  note: z.string().max(240).nullish()
});

const EntityEvidenceSchema = z.object({
  label: ExtractionEvidenceSchema,
  geometry: ExtractionEvidenceSchema
});

export const RoomSchema = z.object({
  id: z.string(),
  label: z.string(),
  polygon: z.array(PointSchema).min(3),
  elevation: z.number().default(0),
  confidence: UnitInterval,
  category: z.enum(["public", "service", "circulation", "restricted"]),
  evidence: EntityEvidenceSchema
});

export const LandmarkSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["entrance", "elevator", "stairs", "restroom", "destination"]),
  position: PointSchema,
  confidence: UnitInterval,
  evidence: EntityEvidenceSchema
});

export const DoorSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: PointSchema,
  width: z.number().positive().max(8),
  rotation: z.number(),
  connects: z.tuple([z.string(), z.string()]),
  accessible: z.boolean(),
  confidence: UnitInterval,
  evidence: z.object({
    position: ExtractionEvidenceSchema,
    width: ExtractionEvidenceSchema,
    connectivity: ExtractionEvidenceSchema
  })
});

export const RouteNodeSchema = z.object({
  id: z.string(),
  position: PointSchema,
  roomId: z.string(),
  landmarkId: z.string().nullish()
});

export const RouteEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  distance: z.number().positive(),
  accessible: z.boolean(),
  doorId: z.string().nullish()
});

const SpatialSceneObjectSchema = z.object({
  schemaVersion: z.literal("1.1"),
  id: z.string(),
  name: z.string(),
  units: z.literal("meters"),
  sourceAsset: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  dimensions: z.object({
    width: z.number().positive(),
    depth: z.number().positive(),
    ceilingHeight: z.number().positive()
  }),
  sourceTransform: z.object({
    widthPixels: z.number().int().positive(),
    heightPixels: z.number().int().positive(),
    metersPerPixel: PointSchema,
    origin: PointSchema,
    xAxis: z.literal("right"),
    zAxis: z.literal("down")
  }),
  extraction: z.object({
    runId: z.string(),
    provider: z.string(),
    model: z.string(),
    completedAt: z.string().datetime()
  }),
  rooms: z.array(RoomSchema),
  doors: z.array(DoorSchema),
  landmarks: z.array(LandmarkSchema),
  routeGraph: z.object({
    nodes: z.array(RouteNodeSchema),
    edges: z.array(RouteEdgeSchema)
  }),
  review: z.object({
    status: z.enum(["needs-review", "approved"]),
    issues: z.array(z.object({
      id: z.string(),
      message: z.string(),
      severity: z.enum(["low", "medium", "high"])
    }))
  })
});

function distanceToSegment(point: [number, number], start: [number, number], end: [number, number]) {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const lengthSquared = deltaX ** 2 + deltaZ ** 2;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const projection = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaZ) / lengthSquared
  ));
  return Math.hypot(
    point[0] - (start[0] + projection * deltaX),
    point[1] - (start[1] + projection * deltaZ)
  );
}

function distanceToBoundary(point: [number, number], polygon: [number, number][]) {
  return Math.min(...polygon.map((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    return distanceToSegment(point, start, end);
  }));
}

export const SpatialSceneSchema = SpatialSceneObjectSchema.superRefine((scene, context) => {
  const rooms = new Map(scene.rooms.map((room) => [room.id, room]));
  const doors = new Map(scene.doors.map((door) => [door.id, door]));
  const nodes = new Map(scene.routeGraph.nodes.map((node) => [node.id, node]));

  const addIssue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: "custom", path, message });
  };

  scene.rooms.forEach((room, roomIndex) => {
    room.polygon.forEach(([x, zValue], pointIndex) => {
      if (x < 0 || x > scene.dimensions.width || zValue < 0 || zValue > scene.dimensions.depth) {
        addIssue(["rooms", roomIndex, "polygon", pointIndex], "Room point is outside scene dimensions");
      }
    });
  });

  scene.doors.forEach((door, index) => {
    door.connects.forEach((roomId, side) => {
      if (roomId !== "outside" && !rooms.has(roomId)) {
        addIssue(["doors", index, "connects", side], `Door references unknown room "${roomId}"`);
        return;
      }
      const room = rooms.get(roomId);
      if (room && distanceToBoundary(door.position, room.polygon) > 0.15) {
        addIssue(["doors", index, "position"], `Door is not on the boundary of "${roomId}"`);
      }
    });
  });

  scene.routeGraph.nodes.forEach((node, index) => {
    if (!rooms.has(node.roomId)) {
      addIssue(["routeGraph", "nodes", index, "roomId"], `Route node references unknown room "${node.roomId}"`);
    }
  });

  scene.routeGraph.edges.forEach((edge, index) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) {
      addIssue(["routeGraph", "edges", index], "Route edge references an unknown node");
      return;
    }

    const measuredDistance = Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1]);
    if (Math.abs(measuredDistance - edge.distance) > Math.max(0.35, measuredDistance * 0.1)) {
      addIssue(["routeGraph", "edges", index, "distance"], "Route distance does not match node geometry");
    }

    if (from.roomId !== to.roomId) {
      const door = edge.doorId ? doors.get(edge.doorId) : undefined;
      if (!door) {
        addIssue(["routeGraph", "edges", index, "doorId"], "A cross-room route edge must reference a door");
        return;
      }
      const connectedRooms = new Set(door.connects);
      if (!connectedRooms.has(from.roomId) || !connectedRooms.has(to.roomId)) {
        addIssue(["routeGraph", "edges", index, "doorId"], "Door does not connect the route edge rooms");
      }
      if (distanceToSegment(door.position, from.position, to.position) > Math.max(0.4, door.width / 2)) {
        addIssue(["routeGraph", "edges", index, "doorId"], "Route edge does not pass through its referenced door");
      }
      if (edge.accessible && !door.accessible) {
        addIssue(["routeGraph", "edges", index, "accessible"], "Accessible route cannot use an inaccessible door");
      }
    }
  });
});

export type Point = z.infer<typeof PointSchema>;
export type SpatialScene = z.infer<typeof SpatialSceneSchema>;
