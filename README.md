# Spatialize

Spatialize turns flat venue plans into explorable, audible, and touchable spatial experiences.

This foundation contains:

- a metric spatial-scene contract with extraction evidence and topology validation
- a Three.js compiler for rooms, doorway openings, landmarks, and accessible routes
- accessible route rehearsal from a graph
- a product UI for spatial review
- a FastAPI ingestion service with content hashing and review-gated scene persistence
- B2-compatible object storage and explicit vision/Genblaze adapter boundaries

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

Run the API in a second terminal:

```bash
cd backend
uv sync --extra dev
uv run uvicorn spatialize_api.app:app --reload --port 8787
```

Local development writes artifacts beneath `backend/.local-data`. Copy
`.env.example` to `.env` and select `SPATIALIZE_STORAGE_BACKEND=b2` to use a
bucket-scoped Backblaze application key.

Run both test suites:

```bash
npm test
cd backend && uv run pytest
```

## Architecture boundary

A structured-vision adapter extracts candidate scene data, which must pass
schema and topology validation before human review. Genblaze orchestrates
generated landmark media and route narration with provenance-covered outputs.
The approved `scene.json` is compiled deterministically into Three.js geometry.
Backblaze B2 stores source media, candidate and approved scenes, generated
assets, audio, and manifests.

No live navigation or safety claim is made. Published packages require human approval.
