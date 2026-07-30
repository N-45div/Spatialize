"""Scene-grounded agent tools.

Every read answers from the validated scene; every write is applied to a
draft, revalidated by the full topology gate, and only then committed. The
agent can therefore phrase anything but geometrically break nothing.
"""

from __future__ import annotations

import copy
import difflib
import heapq
from dataclasses import dataclass, field
from math import hypot
from typing import Any

from pydantic import ValidationError

from ..models import SpatialScene


class ToolError(ValueError):
    """A recoverable tool failure whose message is meant for the agent."""


@dataclass
class RouteResult:
    node_ids: list[str]
    positions: list[tuple[float, float]]
    distance: float
    door_ids: list[str]
    step_free: bool


@dataclass
class Mutation:
    kind: str
    summary: str
    entity_id: str


@dataclass
class SceneSession:
    """One conversation's working copy of a scene, with a mutation log."""

    scene: dict[str, Any]
    spoken_quote: str = ""
    mutations: list[Mutation] = field(default_factory=list)

    # ---------- lookups ----------

    def _landmarks(self) -> list[dict[str, Any]]:
        return self.scene["landmarks"]

    def _rooms(self) -> dict[str, dict[str, Any]]:
        return {room["id"]: room for room in self.scene["rooms"]}

    def _doors(self) -> dict[str, dict[str, Any]]:
        return {door["id"]: door for door in self.scene["doors"]}

    def _nodes(self) -> dict[str, dict[str, Any]]:
        return {node["id"]: node for node in self.scene["routeGraph"]["nodes"]}

    def _landmark(self, landmark_id: str) -> dict[str, Any]:
        for item in self._landmarks():
            if item["id"] == landmark_id:
                return item
        raise ToolError(
            f"No landmark with id '{landmark_id}'. Known landmarks: "
            + ", ".join(f"{i['id']} ({i['label']})" for i in self._landmarks())
        )

    # ---------- read tools ----------

    def scene_overview(self) -> dict[str, Any]:
        scene = self.scene
        inaccessible = [d["id"] for d in scene["doors"] if not d["accessible"]]
        return {
            "name": scene["name"],
            "dimensionsMeters": scene["dimensions"],
            "rooms": [
                {"id": r["id"], "label": r["label"], "category": r["category"]}
                for r in scene["rooms"]
            ],
            "landmarkCount": len(scene["landmarks"]),
            "doorCount": len(scene["doors"]),
            "inaccessibleDoors": inaccessible,
            "reviewStatus": scene["review"]["status"],
            "openReviewIssues": len(scene["review"]["issues"]),
        }

    def list_landmarks(self) -> list[dict[str, Any]]:
        return [
            {
                "id": item["id"],
                "label": item["label"],
                "type": item["type"],
                "position": item["position"],
                "confidence": item["confidence"],
            }
            for item in self._landmarks()
        ]

    def resolve_landmark(self, query: str) -> dict[str, Any]:
        """Fuzzy-match a spoken phrase to a landmark; ambiguity is surfaced, not guessed."""
        query_lower = query.strip().lower()
        if not query_lower:
            raise ToolError("Empty landmark query")
        items = self._landmarks()
        exact = [
            i for i in items
            if query_lower in (i["id"].lower(), i["label"].lower(), i["type"].lower())
        ]
        if len(exact) == 1:
            return {"match": exact[0]["id"], "label": exact[0]["label"], "ambiguous": False}
        if len(exact) > 1:
            return {
                "ambiguous": True,
                "candidates": [{"id": i["id"], "label": i["label"]} for i in exact],
                "instruction": "Ask the user which one they mean before acting.",
            }
        corpus = {i["id"]: f"{i['label']} {i['type']}".lower() for i in items}
        scored = sorted(
            (
                (difflib.SequenceMatcher(None, query_lower, text).ratio(), landmark_id)
                for landmark_id, text in corpus.items()
            ),
            reverse=True,
        )
        best_score, best_id = scored[0]
        if best_score < 0.45:
            raise ToolError(
                f"Nothing in this venue matches '{query}'. Known landmarks: "
                + ", ".join(f"{i['label']} ({i['type']})" for i in items)
            )
        runner_up = scored[1] if len(scored) > 1 else None
        if runner_up and best_score - runner_up[0] < 0.08:
            return {
                "ambiguous": True,
                "candidates": [
                    {"id": best_id, "label": self._landmark(best_id)["label"]},
                    {"id": runner_up[1], "label": self._landmark(runner_up[1])["label"]},
                ],
                "instruction": "Ask the user which one they mean before acting.",
            }
        return {"match": best_id, "label": self._landmark(best_id)["label"], "ambiguous": False}

    def compute_route(
        self, from_landmark_id: str, to_landmark_id: str, accessible_only: bool = True
    ) -> RouteResult:
        nodes = self._nodes()
        start = next(
            (n for n in nodes.values() if n.get("landmarkId") == from_landmark_id), None
        )
        target = next(
            (n for n in nodes.values() if n.get("landmarkId") == to_landmark_id), None
        )
        if not start or not target:
            missing = from_landmark_id if not start else to_landmark_id
            raise ToolError(f"Landmark '{missing}' is not connected to the route graph")

        adjacency: dict[str, list[tuple[str, float, dict[str, Any]]]] = {}
        for edge in self.scene["routeGraph"]["edges"]:
            if accessible_only and not edge["accessible"]:
                continue
            adjacency.setdefault(edge["from"], []).append((edge["to"], edge["distance"], edge))
            adjacency.setdefault(edge["to"], []).append((edge["from"], edge["distance"], edge))

        distances: dict[str, float] = {start["id"]: 0.0}
        previous: dict[str, tuple[str, dict[str, Any]]] = {}
        queue: list[tuple[float, str]] = [(0.0, start["id"])]
        visited: set[str] = set()
        while queue:
            cost, current = heapq.heappop(queue)
            if current in visited:
                continue
            visited.add(current)
            if current == target["id"]:
                break
            for neighbor, weight, edge in adjacency.get(current, []):
                candidate = cost + weight
                if candidate < distances.get(neighbor, float("inf")):
                    distances[neighbor] = candidate
                    previous[neighbor] = (current, edge)
                    heapq.heappush(queue, (candidate, neighbor))

        if target["id"] not in distances:
            kind = "step-free" if accessible_only else "any"
            raise ToolError(
                f"No {kind} route exists from '{from_landmark_id}' to '{to_landmark_id}'"
            )

        path = [target["id"]]
        door_ids: list[str] = []
        edges_used: list[dict[str, Any]] = []
        while path[-1] != start["id"]:
            parent, edge = previous[path[-1]]
            path.append(parent)
            edges_used.append(edge)
            if edge.get("doorId"):
                door_ids.append(edge["doorId"])
        path.reverse()
        return RouteResult(
            node_ids=path,
            positions=[tuple(nodes[node_id]["position"]) for node_id in path],
            distance=distances[target["id"]],
            door_ids=list(reversed(door_ids)),
            step_free=all(edge["accessible"] for edge in edges_used),
        )

    def describe_route(self, from_landmark_id: str, to_landmark_id: str) -> dict[str, Any]:
        route = self.compute_route(from_landmark_id, to_landmark_id, accessible_only=True)
        nodes = self._nodes()
        rooms = self._rooms()
        doors = self._doors()
        legs: list[str] = []
        for index in range(len(route.node_ids) - 1):
            here = nodes[route.node_ids[index]]
            there = nodes[route.node_ids[index + 1]]
            distance = hypot(
                there["position"][0] - here["position"][0],
                there["position"][1] - here["position"][1],
            )
            if here["roomId"] != there["roomId"]:
                door_label = next(
                    (
                        doors[d]["label"]
                        for d in route.door_ids
                        if set(doors[d]["connects"]) >= {here["roomId"], there["roomId"]}
                    ),
                    "a doorway",
                )
                legs.append(
                    f"Continue {distance:.0f} metres and pass through {door_label} "
                    f"into {rooms[there['roomId']]['label']}."
                )
            else:
                legs.append(f"Continue {distance:.0f} metres through {rooms[here['roomId']]['label']}.")
        return {
            "totalDistanceMeters": round(route.distance, 1),
            "stepFree": route.step_free,
            "doorsUsed": [doors[d]["label"] for d in route.door_ids],
            "legs": legs,
        }

    def spatial_context(self, landmark_id: str) -> dict[str, Any]:
        landmark = self._landmark(landmark_id)
        rooms = self._rooms()
        room = next(
            (
                r
                for n in self._nodes().values()
                if n.get("landmarkId") == landmark_id
                for r in [rooms.get(n["roomId"])]
                if r
            ),
            None,
        )
        x, z = landmark["position"]
        neighbors = sorted(
            (
                (hypot(i["position"][0] - x, i["position"][1] - z), i)
                for i in self._landmarks()
                if i["id"] != landmark_id
            ),
            key=lambda pair: pair[0],
        )[:3]
        return {
            "landmark": {"id": landmark["id"], "label": landmark["label"], "type": landmark["type"]},
            "room": {"id": room["id"], "label": room["label"], "category": room["category"]}
            if room
            else None,
            "nearby": [
                {"id": i["id"], "label": i["label"], "distanceMeters": round(d, 1)}
                for d, i in neighbors
            ],
        }

    def scene_confidence(self, entity_id: str | None = None) -> dict[str, Any]:
        entities = self.scene["rooms"] + self.scene["doors"] + self.scene["landmarks"]
        if entity_id:
            entity = next((e for e in entities if e["id"] == entity_id), None)
            if not entity:
                raise ToolError(f"No entity '{entity_id}' in the scene")
            return {"id": entity_id, "confidence": entity["confidence"], "evidence": entity["evidence"]}
        low = [
            {"id": e["id"], "label": e["label"], "confidence": e["confidence"]}
            for e in entities
            if e["confidence"] < 0.85
        ]
        return {"lowConfidenceEntities": low, "reviewIssues": self.scene["review"]["issues"]}

    # ---------- gated mutations ----------

    def _commit(self, draft: dict[str, Any], mutation: Mutation) -> dict[str, Any]:
        try:
            SpatialScene.model_validate(draft)
        except ValidationError as error:
            failures = "; ".join(
                f"{'.'.join(str(p) for p in issue['loc'])}: {issue['msg']}"
                for issue in error.errors()[:5]
            )
            raise ToolError(
                f"The topology gate rejected this change: {failures}. "
                "Adjust the change (for example pick a different position) or use "
                "add_review_note instead."
            ) from error
        draft["review"]["status"] = "needs-review"
        self.scene = draft
        self.mutations.append(mutation)
        return {"committed": True, "change": mutation.summary, "pendingHumanReview": True}

    def _human_evidence(self) -> dict[str, Any]:
        note = (self.spoken_quote or "voice edit")[:240]
        stamp = {"confidence": 0.9, "method": "human", "note": note}
        return {"label": dict(stamp), "geometry": dict(stamp)}

    def _room_interior_point(
        self, room: dict[str, Any], near: tuple[float, float] | None
    ) -> tuple[float, float]:
        xs = [p[0] for p in room["polygon"]]
        zs = [p[1] for p in room["polygon"]]
        centroid = (sum(xs) / len(xs), sum(zs) / len(zs))
        if near is None:
            return centroid
        # Pull the requested point 30% toward the centroid so it lands inside.
        return (
            near[0] + (centroid[0] - near[0]) * 0.3,
            near[1] + (centroid[1] - near[1]) * 0.3,
        )

    def add_landmark(
        self,
        label: str,
        landmark_type: str,
        room_id: str | None = None,
        near_landmark_id: str | None = None,
    ) -> dict[str, Any]:
        if landmark_type not in {"entrance", "elevator", "stairs", "restroom", "destination"}:
            raise ToolError(
                "landmark_type must be one of entrance, elevator, stairs, restroom, destination"
            )
        rooms = self._rooms()
        nodes = self._nodes()
        anchor: tuple[float, float] | None = None
        if near_landmark_id:
            near = self._landmark(near_landmark_id)
            anchor = tuple(near["position"])
            anchor_node = next(
                (n for n in nodes.values() if n.get("landmarkId") == near_landmark_id), None
            )
            if room_id is None and anchor_node:
                room_id = anchor_node["roomId"]
        if room_id is None or room_id not in rooms:
            raise ToolError(
                "Specify which room the landmark belongs in. Rooms: "
                + ", ".join(f"{r['id']} ({r['label']})" for r in rooms.values())
            )
        room = rooms[room_id]
        position = self._room_interior_point(room, anchor)

        base_id = "-".join(label.lower().split()) or "landmark"
        new_id = base_id
        suffix = 2
        existing_ids = {i["id"] for i in self._landmarks()}
        while new_id in existing_ids:
            new_id = f"{base_id}-{suffix}"
            suffix += 1

        # Landmarks must sit clear of existing ones.
        for other in self._landmarks():
            if hypot(other["position"][0] - position[0], other["position"][1] - position[1]) < 0.6:
                position = self._room_interior_point(room, None)
                break

        draft = copy.deepcopy(self.scene)
        draft["landmarks"].append(
            {
                "id": new_id,
                "label": label,
                "type": landmark_type,
                "position": list(position),
                "confidence": 0.9,
                "evidence": self._human_evidence(),
            }
        )
        # Keep the route graph connected: snap a node in and link it to the
        # nearest same-room node so the new landmark is immediately routable.
        same_room = [n for n in nodes.values() if n["roomId"] == room_id]
        node_id = f"n-{new_id}"
        draft["routeGraph"]["nodes"].append(
            {"id": node_id, "position": list(position), "roomId": room_id, "landmarkId": new_id}
        )
        if same_room:
            nearest = min(
                same_room,
                key=lambda n: hypot(
                    n["position"][0] - position[0], n["position"][1] - position[1]
                ),
            )
            distance = hypot(
                nearest["position"][0] - position[0], nearest["position"][1] - position[1]
            )
            draft["routeGraph"]["edges"].append(
                {
                    "from": nearest["id"],
                    "to": node_id,
                    "distance": max(distance, 0.1),
                    "accessible": True,
                }
            )
        result = self._commit(
            draft,
            Mutation("add-landmark", f"Added {landmark_type} '{label}' in {room['label']}", new_id),
        )
        result["landmarkId"] = new_id
        return result

    def rename_entity(self, entity_id: str, new_label: str) -> dict[str, Any]:
        if not new_label.strip():
            raise ToolError("The new label is empty")
        draft = copy.deepcopy(self.scene)
        for collection in (draft["rooms"], draft["doors"], draft["landmarks"]):
            for entity in collection:
                if entity["id"] == entity_id:
                    old = entity["label"]
                    entity["label"] = new_label.strip()
                    return self._commit(
                        draft,
                        Mutation("rename", f"Renamed '{old}' to '{new_label.strip()}'", entity_id),
                    )
        raise ToolError(f"No entity '{entity_id}' in the scene")

    def set_door_accessibility(self, door_id: str, accessible: bool) -> dict[str, Any]:
        draft = copy.deepcopy(self.scene)
        door = next((d for d in draft["doors"] if d["id"] == door_id), None)
        if not door:
            known = ", ".join(d["id"] for d in draft["doors"])
            raise ToolError(f"No door with id '{door_id}'. Doors: {known}")
        door["accessible"] = accessible
        cascaded = 0
        if not accessible:
            for edge in draft["routeGraph"]["edges"]:
                if edge.get("doorId") == door_id and edge["accessible"]:
                    edge["accessible"] = False
                    cascaded += 1
        result = self._commit(
            draft,
            Mutation(
                "door-accessibility",
                f"Marked door '{door['label']}' {'accessible' if accessible else 'not accessible'}",
                door_id,
            ),
        )
        # Surface any destination that just lost its only step-free route.
        severed: list[str] = []
        entrance = next(
            (i["id"] for i in self._landmarks() if i["type"] == "entrance"), None
        )
        if entrance and not accessible:
            for item in self._landmarks():
                if item["id"] == entrance:
                    continue
                try:
                    self.compute_route(entrance, item["id"], accessible_only=True)
                except ToolError:
                    severed.append(item["label"])
        result["accessibleEdgesDisabled"] = cascaded
        result["destinationsWithoutStepFreeRoute"] = severed
        if severed:
            result["warning"] = (
                "Tell the user: this change leaves "
                + ", ".join(severed)
                + " without any step-free route."
            )
        return result

    def set_room_category(self, room_id: str, category: str) -> dict[str, Any]:
        if category not in {"public", "service", "circulation", "restricted"}:
            raise ToolError("category must be public, service, circulation, or restricted")
        draft = copy.deepcopy(self.scene)
        room = next((r for r in draft["rooms"] if r["id"] == room_id), None)
        if not room:
            raise ToolError(f"No room '{room_id}' in the scene")
        room["category"] = category
        return self._commit(
            draft,
            Mutation("room-category", f"Set {room['label']} to {category}", room_id),
        )

    def add_review_note(self, entity_id: str, message: str) -> dict[str, Any]:
        draft = copy.deepcopy(self.scene)
        issue_id = f"voice-note-{len(draft['review']['issues']) + 1}"
        draft["review"]["issues"].append(
            {"id": issue_id, "message": message[:300], "severity": "medium"}
        )
        return self._commit(
            draft, Mutation("review-note", f"Flagged for review: {message[:80]}", entity_id)
        )
