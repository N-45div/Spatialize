/**
 * The golden journey, driven by a real WebMCP host.
 *
 * Launches headless Chrome with the machine's own chrome://flags choices (so
 * #enable-webmcp-testing carries over), opens the studio, and invokes the
 * tools through Chrome's testing surface — navigator.modelContextTesting —
 * rather than through our own code. That is the browser calling us.
 *
 * Needs: Chrome 149+ with the flag on, the backend on :8787 and Vite on :4173.
 *   npm run host-check
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.env.APP_URL ?? "http://localhost:4173/#studio";
const API = process.env.API_URL ?? "http://127.0.0.1:8787";
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = mkdtempSync(path.join(tmpdir(), "spatialize-host-"));
try {
  copyFileSync(
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data", "Local State"),
    path.join(profile, "Local State")
  );
} catch {
  console.log("note: could not copy Chrome's Local State; the WebMCP flag may be off");
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
    APP
  ],
  { stdio: "ignore", windowsHide: true }
);

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a page target");
}

let nextId = 0;
const pending = new Map();
let ws;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.result?.exceptionDetails) return `THREW: ${reply.result.exceptionDetails.text}`;
  return reply.result?.result?.value ?? null;
};

/**
 * The browser's own tool surface. Chrome 149-151 exposed it as
 * `navigator.modelContextTesting`; 152 folded it onto `document.modelContext`
 * itself, and takes an object where the older one took a JSON string. Either
 * way this is the host calling the tools, not our code.
 */
const HOST = `(navigator.modelContextTesting ?? document.modelContext)`;
const viaHost = async (name, args = {}) => {
  const result = await callHost(name, args);
  // A host that throws is a failed step, not a crashed harness.
  return typeof result === "string" || result === null
    ? { isError: true, text: String(result) }
    : result;
};

const callHost = async (name, args = {}) =>
  evaluate(`(async () => {
    const host = ${HOST};
    let r;
    if (host.listTools) {
      // Chrome 149-151: tool name plus a JSON string of arguments.
      r = await host.executeTool(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))});
    } else {
      // Chrome 152: the RegisteredTool object from getTools(), and the
      // arguments still as a JSON string.
      const tools = await host.getTools();
      const tool = tools.find((candidate) => candidate.name === ${JSON.stringify(name)});
      if (!tool) throw new Error("no tool named ${name}");
      r = await host.executeTool(tool, ${JSON.stringify(JSON.stringify(args))});
    }
    const v = typeof r === "string" ? JSON.parse(r) : r;
    return { isError: !!v.isError, text: (v.content ?? []).map(c => c.text).join("\\n") };
  })()`);

const waitFor = async (expression, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await evaluate(expression)) === true) return true;
    await sleep(400);
  }
  return false;
};

const rows = [];
function check(step, ok, detail) {
  rows.push({ step, ok, detail: String(detail).replace(/\s+/g, " ").slice(0, 90) });
}

async function main() {
  const page = await pageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  };
  await send("Runtime.enable");
  await send("Page.enable");

  await waitFor("!!document.querySelector('.agent-dock')");
  const withRecord = await waitFor(
    "(document.querySelector('.dock-meta')?.textContent ?? '').startsWith('14')",
    40_000
  );
  check("host sees a venue record; write tools published", withRecord, await evaluate("document.querySelector('.dock-meta')?.textContent"));

  const listed = await evaluate(
    `(async () => {
      const host = ${HOST};
      const tools = await (host.listTools ? host.listTools() : host.getTools());
      return tools.map((tool) => tool.name).sort();
    })()`
  );
  check(
    "host lists 14 tools",
    Array.isArray(listed) && listed.length === 14,
    Array.isArray(listed) ? listed.join(", ") : JSON.stringify(listed)
  );

  const route = await viaHost("find_step_free_route", { to: "Quiet room" });
  check("route computed via host", !route.isError && route.text.includes("Step-free route"), route.text);

  const clearance = await viaHost("check_route_clearance", { to: "Quiet room", minimum_clear_width_mm: 760 });
  check("clearance verdict via host", /Verdict: (UNKNOWN|CLEAR)/.test(clearance.text), clearance.text);

  const report = await viaHost("propose_access_change", {
    door: "Quiet-room doorway",
    step_free: false,
    reason: "there is a 15 cm step here now"
  });
  check("report queued and saved to the venue record", !report.isError && report.text.includes("on the venue record"), report.text);

  const card = await waitFor("!!document.querySelector('.proposal-card')", 10_000);
  check("proposal card visible in the dock", card, await evaluate("document.querySelector('.proposal-card strong')?.textContent"));
  if (!card) {
    console.log("DEBUG store:", JSON.stringify(await evaluate(`(() => { const s = window.__spatialize?.getAgentSession?.(); return s ? { proposals: s.proposals.map(p => [p.id, p.persisted, p.failure]), disputes: s.disputes.length, calls: s.calls.slice(0,3).map(c => c.tool + ':' + c.outcome) } : 'no hook'; })()`)));
    const runIdNow = await evaluate("localStorage.getItem('spatialize-run-id')");
    try {
      const ledger = await (await fetch(`${API}/api/runs/${runIdNow}/review`)).json();
      console.log("DEBUG server ledger:", JSON.stringify(ledger.proposals.map((p) => [p.id, p.status])));
    } catch (error) {
      console.log("DEBUG ledger fetch failed:", error.message);
    }
    const resets = await evaluate("(window.__spatialize?.resets ?? []).map(s => s.split('\\n').slice(0, 7).join(' | '))");
    console.log("DEBUG store resets:", JSON.stringify(resets, null, 1));
  }

  const impossible = await viaHost("propose_doorway", { room_a: "Main lobby", room_b: "Quiet room", reason: "guess" });
  check("impossible doorway refused by the gate", impossible.isError && impossible.text.includes("rejected"), impossible.text);

  // The venue declines — a person clicking Reject in the dock.
  await evaluate("document.querySelector('.proposal-card .reject')?.click()");
  const dispute = await waitFor("!!document.querySelector('.dispute-card')", 10_000);
  check("declined report shown as a dispute", dispute, await evaluate("document.querySelector('.dispute-card strong')?.textContent"));

  // Refresh the page. The dispute must come back from the server.
  await send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await waitFor("!!document.querySelector('.agent-dock')");
  await waitFor("(document.querySelector('.dock-meta')?.textContent ?? '').startsWith('14')", 40_000);
  const survived = await waitFor("!!document.querySelector('.dispute-card')", 15_000);
  check("dispute survives a page reload", survived, await evaluate("document.querySelector('.dispute-card strong')?.textContent"));

  const both = await viaHost("list_disputed_claims");
  check("a later agent hears both sides", both.text.includes("venue declined") && both.text.includes("15 cm step"), both.text);

  const recheck = await viaHost("check_route_clearance", { to: "Quiet room" });
  check("route through the disputed door answers unknown", recheck.text.includes("UNKNOWN") && recheck.text.includes("Disputed"), recheck.text);

  const whatIf = await viaHost("simulate_closure", { landmark: "Elevator" });
  check("what-if changes nothing", whatIf.text.includes("Nothing was proposed"), whatIf.text);

  // The audit lives on the server; the dock shows only the newest few.
  const runId = await evaluate("localStorage.getItem('spatialize-run-id')");
  let audited = [];
  try {
    const ledger = await (await fetch(`${API}/api/runs/${runId}/review`)).json();
    audited = ledger.calls.map((entry) => entry.tool);
  } catch (error) {
    audited = [`ledger fetch failed: ${error.message}`];
  }
  check(
    "every host call audited on the server",
    audited.includes("find_step_free_route") && audited.includes("propose_access_change"),
    `${audited.length} entries: ${[...new Set(audited)].join(", ")}`
  );

  const width = Math.max(...rows.map((row) => row.step.length));
  console.log(`\nHost: ${await evaluate("navigator.userAgent")}\n`);
  for (const row of rows) console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.step.padEnd(width)}  ${row.detail}`);
  const failed = rows.filter((row) => !row.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
