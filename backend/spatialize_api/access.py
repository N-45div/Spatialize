"""Evidence-backed route screening and reviewed obstacle changes."""

from contextlib import nullcontext
from datetime import UTC, datetime
from uuid import uuid4

from .access_geometry import footprint, segment_footprint_distance, validate_placement
from .access_models import AccessProposal, AccessSource
from .access_repository import AccessConflict
from .agents.tools import SceneSession, ToolError


def check_access(scene, state, destination_id, clearance_mm, scene_version, now=None):
    now = now or datetime.now(UTC)
    entrance = next((x for x in scene["landmarks"] if x["type"] == "entrance"), None)
    destination = next((x for x in scene["landmarks"] if x["id"] == destination_id), None)
    if destination is None:
        raise ValueError("Choose a destination in the current scene")
    base = {
        "destinationId": destination_id,
        "destinationLabel": destination["label"],
        "sceneVersion": scene_version,
        "accessVersion": state.version,
        "checkedAt": now.isoformat(),
        "clearanceMm": clearance_mm,
        "route": [],
        "distanceMeters": None,
        "reasons": [],
        "evidence": [],
        "limitations": [
            (
                "Screens the stored route corridor and doorway widths. "
                "Turning space, slope, headroom and unrecorded obstacles are not assessed. "
                "A blocked stored corridor may have alternatives; automatic rerouting is not performed."
            )
        ],
    }
    if not entrance:
        return {
            **base,
            "verdict": "UNKNOWN",
            "reasons": [{"entityId": destination_id, "message": "No entrance is connected to this venue"}],
        }
    session = SceneSession(scene=scene)
    try:
        route = session.compute_route(entrance["id"], destination_id)
    except ToolError:
        try:
            session.compute_route(entrance["id"], destination_id, accessible_only=False)
            verdict, message = "BLOCKED", "No stored step-free route connects this destination"
        except ToolError:
            verdict, message = "UNKNOWN", "This destination is not connected to the stored route graph"
        return {**base, "verdict": verdict, "reasons": [{"entityId": destination_id, "message": message}]}
    base["route"] = route.positions
    base["distanceMeters"] = round(route.distance, 2)
    geometry_source = {
        "id": f"scene-v{scene_version}",
        "title": f"Geometry snapshot v{scene_version}",
        "publisher": "Spatialize geometry validator",
        "url": None,
        "observedAt": scene["extraction"]["completedAt"],
        "synthetic": scene["id"] == "harbor-arts-ground",
        "body": "Computed from the stored route graph and doorway evidence. Geometric validation "
        "does not verify physical measurements. Source SHA-256: " + scene["sourceSha256"],
    }
    nodes = {n["id"]: n for n in scene["routeGraph"]["nodes"]}
    entities = set(route.door_ids) | {nodes[n]["roomId"] for n in route.node_ids} | {destination_id}
    sources = {s.id: s for s in state.sources}
    evidence_ids = set()
    blocked, uncertain = [], []

    def reason(target, entity, message, source_id=None):
        target.append({"entityId": entity, "message": message, "sourceId": source_id})
        if source_id:
            evidence_ids.add(source_id)

    for door in scene["doors"]:
        if door["id"] not in route.door_ids:
            continue
        width_evidence = door["evidence"]["width"]
        confirmed = width_evidence["confidence"] >= 0.85
        if not confirmed:
            reason(uncertain, door["id"], f"{door['label']}: width has not been confirmed")
        elif door["width"] * 1000 < clearance_mm:
            reason(
                blocked,
                door["id"],
                f"{door['label']} is {round(door['width'] * 1000)} mm wide; {clearance_mm} mm is required",
            )
        if door["evidence"]["connectivity"]["confidence"] < 0.85:
            reason(uncertain, door["id"], f"{door['label']}: connectivity remains unverified")
    relevant_claims = [c for c in state.claims if c.entity_id in entities]
    grouped = {}
    for claim in relevant_claims:
        evidence_ids.add(claim.source_id)
        grouped.setdefault((claim.entity_id, claim.property), []).append(claim)
        if claim.source_id not in sources:
            reason(uncertain, claim.entity_id, "An access claim cites a source that is no longer on record")
        elif claim.status != "verified":
            stated = (
                ("step-free" if claim.value else "a step or access barrier")
                if claim.property == "step-free"
                else f"a clear width of {claim.value:g} mm"
            )
            reason(
                uncertain,
                claim.entity_id,
                f"{sources[claim.source_id].title} reports {stated}; this claim is {claim.status}",
                claim.source_id,
            )
        elif claim.property == "step-free" and claim.value is False:
            reason(
                blocked,
                claim.entity_id,
                "A verified source reports a step or access barrier",
                claim.source_id,
            )
        elif claim.property == "clear-width-mm" and claim.value < clearance_mm:
            reason(blocked, claim.entity_id, f"A verified width is {claim.value:g} mm", claim.source_id)
    for (entity, prop), claims in grouped.items():
        if len({str(c.value) for c in claims}) > 1:
            reason(uncertain, entity, f"Sources disagree about {prop}; both claims remain on record")
    for notice in state.notices:
        if notice.entity_id in entities and notice.starts_at <= now < notice.ends_at:
            target = blocked if notice.status == "verified" and notice.source_id in sources else uncertain
            reason(target, notice.entity_id, notice.title, notice.source_id)
    for obstacle in state.obstacles:
        if any(
            segment_footprint_distance(a, b, footprint(obstacle)) < clearance_mm / 2000
            for a, b in zip(route.positions, route.positions[1:])
        ):
            target = blocked if obstacle.verified and obstacle.source_id in sources else uncertain
            reason(
                target,
                obstacle.id,
                f"{obstacle.label} intersects the requested route corridor",
                obstacle.source_id,
            )
    base["evidence"] = [geometry_source] + [
        s.model_dump(by_alias=True, mode="json") for s in state.sources if s.id in evidence_ids
    ]
    base["claims"] = [c.model_dump(by_alias=True, mode="json") for c in relevant_claims]
    base["reasons"] = blocked + uncertain
    base["verdict"] = "BLOCKED" if blocked else "UNKNOWN" if uncertain else "CLEAR"
    if not base["reasons"]:
        base["reasons"] = [
            {
                "entityId": destination_id,
                "message": "The stored route passes the requested corridor and doorway checks",
            }
        ]
    return base


class AccessDesk:
    def __init__(self, runs, repository, run_lock=None):
        self.runs = runs
        self.repository = repository
        self.run_lock = run_lock or (lambda _run_id: nullcontext())

    def scene(self, record):
        return self.runs.active_scene(record).model_dump(by_alias=True, mode="json")

    def load(self, record):
        scene = self.scene(record)
        state, revision = self.repository.load(record, scene)
        return scene, state, revision

    def snapshot(self, record):
        with self.repository.lock, self.run_lock(record.run_id):
            record = self.runs.get_run(record.run_id)
            scene, state, _ = self.load(record)
            return {
                **state.model_dump(by_alias=True, mode="json"),
                "sceneVersion": record.scene_version,
                "contentMode": "sanity" if self.repository.live else "fixture",
                "synthetic": scene["id"] == "harbor-arts-ground",
                "rooms": [{"id": r["id"], "label": r["label"]} for r in scene["rooms"]],
            }

    def check(self, record, question):
        with self.repository.lock, self.run_lock(record.run_id):
            record = self.runs.get_run(record.run_id)
            scene, state, _ = self.load(record)
            result = check_access(
                scene, state, question.destination_id, question.clearance_mm, record.scene_version
            )
            return {**result, "contentMode": "sanity" if self.repository.live else "fixture"}

    def candidate(self, scene, state, move):
        obstacle = next((o for o in state.obstacles if o.id == move.obstacle_id), None)
        if obstacle is None:
            raise ValueError("Obstacle no longer exists")
        moved = obstacle.model_copy(
            update={"position": move.position, "room_id": move.room_id, "rotation": move.rotation}
        )
        validate_placement(scene, moved, state.obstacles)
        candidate = state.model_copy(deep=True)
        candidate.obstacles = [moved if o.id == moved.id else o for o in candidate.obstacles]
        impact = []
        for landmark in scene["landmarks"]:
            if landmark["type"] != "destination":
                continue
            before = check_access(scene, state, landmark["id"], 800, move.base_scene_version)["verdict"]
            after = check_access(scene, candidate, landmark["id"], 800, move.base_scene_version)["verdict"]
            impact.append({"destination": landmark["label"], "before": before, "after": after})
        return candidate, impact

    def preview(self, record, move):
        with self.repository.lock, self.run_lock(record.run_id):
            record = self.runs.get_run(record.run_id)
            scene, state, _ = self.load(record)
            self.fresh(record, state, move)
            candidate, impact = self.candidate(scene, state, move)
            return {
                "obstacles": [o.model_dump(by_alias=True, mode="json") for o in candidate.obstacles],
                "impact": impact,
                "clearanceMm": 800,
                "sceneVersion": record.scene_version,
                "accessVersion": state.version,
            }

    def fresh(self, record, state, move):
        current = self.runs.get_run(record.run_id)
        if move.base_scene_version != current.scene_version or move.base_access_version != state.version:
            raise AccessConflict("The scene or access layout changed. Reload and preview the move again.")

    def propose(self, record, move):
        with self.repository.lock, self.run_lock(record.run_id):
            record = self.runs.get_run(record.run_id)
            scene, state, revision = self.load(record)
            self.fresh(record, state, move)
            self.candidate(scene, state, move)
            if len(state.proposals) >= 200:
                raise ValueError("Review queue limit reached")
            proposal = AccessProposal(id=f"move_{uuid4().hex[:12]}", move=move, proposed_at=datetime.now(UTC))
            state.proposals.append(proposal)
            self.repository.save(record, state, revision)
            return proposal.model_dump(by_alias=True, mode="json")

    def decide(self, record, proposal_id, decision):
        with self.repository.lock, self.run_lock(record.run_id):
            record = self.runs.get_run(record.run_id)
            scene, state, revision = self.load(record)
            proposal = next((p for p in state.proposals if p.id == proposal_id), None)
            if not proposal:
                raise KeyError(proposal_id)
            if proposal.status != "pending":
                raise AccessConflict("This proposal has already been decided")
            if decision.decision == "approve":
                self.fresh(record, state, proposal.move)
                state, _ = self.candidate(scene, state, proposal.move)
                state.version += 1
                proposal = next(p for p in state.proposals if p.id == proposal_id)
                proposal.resulting_version = state.version
                source_id = f"review-{proposal.id}"
                obstacle = next(o for o in state.obstacles if o.id == proposal.move.obstacle_id)
                original_source = next((s for s in state.sources if s.id == obstacle.source_id), None)
                state.sources.append(
                    AccessSource(
                        id=source_id,
                        title=f"Approved layout: {obstacle.label}",
                        publisher="Venue reviewer",
                        observed_at=datetime.now(UTC),
                        synthetic=bool(original_source and original_source.synthetic),
                        body=f"Reviewer accepted the recorded placement at {obstacle.position} metres. "
                        f"Reason: {decision.reason}. This is a reviewed layout record, not an independent site survey.",
                    )
                )
                obstacle.source_id = source_id
            proposal.status = "approved" if decision.decision == "approve" else "declined"
            proposal.decided_at = datetime.now(UTC)
            proposal.decision_reason = decision.reason
            self.repository.save(record, state, revision)
            return state.model_dump(by_alias=True, mode="json")
