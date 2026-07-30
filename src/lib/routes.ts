import type { SpatialScene } from "../domain/spatial-scene";

export function routeToLandmark(scene: SpatialScene, landmarkId: string) {
  const nodes = new Map(scene.routeGraph.nodes.map((node) => [node.id, node]));
  const entrance = scene.landmarks.find((item) => item.type === "entrance");
  const start = scene.routeGraph.nodes.find(
    (node) => node.landmarkId === entrance?.id || node.landmarkId === "entrance"
  );
  const target = scene.routeGraph.nodes.find((node) => node.landmarkId === landmarkId);
  if (!start || !target) return [];

  const distances = new Map<string, number>([[start.id, 0]]);
  const previous = new Map<string, string>();
  const remaining = new Set(nodes.keys());

  while (remaining.size) {
    const current = [...remaining].sort(
      (a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity)
    )[0];
    remaining.delete(current);
    if (current === target.id) break;

    for (const edge of scene.routeGraph.edges.filter(
      (item) => item.accessible && (item.from === current || item.to === current)
    )) {
      const neighbor = edge.from === current ? edge.to : edge.from;
      if (!remaining.has(neighbor)) continue;
      const candidate = (distances.get(current) ?? Infinity) + edge.distance;
      if (candidate < (distances.get(neighbor) ?? Infinity)) {
        distances.set(neighbor, candidate);
        previous.set(neighbor, current);
      }
    }
  }

  if (!distances.has(target.id)) return [];

  const path: string[] = [];
  let cursor: string | undefined = target.id;
  while (cursor) {
    path.unshift(cursor);
    if (cursor === start.id) break;
    cursor = previous.get(cursor);
  }
  return path.map((id) => nodes.get(id)!.position);
}
