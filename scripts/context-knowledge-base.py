"""Create, or rebuild, the Sanity Context Knowledge Base the evidence agent reads.

Knowledge Bases belong to the organization, so a project token cannot manage them.
Sign in once with `npx sanity login` in sanity/ (or set SANITY_AUTH_TOKEN). The token
is read from the CLI config and never printed.

  python scripts/context-knowledge-base.py --organization ottnv0qew   # create, import, build
  python scripts/context-knowledge-base.py --knowledge-base <uuid>    # rebuild after editing sources
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from spatialize_api.config import Settings

API = "https://api.sanity.io/v2026-08-25/context/knowledge-bases"
TITLE = "Spatialize - Harbor Arts access evidence"
PURPOSE = (
    "Access evidence for Harbor Arts Centre, a FICTIONAL demo venue in Spatialize: venue guides, visitor "
    "reports, facilities notes and dated notices, each with the access claims it supports and their review "
    "status (verified, unverified, disputed). Every document is a synthetic example, not a real observation. "
    "Keep unresolved visitor/venue disagreements visible side by side with both sources; never settle a "
    "disputed report into fact. Route geometry, widths and verdicts are computed separately by Spatialize: "
    "do not invent widths, slopes, measurements or an accessibility guarantee."
)


def user_token():
    if os.environ.get("SANITY_AUTH_TOKEN"):
        return os.environ["SANITY_AUTH_TOKEN"]
    config = Path.home() / ".config/sanity/config.json"
    token = json.loads(config.read_text("utf-8")).get("authToken") if config.exists() else None
    if not token:
        raise SystemExit("Run `npx sanity login` in sanity/ first; Knowledge Bases need a user session.")
    return token


def call(method, url, body=None):
    request = Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Authorization": f"Bearer {user_token()}", "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        raise SystemExit(f"{method} {url} failed: HTTP {error.code} {error.read().decode()[:500]}") from None


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--organization", help="create a new Knowledge Base in this organization")
    target.add_argument("--knowledge-base", help="rebuild this existing Knowledge Base (uuid)")
    args = parser.parse_args()
    if args.organization:
        settings = Settings()
        if not settings.sanity_project_id:
            raise SystemExit("Set SANITY_PROJECT_ID in the root .env first.")
        kb = call("POST", API, {"organizationId": args.organization, "title": TITLE, "description": PURPOSE})
        call("POST", f"{API}/{kb['id']}/imports", {
            "type": "dataset", "sanityProjectId": settings.sanity_project_id,
            "sanityDatasetId": settings.sanity_dataset,
            "query": (ROOT / "sanity/knowledge-base.groq").read_text("utf-8"),
        })
        kb_id = kb["id"]
        print(f"Created Knowledge Base {kb['publicId']} ({kb_id}) with a dataset import.")
    else:
        kb_id = args.knowledge_base
    job = call("POST", f"{API}/{kb_id}/build", {})["jobId"]
    while (status := call("GET", f"{API}/{kb_id}/jobs/{job}")["status"]) in {"pending", "queued", "running"}:
        print(f"Build {status}...", flush=True)
        time.sleep(10)
    kb = call("GET", f"{API}/{kb_id}")
    print(f"Build {status}. State: {kb['state']}; sources used: {kb['sourceUsage']['used']}; "
          f"open issues: {kb['openIssueCount']} (review conflicts in the Context app).")
    return 0 if status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
