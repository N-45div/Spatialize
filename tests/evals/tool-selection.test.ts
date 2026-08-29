/**
 * Probabilistic eval: given only the published tool contract, does a model
 * pick the right tool with the right arguments for what a person actually
 * says? Runs against OpenRouter when OPENROUTER_API_KEY is in .env or the
 * environment, and is skipped otherwise. `npm run evals` prints the table.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sampleScene } from "../../src/data/sample-scene";
import { buildTools } from "../../src/webmcp/tools";

function loadDotenv(): Record<string, string> {
  const file = path.resolve(__dirname, "../../.env");
  if (!existsSync(file)) return {};
  const entries = readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.split("=", 2) as [string, string]);
  return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value.trim()]));
}

const env = { ...loadDotenv(), ...process.env };
const apiKey = env.OPENROUTER_API_KEY;
const model = env.SPATIALIZE_OPENROUTER_MODEL || "google/gemini-3.6-flash";

interface Case {
  say: string;
  expectTool: string | string[];
  expectArgs?: (args: Record<string, unknown>) => boolean;
}

const CASES: Case[] = [
  { say: "Is the quiet room step-free from the main entrance?", expectTool: "find_step_free_route", expectArgs: (a) => /quiet/i.test(String(a.to)) },
  { say: "My chair is 700 mm wide. Can I get to the quiet room?", expectTool: "check_route_clearance", expectArgs: (a) => Number(a.minimum_clear_width_mm) === 700 },
  { say: "The quiet-room doorway has a step now. Please report it.", expectTool: "propose_access_change", expectArgs: (a) => a.step_free === false },
  { say: "The ramp is back at the quiet-room doorway, it's step-free again.", expectTool: "propose_access_change", expectArgs: (a) => a.step_free === true },
  { say: "There's a restroom in the north corridor that isn't on the plan.", expectTool: "propose_landmark", expectArgs: (a) => /corridor/i.test(String(a.in_room)) },
  { say: "The sign says the quiet room is actually called the Sensory room.", expectTool: "propose_label_correction", expectArgs: (a) => /sensory/i.test(String(a.new_label)) },
  { say: "Add a doorway between the main lobby and the quiet room.", expectTool: "propose_doorway" },
  { say: "Which places can't be reached without steps?", expectTool: "check_accessibility" },
  { say: "Are there any doors narrower than 900 mm?", expectTool: ["check_accessibility", "check_route_clearance"] },
  { say: "What is this building?", expectTool: "get_venue_overview" },
  { say: "List the places I can go.", expectTool: "list_destinations" },
  { say: "Tell me about the learning studio.", expectTool: "describe_room", expectArgs: (a) => /studio/i.test(String(a.room)) },
  { say: "Is anything in this plan unconfirmed or still under review?", expectTool: "list_data_issues" },
  { say: "Has anyone disagreed with the venue about access here?", expectTool: "list_disputed_claims" },
  { say: "Show me the gallery on the map.", expectTool: "focus_view", expectArgs: (a) => /gallery/i.test(String(a.target)) },
  { say: "Switch to the flat plan view.", expectTool: "focus_view", expectArgs: (a) => a.mode === "2d" },
  { say: "If the lift were out of service, what would I lose?", expectTool: "simulate_closure", expectArgs: (a) => /lift|elevator/i.test(String(a.landmark)) },
  { say: "Route me from the learning studio to the gallery.", expectTool: "find_step_free_route", expectArgs: (a) => /studio/i.test(String(a.from)) },
  { say: "I don't mind stairs. Fastest way to the quiet room?", expectTool: "find_step_free_route", expectArgs: (a) => a.step_free === false },
  { say: "How wide is the narrowest doorway on the way to the gallery?", expectTool: ["find_step_free_route", "check_route_clearance"] }
];

interface Outcome {
  say: string;
  expected: string;
  chosen: string;
  toolOk: boolean;
  argsOk: boolean | null;
}

async function ask(say: string, tools: unknown[]): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      tools,
      tool_choice: "auto",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant on a venue's web page. The page publishes tools. Answer the person by calling exactly one tool with the right arguments. Do not answer in prose."
        },
        { role: "user", content: say }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as {
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
  const call = payload.choices[0]?.message.tool_calls?.[0]?.function;
  if (!call) return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { name: call.name, args };
}

describe.skipIf(!apiKey)("tool selection by a model, from the contract alone", () => {
  it(
    "picks the right tool for what a person says",
    async () => {
      const tools = buildTools({
        getScene: () => sampleScene,
        focusLandmark: () => undefined,
        setViewMode: () => undefined,
        canPropose: true
      }).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
      }));

      const outcomes: Outcome[] = [];
      for (const testCase of CASES) {
        const chosen = await ask(testCase.say, tools);
        const expected = Array.isArray(testCase.expectTool) ? testCase.expectTool : [testCase.expectTool];
        const toolOk = chosen !== null && expected.includes(chosen.name);
        const argsOk = chosen && testCase.expectArgs ? testCase.expectArgs(chosen.args) : null;
        outcomes.push({
          say: testCase.say,
          expected: expected.join(" | "),
          chosen: chosen?.name ?? "(none)",
          toolOk,
          argsOk
        });
      }

      const toolAccuracy = outcomes.filter((row) => row.toolOk).length / outcomes.length;
      const argCases = outcomes.filter((row) => row.argsOk !== null);
      const argAccuracy = argCases.filter((row) => row.argsOk).length / Math.max(1, argCases.length);

      const table = [
        `model: ${model}`,
        "| said | expected | chosen | tool | args |",
        "|---|---|---|---|---|",
        ...outcomes.map(
          (row) =>
            `| ${row.say} | ${row.expected} | ${row.chosen} | ${row.toolOk ? "✓" : "✗"} | ${row.argsOk === null ? "–" : row.argsOk ? "✓" : "✗"} |`
        ),
        `tool selection: ${(toolAccuracy * 100).toFixed(0)}% (${outcomes.filter((r) => r.toolOk).length}/${outcomes.length})`,
        `argument accuracy: ${(argAccuracy * 100).toFixed(0)}% (${argCases.filter((r) => r.argsOk).length}/${argCases.length})`
      ].join("\n");
      console.log(`\n${table}\n`);

      expect(toolAccuracy).toBeGreaterThanOrEqual(0.75);
    },
    180_000
  );
});
