# Spatialize

Spatialize turns flat venue plans into explorable, audible, and touchable spatial experiences.

This foundation contains:

- a validated spatial-scene contract
- a Three.js compiler for rooms, walls, landmarks, and raised routes
- accessible route rehearsal from a graph
- a product UI for spatial review
- explicit adapter contracts for Genblaze generation and Backblaze B2 storage

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

## Architecture boundary

Genblaze will interpret and evaluate source plans, create route narration, and preserve generation provenance. The approved `scene.json` is compiled deterministically into Three.js geometry. Backblaze B2 stores source media, generated masks and audio, spatial JSON, compiled GLB/STL assets, and manifests.

No live navigation or safety claim is made. Published packages require human approval.
