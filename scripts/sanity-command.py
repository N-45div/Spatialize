"""Run the standalone Studio CLI using server credentials from the root .env.

Example: python scripts/sanity-command.py schemas deploy
The token is passed through the child environment, never command-line arguments.
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from spatialize_api.config import Settings


def main():
    if len(sys.argv) < 2 or "--secrets" in sys.argv:
        raise SystemExit("Supply a Sanity CLI command. Secret-printing commands are disabled.")
    settings = Settings()
    if not settings.sanity_project_id or not settings.sanity_api_token:
        raise SystemExit("Set SANITY_PROJECT_ID and SANITY_API_TOKEN in the root .env first.")
    cli = ROOT / "sanity/node_modules/sanity/bin/sanity"
    if not cli.exists():
        raise SystemExit("Install the Studio dependencies with npm ci --prefix sanity first.")
    environment = os.environ.copy()
    environment.update({
        "SANITY_AUTH_TOKEN": settings.sanity_api_token,
        "SANITY_STUDIO_PROJECT_ID": settings.sanity_project_id,
        "SANITY_STUDIO_DATASET": settings.sanity_dataset,
    })
    result = subprocess.run(
        ["node", str(cli), *sys.argv[1:]], cwd=ROOT / "sanity", env=environment,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    output = (result.stdout + result.stderr).replace(settings.sanity_api_token, "[redacted]")
    sys.stdout.reconfigure(encoding="utf-8")
    print(output, end="")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
