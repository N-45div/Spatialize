"""Local fixtures or live Content Lake. A configured failure never falls back to fixtures."""

import json
import re
from threading import RLock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .access_models import AccessState


class ContentUnavailable(RuntimeError):
    pass


class AccessConflict(ValueError):
    pass


class AccessRepository:
    def __init__(self, settings, store):
        self.settings = settings
        self.store = store
        self.lock = RLock()
        self.live = bool(settings.sanity_project_id)

    def request(self, path, body=None):
        project = self.settings.sanity_project_id
        dataset = self.settings.sanity_dataset
        if not re.fullmatch(r"[a-z0-9]+", project or "") or not re.fullmatch(r"[a-zA-Z0-9_-]+", dataset):
            raise ContentUnavailable("Invalid Sanity project ID or dataset")
        headers = {"Content-Type": "application/json"}
        if self.settings.sanity_api_token:
            headers["Authorization"] = f"Bearer {self.settings.sanity_api_token}"
        request = Request(
            f"https://{project}.api.sanity.io/v2026-09-01/data/{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
        )
        try:
            with urlopen(request, timeout=20) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 409:
                raise AccessConflict("Evidence changed during this request. Reload and try again.") from error
            raise ContentUnavailable(
                f"Sanity request failed (HTTP {error.code}); check server configuration"
            ) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise ContentUnavailable("Sanity is unavailable; no fixture evidence was substituted") from error

    def query(self, query, **parameters):
        values = {"query": query, **{f"${k}": json.dumps(v) for k, v in parameters.items()}}
        return self.request(f"query/{self.settings.sanity_dataset}?{urlencode(values)}")["result"]

    def mutate(self, mutations):
        return self.request(
            f"mutate/{self.settings.sanity_dataset}?visibility=sync", {"mutations": mutations}
        )

    def load(self, record, scene):
        key = f"access/{record.run_id}.json"
        if not self.live:
            try:
                return AccessState.model_validate_json(self.store.get(key)), None
            except FileNotFoundError:
                from importlib.resources import files

                data = json.loads(files("spatialize_api").joinpath("data/access_demo.json").read_text("utf-8"))
                state = (
                    AccessState.model_validate(data)
                    if scene["id"] == data["venueId"]
                    else AccessState(venue_id=scene["id"])
                )
                self.save(record, state, None)
                return state, None
        document_id = f"access-state-{record.run_id}"
        ledger = self.query("*[_id == $id][0]", id=document_id)
        facts = self.query(
            """{
          "sources": *[_type == "accessSource" && venue._ref == $venue]{
            "id": _id, title, publisher, url, observedAt, synthetic, body},
          "claims": *[_type == "accessClaim" && venue._ref == $venue]{
            "id": _id, "entityId": entity->entityId, property,
            "value": select(property == "step-free" => stepFree, widthMm),
            "sourceId": source._ref, status},
          "notices": *[_type == "operationalNotice" && venue._ref == $venue]{
            "id": _id, "entityId": entity->entityId, title, startsAt, endsAt,
            "sourceId": source._ref, status},
          "obstacles": *[_type == "accessObstacle" && venue._ref == $venue]{
            "id": _id, label, roomId, position, width, depth, rotation,
            "sourceId": source._ref, verified}
        }""",
            venue=scene["id"],
        )
        if not ledger:
            state = AccessState(venue_id=scene["id"], **facts)
            self.mutate(
                [
                    {
                        "createIfNotExists": {
                            "_id": document_id,
                            "_type": "accessState",
                            "venue": {"_type": "reference", "_ref": scene["id"]},
                            "runId": record.run_id,
                            "accessVersion": state.version,
                            "sceneVersion": record.scene_version,
                            "publishedObstacles": [
                                dict(o.model_dump(by_alias=True, mode="json"), _key=o.id)
                                for o in state.obstacles
                            ],
                            "reviewRecords": [],
                            "stateJson": state.model_dump_json(by_alias=True),
                        }
                    }
                ]
            )
            ledger = self.query("*[_id == $id][0]", id=document_id)
        state = AccessState.model_validate_json(ledger["stateJson"])
        # Published operational geometry stays versioned; evidence reads are always live.
        current_facts = AccessState(venue_id=scene["id"], **facts)
        state.sources = current_facts.sources
        state.claims = current_facts.claims
        state.notices = current_facts.notices
        return state, ledger["_rev"]

    def save(self, record, state, revision):
        if self.live:
            review_sources = [
                {
                    "createIfNotExists": {
                        "_id": s.id,
                        "_type": "accessSource",
                        "venue": {"_type": "reference", "_ref": state.venue_id},
                        **{k: v for k, v in s.model_dump(by_alias=True, mode="json").items() if k != "id"},
                    }
                }
                for s in state.sources
                if s.id.startswith("review-move_")
            ]
            self.mutate(
                review_sources
                + [
                    {
                        "patch": {
                            "id": f"access-state-{record.run_id}",
                            "ifRevisionID": revision,
                            "set": {
                                "stateJson": state.model_dump_json(by_alias=True),
                                "accessVersion": state.version,
                                "sceneVersion": record.scene_version,
                                "publishedObstacles": [
                                    dict(o.model_dump(by_alias=True, mode="json"), _key=o.id)
                                    for o in state.obstacles
                                ],
                                "reviewRecords": [
                                    dict(p.model_dump(by_alias=True, mode="json"), _key=p.id)
                                    for p in state.proposals
                                ],
                            },
                        }
                    }
                ]
            )
        else:
            self.store.put(
                f"access/{record.run_id}.json",
                state.model_dump_json(by_alias=True).encode(),
                "application/json",
            )
