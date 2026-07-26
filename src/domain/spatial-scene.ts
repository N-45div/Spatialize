import { z } from "zod";

export const PointSchema = z.tuple([z.number(), z.number()]);

export const RoomSchema = z.object({
  id: z.string(),
  label: z.string(),
  polygon: z.array(PointSchema).min(3),
  elevation: z.number().default(0),
  confidence: z.number().min(0).max(1),
  category: z.enum(["public", "service", "circulation", "restricted"])
});

export const LandmarkSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["entrance", "elevator", "stairs", "restroom", "destination"]),
  position: PointSchema,
  confidence: z.number().min(0).max(1)
});

export const RouteNodeSchema = z.object({
  id: z.string(),
  position: PointSchema,
  landmarkId: z.string().optional()
});

export const RouteEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  distance: z.number().positive(),
  accessible: z.boolean()
});

export const SpatialSceneSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  units: z.literal("meters"),
  sourceAsset: z.string(),
  rooms: z.array(RoomSchema),
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

export type Point = z.infer<typeof PointSchema>;
export type SpatialScene = z.infer<typeof SpatialSceneSchema>;
