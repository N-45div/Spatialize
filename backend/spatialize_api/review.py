"""The review ledger: what agents proposed, what people decided, and why.

Every write an agent makes on behalf of a visitor lands here first. The client
runs the topology gate for fast feedback, but the client is not a security
boundary. So the server does not accept a candidate scene from the browser at
all: it takes the mutation — five fields — and applies it to its own copy of
the venue. A proposal therefore cannot carry anything its description does not
say, the topology validator runs on a scene the server built, and the impact a
reviewer sees is computed here.

A declined proposal is never deleted. Venue-published access information is
the least reliable source in the published survey data, so a venue that could
erase a first-hand report would be handing the least accurate party a veto
over the most accurate one. Declining records a disagreement.

Ledger writes for one run are serialised with a per-run lock. Two handlers
doing load-modify-save on the same JSON object without one lost writes every
time a proposal and its audit entry arrived together.
"""

import copy
import json
import re
import threading
from collections import defaultdict
from datetime import UTC, datetime
from math import hypot, isfinite
from typing import Any, Literal

from pydantic import Field, ValidationError

from .models import ApiModel, SpatialScene, StoredAsset
from .workflow import RunService, SceneRejected

LEDGER_CALL_CAP = 200
LABEL_LIMIT = 80
REASON_LIMIT = 240
# Placeholder width for a proposed doorway nobody measured. The scene schema
# requires a number; this one is never evidenced as an observation.
ASSUMED_DOOR_WIDTH = 0.9
LANDMARK_TYPES = ("entrance", "elevator", "stairs", "restroom", "destination")
ENTITY_KINDS = ("room", "door", "landmark")
ROOM_CATEGORIES = ("public", "service", "circulation", "restricted")
NOTE_LIMIT = 300


def sanitise_free_text(value: str, limit: int) -> str:
    """Collapse control characters and whitespace, then cap by code point.

    Newlines are what let injected text pose as a fresh instruction block when
    another agent reads it back, so they become spaces. Capping by code point
    rather than byte or UTF-16 unit means an emoji at the boundary survives
    whole instead of becoming a lone surrogate that JSON cannot encode.
    """
    cleaned = "".join(
        " " if (ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F) else ch for ch in value
    )
    return " ".join(cleaned.split())[:limit]


class AccessibilityImpact(ApiModel):
    lost_step_free: list[str] = Field(default_factory=list)
    gained_step_free: list[str] = Field(default_factory=list)
    newly_blocked_doors: list[str] = Field(default_factory=list)


class ReviewProposal(ApiModel):
    id: str
    description: str
    reason: str
    mutation: dict[str, Any]
    status: Literal["pending", "approved", "declined"] = "pending"
    base_scene_version: int
    candidate_scene: StoredAsset
    impact: AccessibilityImpact
    proposed_at: datetime
    decided_at: datetime | None = None
    resulting_scene_version: int | None = None


class AuditEntry(ApiModel):
    id: str
    tool: str
    args: dict[str, Any]
    outcome: Literal["answered", "queued", "refused", "error"]
    summary: str
    at: datetime


class ReviewLedger(ApiModel):
    run_id: str
    proposals: list[ReviewProposal] = Field(default_factory=list)
    calls: list[AuditEntry] = Field(default_factory=list)


class ProposalRequest(ApiModel):
    """What an agent sends. Deliberately not a scene."""

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{4,64}$")
    mutation: dict[str, Any]
    base_scene_version: int = Field(ge=0)


class AuditRequest(ApiModel):
    calls: list[AuditEntry] = Field(max_length=50)


class ProposalConflict(ValueError):
    """The proposal cannot be decided, or made, in the venue's current state."""


class MutationRejected(ValueError):
    """The mutation does not describe a change this venue can take."""


# --- Applying a mutation ------------------------------------------------------
# Mirrors src/webmcp/gate.ts applyMutation and describeMutation. The client
# applies the same rules for immediate feedback; this copy is the one that
# produces the scene a venue actually approves.


def _agent_evidence(reason: str) -> dict[str, Any]:
    return {
        "confidence": 0.6,
        "method": "human",
        "note": sanitise_free_text(f"Reported via agent: {reason}", REASON_LIMIT),
    }


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "landmark"


def _free_id(label: str, taken: set[str]) -> str:
    base = _slugify(label)
    candidate = base
    suffix = 2
    while candidate in taken:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _require_label(mutation: dict[str, Any]) -> str:
    label = sanitise_free_text(str(mutation.get("label") or ""), LABEL_LIMIT)
    if not label:
        raise MutationRejected("A label is required")
    return label


def _require_point(mutation: dict[str, Any]) -> list[float]:
    position = mutation.get("position")
    if (
        not isinstance(position, (list, tuple))
        or len(position) != 2
        or not all(isinstance(value, (int, float)) and isfinite(value) for value in position)
    ):
        raise MutationRejected("A position of two numbers is required")
    return [float(position[0]), float(position[1])]


def _require_bool(mutation: dict[str, Any], key: str) -> bool:
    value = mutation.get(key)
    if not isinstance(value, bool):
        raise MutationRejected(f"`{key}` must be true or false")
    return value


def apply_mutation(scene: dict[str, Any], mutation: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Return the candidate scene and its one-line description.

    The draft is deliberately allowed to be invalid; judging it is the
    validator's job, not this function's.
    """
    reason = str(mutation.get("reason") or "").strip()
    if not reason:
        raise MutationRejected("A reason is required; it is kept as provenance")

    draft = copy.deepcopy(scene)
    rooms = {room["id"]: room for room in draft["rooms"]}
    doors = {door["id"]: door for door in draft["doors"]}
    landmarks = {item["id"]: item for item in draft["landmarks"]}
    kind = mutation.get("kind")

    def room_label(room_id: str) -> str:
        if room_id == "outside":
            return "outside"
        return rooms[room_id]["label"] if room_id in rooms else room_id

    if kind == "set-door-accessible":
        door = doors.get(str(mutation.get("doorId")))
        if door is None:
            raise MutationRejected(f'Unknown door "{mutation.get("doorId")}"')
        accessible = _require_bool(mutation, "accessible")
        door["accessible"] = accessible
        door["evidence"]["connectivity"] = _agent_evidence(reason)
        if mutation.get("cascade", True):
            for edge in draft["routeGraph"]["edges"]:
                if edge.get("doorId") == door["id"]:
                    edge["accessible"] = accessible
        state = "step-free again" if accessible else "not step-free"
        return draft, f'Mark "{door["label"]}" as {state}'

    if kind == "set-door-width":
        door = doors.get(str(mutation.get("doorId")))
        if door is None:
            raise MutationRejected(f'Unknown door "{mutation.get("doorId")}"')
        width = mutation.get("width")
        if not isinstance(width, (int, float)) or not 0 < width <= 8:
            raise MutationRejected("`width` must be a number of metres between 0 and 8")
        door["width"] = float(width)
        door["evidence"]["width"] = _agent_evidence(reason)
        return draft, f'Set "{door["label"]}" clear width to {width} m'

    if kind == "relabel":
        entity_kind = mutation.get("entityKind")
        if entity_kind not in ENTITY_KINDS:
            raise MutationRejected(f"`entityKind` must be one of {', '.join(ENTITY_KINDS)}")
        collection = {"room": rooms, "door": doors, "landmark": landmarks}[entity_kind]
        entity = collection.get(str(mutation.get("entityId")))
        if entity is None:
            raise MutationRejected(f'Unknown {entity_kind} "{mutation.get("entityId")}"')
        label = _require_label(mutation)
        previous = entity["label"]
        entity["label"] = label
        if "label" in entity["evidence"]:
            entity["evidence"]["label"] = _agent_evidence(reason)
        return draft, f'Rename {entity_kind} "{previous}" to "{label}"'

    if kind == "add-landmark":
        label = _require_label(mutation)
        landmark_type = mutation.get("landmarkType")
        if landmark_type not in LANDMARK_TYPES:
            raise MutationRejected(f"`landmarkType` must be one of {', '.join(LANDMARK_TYPES)}")
        position = _require_point(mutation)
        draft["landmarks"].append(
            {
                "id": _free_id(label, set(landmarks)),
                "label": label,
                "type": landmark_type,
                "position": position,
                "confidence": 0.6,
                "evidence": {"label": _agent_evidence(reason), "geometry": _agent_evidence(reason)},
            }
        )
        return draft, f'Add {landmark_type} "{label}" at {position[0]:.1f}, {position[1]:.1f}'

    if kind == "add-door":
        label = _require_label(mutation)
        connects = mutation.get("connects")
        if not isinstance(connects, (list, tuple)) or len(connects) != 2:
            raise MutationRejected("`connects` must name two rooms")
        connects = [str(side) for side in connects]
        position = _require_point(mutation)
        # An absent width means nobody measured it. It is filled with a
        # placeholder because the scene schema requires a number, but it is
        # never evidenced as a human observation.
        measured = mutation.get("width") is not None
        width = mutation.get("width", ASSUMED_DOOR_WIDTH)
        if not isinstance(width, (int, float)) or isinstance(width, bool) or not 0 < width <= 8:
            raise MutationRejected("`width` must be a number of metres between 0 and 8")
        stated = mutation.get("accessible") is not None
        accessible = mutation.get("accessible", True)
        if not isinstance(accessible, bool):
            raise MutationRejected("`accessible` must be true or false")
        draft["doors"].append(
            {
                "id": _free_id(label, set(doors)),
                "label": label,
                "position": position,
                "width": float(width),
                "rotation": 0,
                "connects": connects,
                "accessible": accessible,
                "confidence": 0.6,
                "evidence": {
                    "position": _agent_evidence(reason),
                    "width": _agent_evidence(reason)
                    if measured
                    else {
                        "confidence": 0.3,
                        "method": "derived",
                        "note": (
                            f"Clear width not measured — assumed {ASSUMED_DOOR_WIDTH} m "
                            "pending measurement."
                        ),
                    },
                    "connectivity": _agent_evidence(reason),
                },
            }
        )
        prefix = "step-free " if accessible else ""
        unstated = ", ".join(
            note
            for note in (
                None if measured else "width not measured",
                None if stated else "step-free status not stated",
            )
            if note
        )
        return draft, (
            f'Add {prefix}doorway "{label}" between {room_label(connects[0])} and {room_label(connects[1])}'
            + (f" ({unstated})" if unstated else "")
        )

    if kind == "set-room-category":
        room = rooms.get(str(mutation.get("roomId")))
        if room is None:
            raise MutationRejected(f'Unknown room "{mutation.get("roomId")}"')
        category = mutation.get("category")
        if category not in ROOM_CATEGORIES:
            raise MutationRejected(f"`category` must be one of {', '.join(ROOM_CATEGORIES)}")
        room["category"] = category
        return draft, f'Set "{room["label"]}" to {category}'

    if kind == "add-review-note":
        entity_id = str(mutation.get("entityId"))
        target = rooms.get(entity_id) or doors.get(entity_id) or landmarks.get(entity_id)
        if target is None:
            raise MutationRejected(f'Unknown entity "{entity_id}"')
        message = sanitise_free_text(str(mutation.get("message") or ""), NOTE_LIMIT)
        if not message:
            raise MutationRejected("A message is required")
        issues = draft["review"]["issues"]
        issues.append(
            {
                "id": f"note-{len(issues) + 1}-{_slugify(entity_id)}",
                "message": message,
                "severity": "medium",
            }
        )
        return draft, f'Flag "{target["label"]}" for review: {message[:60]}'

    raise MutationRejected(f"Unknown mutation kind {kind!r}")


# --- Accessibility impact -----------------------------------------------------


def _node_for_landmark(scene: SpatialScene, landmark_id: str, position: tuple[float, float]):
    """The landmark's own node, else the nearest one. Same rule as the client."""
    for node in scene.route_graph.nodes:
        if node.landmark_id == landmark_id:
            return node
    best = None
    best_distance = float("inf")
    for node in scene.route_graph.nodes:
        distance = hypot(node.position[0] - position[0], node.position[1] - position[1])
        if distance < best_distance:
            best_distance = distance
            best = node
    return best


def step_free_reachable_ids(scene: SpatialScene) -> set[str]:
    """Ids of landmarks reachable from the main entrance without steps."""
    entrance = next((item for item in scene.landmarks if item.type == "entrance"), None)
    start = next(
        (
            node
            for node in scene.route_graph.nodes
            if node.landmark_id
            and (node.landmark_id == (entrance.id if entrance else None) or node.landmark_id == "entrance")
        ),
        None,
    )
    if start is None:
        return set()

    neighbours: dict[str, list[str]] = {}
    for edge in scene.route_graph.edges:
        if not edge.accessible:
            continue
        neighbours.setdefault(edge.from_node, []).append(edge.to)
        neighbours.setdefault(edge.to, []).append(edge.from_node)

    seen = {start.id}
    frontier = [start.id]
    while frontier:
        current = frontier.pop()
        for neighbour in neighbours.get(current, []):
            if neighbour not in seen:
                seen.add(neighbour)
                frontier.append(neighbour)

    reachable: set[str] = set()
    for item in scene.landmarks:
        if item.type == "entrance":
            continue
        node = _node_for_landmark(scene, item.id, item.position)
        if node is not None and node.id in seen:
            reachable.add(item.id)
    return reachable


def accessibility_impact(before: SpatialScene, after: SpatialScene) -> AccessibilityImpact:
    """Diffed by id, so a rename never reads as access lost and regained."""
    previous = step_free_reachable_ids(before)
    current = step_free_reachable_ids(after)
    labels_before = {item.id: item.label for item in before.landmarks}
    labels_after = {item.id: item.label for item in after.landmarks}
    blocked_before = {door.id for door in before.doors if not door.accessible}
    blocked_after = {door.id: door.label for door in after.doors if not door.accessible}
    return AccessibilityImpact(
        lost_step_free=sorted(labels_before.get(item, item) for item in previous - current),
        gained_step_free=sorted(labels_after.get(item, item) for item in current - previous),
        newly_blocked_doors=sorted(
            label for door_id, label in blocked_after.items() if door_id not in blocked_before
        ),
    )


# --- The service --------------------------------------------------------------


class ReviewService:
    def __init__(self, runs: RunService):
        self.runs = runs
        self.store = runs.store
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._locks_guard = threading.Lock()

    def _lock(self, run_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks[run_id]

    def _ledger_key(self, record) -> str:
        return f"{self.runs._prefix(record.run_id, record.created_at)}/review/ledger.json"

    def load(self, record) -> ReviewLedger:
        try:
            return ReviewLedger.model_validate_json(self.store.get(self._ledger_key(record)))
        except (FileNotFoundError, KeyError):
            return ReviewLedger(run_id=record.run_id)

    def _save(self, record, ledger: ReviewLedger) -> None:
        self.store.put(
            self._ledger_key(record),
            ledger.model_dump_json(by_alias=True, indent=2).encode(),
            "application/json",
            {"run-id": record.run_id, "artifact": "review-ledger"},
        )

    def propose(self, record, request: ProposalRequest) -> ReviewProposal:
        with self._lock(record.run_id):
            ledger = self.load(record)
            existing = next((item for item in ledger.proposals if item.id == request.id), None)
            if existing is not None:
                return existing

            if request.base_scene_version != record.scene_version:
                raise ProposalConflict(
                    f"This was drafted against scene version {request.base_scene_version}, but the "
                    f"venue is now on version {record.scene_version}. Reload the venue and propose again."
                )

            base = self.runs.active_scene(record)
            try:
                candidate_data, description = apply_mutation(
                    base.model_dump(by_alias=True, mode="json"), request.mutation
                )
            except MutationRejected as error:
                raise SceneRejected(str(error)) from error
            try:
                candidate = SpatialScene.model_validate(candidate_data)
            except ValidationError as error:
                raise SceneRejected(f"Candidate scene failed topology validation: {error}") from error

            prefix = self.runs._prefix(record.run_id, record.created_at)
            stored = self.store.put(
                f"{prefix}/review/proposals/{request.id}.json",
                candidate.model_dump_json(by_alias=True, indent=2).encode(),
                "application/json",
                {"run-id": record.run_id, "artifact": "proposed-scene", "proposal": request.id},
            )
            proposal = ReviewProposal(
                id=request.id,
                description=description,
                reason=sanitise_free_text(str(request.mutation.get("reason", "")), REASON_LIMIT),
                mutation=request.mutation,
                base_scene_version=request.base_scene_version,
                candidate_scene=stored,
                impact=accessibility_impact(base, candidate),
                proposed_at=datetime.now(UTC),
            )
            ledger.proposals.append(proposal)
            self._save(record, ledger)
            return proposal

    def _pending(self, ledger: ReviewLedger, proposal_id: str) -> ReviewProposal:
        proposal = next((item for item in ledger.proposals if item.id == proposal_id), None)
        if proposal is None:
            raise KeyError(proposal_id)
        if proposal.status != "pending":
            raise ProposalConflict(f"Proposal was already {proposal.status}")
        return proposal

    def approve(self, record, proposal_id: str) -> tuple[ReviewProposal, Any, dict[str, Any]]:
        with self._lock(record.run_id):
            ledger = self.load(record)
            proposal = self._pending(ledger, proposal_id)
            if proposal.base_scene_version != record.scene_version:
                raise ProposalConflict(
                    f"Proposal was made against scene version {proposal.base_scene_version}, "
                    f"but the venue is now on version {record.scene_version}. Ask for it again."
                )
            scene_data = json.loads(self.store.get(proposal.candidate_scene.key))
            # An accepted report goes onto the working scene, not the published
            # one. The run drops back to needs-review with an issue naming the
            # change, so publishing is still a deliberate second step — the
            # same invariant every other edit path keeps.
            issues = [item for item in scene_data["review"]["issues"] if item["id"] != f"proposal-{proposal.id}"]
            issues.append(
                {
                    "id": f"proposal-{proposal.id}",
                    "message": f"Confirm on site: {proposal.description}",
                    "severity": "medium",
                }
            )
            scene_data["review"] = {"status": "needs-review", "issues": issues}
            record = self.runs.save_scene_version(record, scene_data)
            proposal.status = "approved"
            proposal.decided_at = datetime.now(UTC)
            proposal.resulting_scene_version = record.scene_version
            self._save(record, ledger)
            return proposal, record, scene_data

    def decline(self, record, proposal_id: str) -> ReviewProposal:
        with self._lock(record.run_id):
            ledger = self.load(record)
            proposal = self._pending(ledger, proposal_id)
            proposal.status = "declined"
            proposal.decided_at = datetime.now(UTC)
            self._save(record, ledger)
            return proposal

    def record_calls(self, record, calls: list[AuditEntry]) -> int:
        with self._lock(record.run_id):
            ledger = self.load(record)
            known = {item.id for item in ledger.calls}
            fresh = [item for item in calls if item.id not in known]
            ledger.calls = (ledger.calls + fresh)[-LEDGER_CALL_CAP:]
            self._save(record, ledger)
            return len(fresh)
