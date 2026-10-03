"""Read-only Sanity connection check; never prints credentials or changes content."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from spatialize_api.access_repository import AccessRepository, ContentUnavailable
from spatialize_api.config import Settings


if __name__ == "__main__":
    settings = Settings()
    if not settings.sanity_project_id or not settings.sanity_api_token:
        raise SystemExit("Configure SANITY_PROJECT_ID and SANITY_API_TOKEN in the root .env.")
    try:
        counts = AccessRepository(settings, None).query('''{
          "venues": count(*[_type == "accessVenue"]),
          "entities": count(*[_type == "spatialEntity"]),
          "sources": count(*[_type == "accessSource"]),
          "claims": count(*[_type == "accessClaim"]),
          "notices": count(*[_type == "operationalNotice"]),
          "obstacles": count(*[_type == "accessObstacle"]),
          "publications": count(*[_type == "accessState"])
        }''')
    except ContentUnavailable as error:
        raise SystemExit(str(error)) from None
    report = {
        "projectId": settings.sanity_project_id,
        "dataset": settings.sanity_dataset,
        "contentLake": "connected",
        "documentCounts": counts,
        "contextEndpointConfigured": bool(settings.sanity_context_url),
        "contextOrganizationTokenConfigured": bool(settings.sanity_context_token),
        "modelKeyConfigured": bool(settings.openai_api_key),
    }
    print(json.dumps(report, indent=2))
