/**
 * The whole loop through the real HTTP stack: a visitor's agent asks, reports,
 * the venue declines, the page is "refreshed", and a later agent hears both
 * sides. The backend is spawned for real and the tool surface talks to it
 * through the same client code the page uses. Skipped when the backend venv
 * is not present.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = path.resolve(__dirname, "../..");
const python = path.join(root, "backend", ".venv", "Scripts", "python.exe");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

type Api = typeof import("../../src/lib/api");
type Session = typeof import("../../src/webmcp/session");
type Tools = typeof import("../../src/webmcp/tools");
type Scene = typeof import("../../src/domain/spatial-scene");
type Tool = ReturnType<Tools["buildTools"]>[number];

const textOf = (result: { content: { text: string }[] }) =>
  result.content.map((block) => block.text).join("\n");

describe.skipIf(!existsSync(python))("golden journey through the real API", () => {
  let server: ChildProcess | null = null;
  let api: Api;
  let session: Session;
  let toolsModule: Tools;
  let sceneModule: Scene;

  beforeAll(async () => {
    vi.stubEnv("VITE_API_BASE_URL", BASE);
    const dataDir = mkdtempSync(path.join(tmpdir(), "spatialize-e2e-"));
    server = spawn(
      python,
      ["-m", "uvicorn", "spatialize_api.app:app", "--port", String(PORT), "--log-level", "warning"],
      {
        cwd: path.join(root, "backend"),
        env: {
          ...process.env,
          SPATIALIZE_STORAGE_BACKEND: "local",
          SPATIALIZE_LOCAL_DATA_DIR: dataDir,
          GEMINI_API_KEY: "",
          OPENROUTER_API_KEY: "",
          ASSEMBLYAI_API_KEY: ""
        },
        windowsHide: true,
        stdio: "ignore"
      }
    );
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        up = (await fetch(`${BASE}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!up) throw new Error("backend did not come up");
    api = await import("../../src/lib/api");
    session = await import("../../src/webmcp/session");
    toolsModule = await import("../../src/webmcp/tools");
    sceneModule = await import("../../src/domain/spatial-scene");
  }, 45_000);

  afterAll(() => {
    if (!server?.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      server.kill();
    }
  });

  it(
    "visitor asks, reports, venue declines, a refresh keeps the dispute, a later agent hears both sides",
    async () => {
      // A venue record exists on the server.
      const run = await api.ensureDemoRun();
      let live = sceneModule.SpatialSceneSchema.parse(await api.fetchScene(run.runId));
      session.clearAgentSession();
      session.configureAgentSync({ runId: run.runId, sceneVersion: run.sceneVersion });
      session.hydrateAgentSession(await api.fetchReview(run.runId));

      const tools = new Map<string, Tool>(
        toolsModule
          .buildTools({
            getScene: () => live,
            focusLandmark: () => undefined,
            setViewMode: () => undefined,
            canPropose: true
          })
          .map((tool) => [tool.name, tool])
      );
      const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args);
      const sceneBefore = JSON.stringify(live);

      // 1. A route, computed from geometry.
      const route = textOf(await call("find_step_free_route", { to: "Quiet room" }));
      expect(route).toContain("Step-free route");

      // 2. A clearance check for this person.
      const clearance = textOf(
        await call("check_route_clearance", { to: "Quiet room", minimum_clear_width_mm: 760 })
      );
      expect(clearance).toMatch(/Verdict: (UNKNOWN|CLEAR)/);

      // 3. A report: the server applies the mutation, computes the impact, stores it.
      const report = textOf(
        await call("propose_access_change", {
          door: "Quiet-room doorway",
          step_free: false,
          reason: "there is a 15 cm step here now"
        })
      );
      expect(report).toContain("on the venue record");
      expect(report).toContain("Would remove step-free access to: Quiet room");
      const proposal = session.getAgentSession().proposals[0];
      expect(proposal.persisted).toBe("saved");

      // 4. An impossible change is refused by the gate and never reaches the server.
      const impossible = await call("propose_doorway", {
        room_a: "Main lobby",
        room_b: "Quiet room",
        reason: "an agent assumed these connect"
      });
      expect(impossible.isError).toBe(true);
      expect((await api.fetchReview(run.runId)).proposals).toHaveLength(1);

      // 5. The venue declines, through the server.
      await api.declineProposalRemote(run.runId, proposal.id);

      // 6. "Refresh": the tab forgets everything and hydrates from the record.
      session.clearAgentSession();
      session.hydrateAgentSession(await api.fetchReview(run.runId));
      expect(session.getAgentSession().proposals).toHaveLength(0);
      expect(session.getAgentSession().disputes).toHaveLength(1);

      // 7. A later agent is told both sides.
      const both = textOf(await call("list_disputed_claims"));
      expect(both).toContain("venue declined");
      expect(both).toContain("15 cm step");
      const later = textOf(await call("check_route_clearance", { to: "Quiet room" }));
      expect(later).toContain("Verdict: UNKNOWN");
      expect(later).toContain("Disputed by visitors");

      // 8. Nothing an agent did touched the scene the page holds.
      expect(JSON.stringify(live)).toBe(sceneBefore);

      // 9. A second report the venue accepts: the server installs it and hands back the scene.
      await call("propose_access_change", {
        door: "Gallery threshold",
        step_free: false,
        reason: "a lip my chair cannot clear"
      });
      const second = session.getAgentSession().proposals[0];
      expect(second.persisted).toBe("saved");
      const approved = await api.approveProposalRemote(run.runId, second.id);
      expect(approved.run.sceneVersion).toBe(run.sceneVersion + 1);
      live = sceneModule.SpatialSceneSchema.parse(approved.scene);
      expect(live.doors.find((door) => door.id === "door-lobby-gallery")?.accessible).toBe(false);
      const audit = textOf(await call("check_accessibility"));
      expect(audit).toContain("Gallery threshold");

      // 10. The tool calls were audited on the server.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const ledger = await api.fetchReview(run.runId);
      expect(ledger.calls.map((entry) => entry.tool)).toContain("find_step_free_route");
      expect(ledger.proposals.map((entry) => entry.status).sort()).toEqual(["approved", "declined"]);
    },
    30_000
  );
});
