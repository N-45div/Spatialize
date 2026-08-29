import type { SpatialScene } from "../domain/spatial-scene";
import { planRoute } from "../webmcp/queries";

/**
 * The step-free route from the main entrance to a landmark, as positions to
 * draw, or nothing when no step-free route exists. A thin wrapper over the
 * same planner the agent tools use, so the drawn route and the agent's
 * answer come from one computation.
 */
export function routeToLandmark(scene: SpatialScene, landmarkId: string) {
  const { plan, fallbackUsed } = planRoute(scene, { to: landmarkId, stepFree: true });
  return plan.found && !fallbackUsed ? plan.positions : [];
}
