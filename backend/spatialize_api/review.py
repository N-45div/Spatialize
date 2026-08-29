"""The review ledger: what agents proposed, what people decided, and why.

Every write an agent makes on behalf of a visitor lands here first. The client
runs the topology gate for fast feedback, but the client is not a security
boundary, so the same validation is repeated on this side before anything is
stored, and the accessibility impact a reviewer sees is computed here rather
than trusted from the request.

A declined proposal is never deleted. Venue-published access information is
the least reliable source in the published survey data, so a venue that could
erase a first-hand report would be handing the least accurate party a veto
over the most accurate one. Declining records a disagreement.
"""

import json
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import Field, ValidationError

from .models import ApiModel, SpatialScene, StoredAsset
from .workflow import RunService, SceneRejected

LEDGER_CALL_CAP = 200


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
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{4,64}$")
    description: str = Field(min_length=1, max_length=240)
    reason: str = Field(min_length=1, max_length=240)
    mutation: dict[str, Any]
    base_scene_version: int = Field(ge=0)
    candidate_scene: dict[str, Any]


class AuditRequest(ApiModel):
    calls: list[AuditEntry] = Field(max_length=50)


class ProposalConflict(ValueError):
    """The proposal cannot be decided in its current state."""


def step_free_reachable(scene: SpatialScene) -> set[str]:
    """Labels of landmarks reachable from the main entrance without steps.

    Deliberately the same rule the routing tool applies: only edges flagged
    accessible are walkable, and a landmark counts if its route node is in
    the reachable set.
    """
    entrance = next((item for item in scene.landmarks if item.type == "entrance"), None)
    start = next(
        (
            node
            for node in scene.route_graph.nodes
            if node.landmark_id and (node.landmark_id == (entrance.id if entrance else None) or node.landmark_id == "entrance")
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

    node_for_landmark = {node.landmark_id: node.id for node in scene.route_graph.nodes if node.landmark_id}
    return {
        item.label
        for item in scene.landmarks
        if item.type != "entrance" and node_for_landmark.get(item.id) in seen
    }


def accessibility_impact(before: SpatialScene, after: SpatialScene) -> AccessibilityImpact:
    previous = step_free_reachable(before)
    current = step_free_reachable(after)
    blocked_before = {door.label for door in before.doors if not door.accessible}
    blocked_after = {door.label for door in after.doors if not door.accessible}
    return AccessibilityImpact(
        lost_step_free=sorted(previous - current),
        gained_step_free=sorted(current - previous),
        newly_blocked_doors=sorted(blocked_after - blocked_before),
    )


class ReviewService:
    def __init__(self, runs: RunService):
        self.runs = runs
        self.store = runs.store

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
        ledger = self.load(record)
        existing = next((item for item in ledger.proposals if item.id == request.id), None)
        if existing is not None:
            return existing

        try:
            candidate = SpatialScene.model_validate(request.candidate_scene)
        except ValidationError as error:
            raise SceneRejected(f"Candidate scene failed topology validation: {error}") from error

        base = self.runs.active_scene(record)
        if (
            candidate.id != base.id
            or candidate.source_sha256 != base.source_sha256
            or candidate.dimensions != base.dimensions
        ):
            raise SceneRejected("Candidate scene is not a revision of this venue")

        prefix = self.runs._prefix(record.run_id, record.created_at)
        stored = self.store.put(
            f"{prefix}/review/proposals/{request.id}.json",
            candidate.model_dump_json(by_alias=True, indent=2).encode(),
            "application/json",
            {"run-id": record.run_id, "artifact": "proposed-scene", "proposal": request.id},
        )
        proposal = ReviewProposal(
            id=request.id,
            description=request.description,
            reason=request.reason,
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

    def approve(self, record, proposal_id: str) -> tuple[ReviewProposal, Any]:
        ledger = self.load(record)
        proposal = self._pending(ledger, proposal_id)
        if proposal.base_scene_version != record.scene_version:
            raise ProposalConflict(
                f"Proposal was made against scene version {proposal.base_scene_version}, "
                f"but the venue is now on version {record.scene_version}. Ask for it again."
            )
        scene_data = json.loads(self.store.get(proposal.candidate_scene.key))
        record = self.runs.save_scene_version(record, scene_data)
        proposal.status = "approved"
        proposal.decided_at = datetime.now(UTC)
        proposal.resulting_scene_version = record.scene_version
        self._save(record, ledger)
        return proposal, record

    def decline(self, record, proposal_id: str) -> ReviewProposal:
        ledger = self.load(record)
        proposal = self._pending(ledger, proposal_id)
        proposal.status = "declined"
        proposal.decided_at = datetime.now(UTC)
        self._save(record, ledger)
        return proposal

    def record_calls(self, record, calls: list[AuditEntry]) -> int:
        ledger = self.load(record)
        known = {item.id for item in ledger.calls}
        fresh = [item for item in calls if item.id not in known]
        ledger.calls = (ledger.calls + fresh)[-LEDGER_CALL_CAP:]
        self._save(record, ledger)
        return len(fresh)
