"""Preview with --dry-run; publish missing synthetic demo documents with --write."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from spatialize_api.access_repository import AccessRepository
from spatialize_api.config import Settings


def reference(document_id):
    return {"_type": "reference", "_ref": document_id}


def documents():
    data = ROOT / "backend/spatialize_api/data"
    scene = json.loads((data / "demo_scene.json").read_text(encoding="utf-8"))
    state = json.loads((data / "access_demo.json").read_text(encoding="utf-8"))
    venue = reference(scene["id"])
    docs = [{"_id": scene["id"], "_type": "accessVenue", "title": scene["name"], "synthetic": True}]
    for kind, collection in [("room", "rooms"), ("door", "doors"), ("landmark", "landmarks")]:
        for entity in scene[collection]:
            docs.append(
                {
                    "_id": f"{scene['id']}--{entity['id']}",
                    "_type": "spatialEntity",
                    "venue": venue,
                    "entityId": entity["id"],
                    "title": entity["label"],
                    "kind": kind,
                }
            )
    for item in state["sources"]:
        docs.append(
            {
                "_id": item["id"],
                "_type": "accessSource",
                "venue": venue,
                **{k: v for k, v in item.items() if k != "id"},
            }
        )
    for key, document_type in [
        ("claims", "accessClaim"),
        ("notices", "operationalNotice"),
        ("obstacles", "accessObstacle"),
    ]:
        for item in state[key]:
            doc = {
                "_id": item["id"],
                "_type": document_type,
                "venue": venue,
                "source": reference(item["sourceId"]),
                **{k: v for k, v in item.items() if k not in {"id", "sourceId", "entityId", "value"}},
            }
            if "entityId" in item:
                doc["entity"] = reference(f"{scene['id']}--{item['entityId']}")
            if "value" in item:
                doc["stepFree" if item["property"] == "step-free" else "widthMm"] = item["value"]
            docs.append(doc)
    return docs


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    docs = documents()
    if args.write and not args.dry_run:
        settings = Settings()
        if not settings.sanity_project_id or not settings.sanity_api_token:
            parser.error("Set SANITY_PROJECT_ID and SANITY_API_TOKEN in .env first")
        repository = AccessRepository(settings, None)
        repository.mutate([{"createIfNotExists": doc} for doc in docs])
        print(f"Created missing demo documents ({len(docs)} requested); existing documents preserved.")
    else:
        print(json.dumps(docs, indent=2))
