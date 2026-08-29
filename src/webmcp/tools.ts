/**
 * The WebMCP tool surface for Spatialize.
 *
 * Read tools answer from validated geometry. Write tools never touch the scene
 * directly: they build a mutation, run it through the topology gate, and either
 * queue a human-approvable proposal or hand the agent a structured refusal it
 * can act on. Nothing an agent says becomes venue data without both the
 * validator and a person agreeing.
 */
import type { SpatialScene } from "../domain/spatial-scene";
import {
  affectedDoorIds,
  describeMutation,
  gateMutation,
  LANDMARK_TYPES,
  sanitiseMutation,
  type LandmarkType,
  type SceneMutation
} from "./gate";
import {
  accessibilitySummary,
  adjacentRooms,
  CONFIDENCE_FLOOR,
  dataIssues,
  formatMetres,
  planRoute,
  polygonArea,
  resolveDoor,
  resolveLandmark,
  resolveRoom,
  roomCentroid,
  sharedBoundaryPoint,
  withDoorClosed,
  withLandmarkOutOfUse
} from "./queries";
import {
  getAgentSession,
  queueProposal,
  recordCall,
  recordRefusal,
  resolveProposal,
  settleProposal
} from "./session";
import type { ToolDefinition, ToolResult } from "./types";

export interface ToolContext {
  getScene: () => SpatialScene;
  /** Move the 3D view to a landmark so the person sees what the agent found. */
  focusLandmark: (landmarkId: string) => void;
  setViewMode: (mode: "2d" | "3d") => void;
  /**
   * Whether there is a venue record to propose against. Without one a
   * proposal has nowhere to be kept, so the write tools are not offered at
   * all rather than offered and quietly local.
   */
  canPropose?: boolean;
}

/** How many valid options to list back to an agent before summarising. */
const OPTION_CAP = 12;

/** "Label (id), Label (id), …and N more" — kept short so results stay inside budget. */
function named(items: { id: string; label: string }[]): string {
  const shown = items.slice(0, OPTION_CAP).map((item) => `${item.label} (${item.id})`);
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return boolStrict(args, key) ?? fallback;
}

/** A boolean, or null when the argument is missing or not boolean-shaped. */
function boolStrict(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** The provenance every write needs, or the failure to hand back without it. */
function requireReason(args: Record<string, unknown>): ToolResult | null {
  return str(args, "reason")
    ? null
    : fail("Say what the person observed in `reason` — it is kept as provenance.");
}

function daysAgo(timestamp: number) {
  const days = Math.max(0, Math.round((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * How current the data on these doorways is. The plan's extraction date is
 * the floor; a visitor report the venue accepted is fresher than that. Data
 * that is never confirmed is the reason accessibility information rots, so
 * the age is said out loud rather than implied.
 */
function freshnessLine(
  scene: SpatialScene,
  doors: { id: string; label: string }[],
  confirmations: { doorIds: string[]; at: number }[]
) {
  const extracted = Date.parse(scene.extraction.completedAt);
  const parts = doors.map((door) => {
    const latest = confirmations
      .filter((item) => item.doorIds.includes(door.id))
      .reduce<number | null>((best, item) => (best === null || item.at > best ? item.at : best), null);
    return latest === null
      ? `${door.label}: never confirmed by a visitor since the plan was read ${daysAgo(extracted)}`
      : `${door.label}: last confirmed by a visitor ${daysAgo(latest)}`;
  });
  return parts.length ? `Freshness — ${parts.join("; ")}.` : "Freshness — no doorways on this route.";
}

function impactSentence(impact: { lostStepFree: string[]; gainedStepFree: string[] }) {
  const lines: string[] = [];
  if (impact.lostStepFree.length) {
    lines.push(`Would remove step-free access to: ${impact.lostStepFree.join(", ")}.`);
  }
  if (impact.gainedStepFree.length) {
    lines.push(`Would restore step-free access to: ${impact.gainedStepFree.join(", ")}.`);
  }
  return lines.length ? lines.join(" ") : "No change to step-free reachability.";
}

/**
 * Shared tail for every write tool: clean, gate locally, then ask the venue
 * record. The agent is told what the server actually did — a proposal the
 * server refused is reported as refused, not as queued.
 */
async function submitMutation(
  context: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  rawMutation: SceneMutation
): Promise<ToolResult> {
  const mutation = sanitiseMutation(rawMutation);
  const scene = context.getScene();
  const description = describeMutation(scene, mutation);
  const verdict = gateMutation(scene, mutation);

  if (verdict.status === "refused") {
    recordRefusal(description, verdict.violations);
    const detail = verdict.violations
      .map((violation) => `- ${violation.path || "scene"}: ${violation.message}`)
      .join("\n");
    recordCall(toolName, args, "refused", `Gate refused: ${description}`);
    return fail(
      `The topology gate rejected this change, so the venue data is unchanged.\n\n` +
        `Proposed: ${description}\n` +
        `Rule violations (${verdict.violations.length}):\n${detail}\n\n` +
        `Fix the specific violation above and call the tool again. The gate is deterministic — ` +
        `the same input will always be rejected the same way.`
    );
  }

  const proposal = queueProposal({
    mutation,
    description,
    reason: mutation.reason,
    impact: verdict.impact,
    scene: verdict.scene
  });
  const settlement = await settleProposal(proposal.id);

  if (settlement.status === "refused") {
    // The server applied the same mutation to its own scene and would not
    // take it. Its rules are the ones that count, so the local entry goes.
    resolveProposal(proposal.id);
    recordCall(toolName, args, "refused", `Venue record refused: ${description}`);
    return fail(
      `The venue record refused this change: ${settlement.message ?? "no reason given"}\n` +
        `Proposed: ${description}\n` +
        `Nothing was changed. If the message says the venue moved on, call get_venue_overview ` +
        `and propose again against the current plan.`
    );
  }

  // Prefer what the server computed, since that is what the reviewer sees.
  const current = getAgentSession().proposals.find((item) => item.id === proposal.id) ?? proposal;
  let where = "No venue record is loaded, so it is held on this page only.";
  if (settlement.status === "saved") where = "It is on the venue record and survives a refresh.";
  if (settlement.status === "unreachable") {
    where =
      `The venue record could not be reached (${settlement.message ?? "no answer"}), ` +
      "so it is held on this page only until it can be.";
  }

  recordCall(toolName, args, "queued", `Queued for review: ${current.description}`);
  return ok(
    `This change is consistent with the rest of the plan and is queued for human review ` +
      `(${proposal.id}).\n` +
      `Proposed: ${current.description}\n` +
      `${impactSentence(current.impact)}\n${where}\n\n` +
      `The gate checked that the change does not contradict the plan. It cannot check whether ` +
      `the report is true of the building — only a person can. If the venue declines it, the ` +
      `report stays on the record as a disputed claim rather than being deleted.`
  );
}

export interface ToolSummary {
  name: string;
  description: string;
  readOnly: boolean;
  params: { name: string; type: string; required: boolean }[];
}

/**
 * The published tool contract, for display. Judges and curious visitors can
 * read what this page offers an agent without opening the source.
 */
export function describeToolSurface(scene: SpatialScene): ToolSummary[] {
  const noop = () => undefined;
  return buildTools({ getScene: () => scene, focusLandmark: noop, setViewMode: noop }).map(
    (tool) => {
      const properties = (tool.inputSchema?.properties ?? {}) as Record<
        string,
        { type?: string }
      >;
      const required = new Set(tool.inputSchema?.required ?? []);
      return {
        name: tool.name,
        description: tool.description,
        readOnly: tool.annotations?.readOnlyHint === true,
        params: Object.entries(properties).map(([name, schema]) => ({
          name,
          type: schema?.type ?? "string",
          required: required.has(name)
        }))
      };
    }
  );
}

export function buildTools(context: ToolContext): ToolDefinition[] {
  // Read tools echo venue-supplied names, and a name is user-generated content
  // the moment someone's correction is approved. An agent reading a room label
  // is reading text a stranger wrote, so the surface says so — that is what
  // untrustedContentHint is for. Labels are also stripped of control characters
  // and capped on the way in, and a person approves each one.
  const readOnly = { readOnlyHint: true, untrustedContentHint: true } as const;
  // Write tools echo venue labels too, in their refusals and option lists.
  const writes = { untrustedContentHint: true } as const;

  const tools: ToolDefinition[] = [
    {
      name: "get_venue_overview",
      description:
        "Summarise this venue: its name, footprint in metres, how many rooms, doors and " +
        "landmarks were extracted from the floor plan, and whether the extracted data has " +
        "been reviewed by a person yet. Call this first to orient yourself.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const summary = accessibilitySummary(scene);
        const text =
          `${scene.name}\n` +
          `Footprint: ${scene.dimensions.width} x ${scene.dimensions.depth} m, ` +
          `ceiling ${scene.dimensions.ceilingHeight} m.\n` +
          `Extracted: ${scene.rooms.length} rooms, ${scene.doors.length} doors, ` +
          `${scene.landmarks.length} landmarks.\n` +
          `Review status: ${scene.review.status}` +
          (scene.review.issues.length ? ` (${scene.review.issues.length} open issue(s))` : "") +
          `.\n` +
          `Step-free from the main entrance: ${summary.reachable.length ? summary.reachable.join(", ") : "nothing"}.\n` +
          `Not step-free: ${summary.blocked.length ? summary.blocked.map((item) => item.label).join(", ") : "none"}.\n` +
          `Source plan SHA-256: ${scene.sourceSha256.slice(0, 16)}…`;
        recordCall("get_venue_overview", args, "answered", scene.name);
        return ok(text);
      }
    },

    {
      name: "list_destinations",
      description:
        "List the places in this venue a visitor can be routed to — entrances, restrooms, " +
        "lifts, stairs and named destinations — with the id you should pass to " +
        "find_step_free_route.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [...LANDMARK_TYPES],
            description: "Optional filter by landmark type."
          }
        },
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const filter = str(args, "type");
        const landmarks = filter
          ? scene.landmarks.filter((item) => item.type === filter)
          : scene.landmarks;
        if (!landmarks.length) {
          recordCall("list_destinations", args, "answered", "no matches");
          return ok(filter ? `No landmarks of type "${filter}" in this venue.` : "No landmarks extracted.");
        }
        const lines = landmarks.map(
          (item) =>
            `- ${item.label} (id: ${item.id}, type: ${item.type}, ` +
            `extraction confidence ${(item.confidence * 100).toFixed(0)}%)`
        );
        recordCall("list_destinations", args, "answered", `${landmarks.length} landmark(s)`);
        return ok(`${landmarks.length} landmark(s) in ${scene.name}:\n${lines.join("\n")}`);
      }
    },

    {
      name: "find_step_free_route",
      description:
        "Compute a route between two places in this venue and report it turn by turn. " +
        "By default it only returns step-free routes suitable for a wheelchair user. If no " +
        "step-free route exists, it names the exact door that blocks it rather than just " +
        "refusing. The 3D view on the page follows along so the person sees the route.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination landmark id or label." },
          from: {
            type: "string",
            description: "Starting landmark id or label. Defaults to the main entrance."
          },
          step_free: {
            type: "boolean",
            description: "Require a step-free route. Defaults to true."
          }
        },
        required: ["to"],
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const to = str(args, "to");
        if (!to) return fail("Pass a destination in `to`. Use list_destinations to see the options.");

        const stepFree = bool(args, "step_free", true);
        const { plan, from, to: target, fallbackUsed, fromUnresolved } = planRoute(scene, {
          to,
          from: str(args, "from") || null,
          stepFree
        });

        if (fromUnresolved) {
          recordCall("find_step_free_route", args, "error", `unknown origin "${str(args, "from")}"`);
          return fail(
            `No landmark in ${scene.name} matches the starting point "${str(args, "from")}". ` +
              `Call list_destinations for valid ids, or leave \`from\` out to start at the main entrance.`
          );
        }
        if (!target) {
          recordCall("find_step_free_route", args, "error", `unknown destination "${to}"`);
          return fail(
            `No landmark in ${scene.name} matches "${to}". ` +
              `Call list_destinations to see valid ids.`
          );
        }

        const origin = from?.label ?? "the main entrance";

        if (!plan.found) {
          recordCall("find_step_free_route", args, "answered", `no route to ${target.label}`);
          return ok(
            `No route at all from ${origin} to ${target.label} exists in the extracted route ` +
              `graph. This usually means the floor plan extraction missed a connection — ` +
              `call list_data_issues to see what is unresolved.`
          );
        }

        context.focusLandmark(target.id);

        const steps = plan.steps
          .map((step, index) => {
            const through = step.doorLabel
              ? ` through ${step.doorLabel}${step.doorWidth ? ` (${step.doorWidth} m clear)` : ""}`
              : "";
            return `${index + 1}. ${step.fromRoom} → ${step.toRoom}${through} · ${formatMetres(step.distance)}`;
          })
          .join("\n");

        if (fallbackUsed) {
          const blockers = plan.blockers
            .map((item) => `"${item.doorLabel}" (${item.doorId}) between ${item.between.join(" and ")}`)
            .join("; ");
          recordCall(
            "find_step_free_route",
            args,
            "answered",
            `${target.label}: blocked by ${plan.blockers.length} door(s)`
          );
          return ok(
            `There is NO step-free route from ${origin} to ${target.label}.\n\n` +
              `The only available route is ${formatMetres(plan.totalDistance)} and is blocked by: ` +
              `${blockers || "a door recorded as not step-free"}.\n\n` +
              `Route if steps are acceptable:\n${steps}\n\n` +
              `If that door has since been made step-free, report it with propose_access_change.`
          );
        }

        recordCall(
          "find_step_free_route",
          args,
          "answered",
          `${target.label}: ${formatMetres(plan.totalDistance)}`
        );
        const widths = plan.steps
          .map((step) => step.doorWidth)
          .filter((width): width is number => typeof width === "number");
        const narrowest = widths.length ? Math.min(...widths) : null;

        return ok(
          `${stepFree ? "Step-free route" : "Route"} from ${origin} to ${target.label}: ` +
            `${formatMetres(plan.totalDistance)} over ${plan.steps.length} segment(s).` +
            (narrowest ? ` Narrowest doorway on this route: ${narrowest} m clear.` : "") +
            `\n\n${steps}\n\n` +
            `Widths are given so the person can judge against their own equipment rather than ` +
            `a single threshold. Computed from the floor plan's geometry, which is checked for ` +
            `internal consistency — not verified against the building itself.`
        );
      }
    },

    {
      name: "describe_room",
      description:
        "Describe one room: its area, category, which rooms it connects to and through " +
        "which doors, and how confident the extraction was about it.",
      inputSchema: {
        type: "object",
        properties: { room: { type: "string", description: "Room id or label." } },
        required: ["room"],
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const query = str(args, "room");
        const room = resolveRoom(scene, query);
        if (!room) {
          recordCall("describe_room", args, "error", `unknown room "${query}"`);
          return fail(
            `No room in ${scene.name} matches "${query}". Known rooms: ` +
              `${named(scene.rooms)}.`
          );
        }
        const neighbours = adjacentRooms(scene, room.id);
        const neighbourText = neighbours.length
          ? neighbours
              .map(
                (item) =>
                  `- ${item.roomLabel} through ${item.doorLabel} ` +
                  `(${item.doorWidth} m, ${item.accessible ? "step-free" : "NOT step-free"})`
              )
              .join("\n")
          : "- no doors recorded on this room";

        recordCall("describe_room", args, "answered", room.label);
        return ok(
          `${room.label} (${room.id})\n` +
            `Category: ${room.category}. Floor area: ${polygonArea(room.polygon).toFixed(1)} m². ` +
            `Elevation: ${room.elevation} m.\n` +
            `Extraction confidence: label ${(room.evidence.label.confidence * 100).toFixed(0)}%, ` +
            `geometry ${(room.evidence.geometry.confidence * 100).toFixed(0)}%.\n` +
            `Connects to:\n${neighbourText}`
        );
      }
    },

    {
      name: "check_accessibility",
      description:
        "Audit the whole venue for step-free access: which destinations are reachable from " +
        "the main entrance without steps, which are not and why, which doors are recorded " +
        "as barriers, and every doorway's clear width so the person can judge it against " +
        "their own equipment. Use check_route_clearance for one person's needs on one route.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const summary = accessibilitySummary(scene);
        const blocked = summary.blocked.length
          ? summary.blocked
              .map(
                (item) =>
                  `- ${item.label}${item.blockers.length ? ` — blocked by ${item.blockers.join(", ")}` : " — no route found at all"}`
              )
              .join("\n")
          : "- none";
        // Every doorway width, not just the ones under one threshold. A scooter
        // user and a cane user disagree about what counts as passable, so the
        // measurement is reported and the judgement is left to the person.
        const widths = [...scene.doors]
          .sort((a, b) => a.width - b.width)
          .map((door) => `- ${door.label}: ${door.width} m clear`)
          .join("\n");
        const disputes = getAgentSession().disputes.length;

        recordCall(
          "check_accessibility",
          args,
          "answered",
          `${summary.reachable.length} reachable, ${summary.blocked.length} blocked`
        );
        return ok(
          `Step-free audit for ${scene.name}\n\n` +
            `Reachable without steps from the main entrance (${summary.reachable.length}):\n` +
            `${summary.reachable.map((label) => `- ${label}`).join("\n") || "- none"}\n\n` +
            `Not reachable without steps (${summary.blocked.length}):\n${blocked}\n\n` +
            `Doorway clear widths, narrowest first:\n${widths}\n\n` +
            `Doors recorded as barriers: ${summary.inaccessibleDoors.join(", ") || "none"}.` +
            (disputes ? ` ${disputes} declined visitor report(s) — call list_disputed_claims.` : "") +
            `\n\n"Step-free" here means no steps on the route. It is not a judgement that the ` +
            `route suits any particular person, so report the widths above rather than a verdict.`
        );
      }
    },

    {
      name: "list_data_issues",
      description:
        "List everything about this venue's extracted data that is unresolved: open review " +
        "issues raised by the validator, and entities the vision model was unsure about. " +
        "Use this to find what a visitor could usefully confirm or correct on the ground.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const issues = dataIssues(scene);
        const openText = issues.openIssues.length
          ? issues.openIssues.map((item) => `- [${item.severity}] ${item.message} (${item.id})`).join("\n")
          : "- none";
        const lowText = issues.lowConfidence.length
          ? issues.lowConfidence
              .map(
                (item) =>
                  `- ${item.kind} "${item.label}" (${item.id}) at ${(item.confidence * 100).toFixed(0)}% confidence`
              )
              .join("\n")
          : "- none below 85%";

        recordCall(
          "list_data_issues",
          args,
          "answered",
          `${issues.openIssues.length} issue(s), ${issues.lowConfidence.length} low-confidence`
        );
        return ok(
          `Review status: ${issues.reviewStatus}\n\n` +
            `Open validator issues:\n${openText}\n\n` +
            `Low-confidence extractions:\n${lowText}`
        );
      }
    },

    {
      name: "list_disputed_claims",
      description:
        "List access reports the venue team declined to accept. Visitors are often a better " +
        "source on a building than the building's own record, so declined reports are kept " +
        "rather than deleted. Call this before telling someone a route is fine — the venue " +
        "may say step-free where a visitor reported otherwise.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: (args) => {
        const { disputes } = getAgentSession();
        if (!disputes.length) {
          recordCall("list_disputed_claims", args, "answered", "no disputes");
          return ok("No declined reports on this venue. Nothing is in dispute.");
        }
        const lines = disputes
          .slice(0, 8)
          .map((item) => `- ${item.description}\n  Visitor said: "${item.reason}" — venue declined this.`)
          .join("\n");
        recordCall("list_disputed_claims", args, "answered", `${disputes.length} disputed`);
        return ok(
          `${disputes.length} access report(s) the venue declined but which remain on the ` +
            `record:\n${lines}\n\nThese are unresolved disagreements, not corrections. Tell the ` +
            `person both sides and let them decide.`
        );
      }
    },

    {
      name: "check_route_clearance",
      description:
        "Check one route against a specific person's needs: the narrowest doorway they can " +
        "pass, in millimetres, and whether steps rule it out. Answers clear, blocked or " +
        "unknown — unknown when a doorway on the route has an unconfirmed measurement or an " +
        "unresolved visitor dispute. Lists every limiting doorway so the person decides.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination landmark id or label." },
          from: {
            type: "string",
            description: "Starting landmark id or label. Defaults to the main entrance."
          },
          minimum_clear_width_mm: {
            type: "number",
            description:
              "Narrowest doorway the person can pass, in millimetres. For example 760 for many manual wheelchairs."
          },
          require_step_free: {
            type: "boolean",
            description: "Whether steps rule the route out. Defaults to true."
          }
        },
        required: ["to"],
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const to = str(args, "to");
        if (!to) return fail("Pass a destination in `to`. Use list_destinations to see the options.");

        const minWidthMm = num(args, "minimum_clear_width_mm");
        const stepFree = bool(args, "require_step_free", true);
        const { plan, from, to: target, fallbackUsed, fromUnresolved } = planRoute(scene, {
          to,
          from: str(args, "from") || null,
          stepFree
        });
        if (fromUnresolved) {
          recordCall("check_route_clearance", args, "error", `unknown origin "${str(args, "from")}"`);
          return fail(
            `No landmark in ${scene.name} matches the starting point "${str(args, "from")}". ` +
              `Call list_destinations for valid ids, or leave \`from\` out to start at the main entrance.`
          );
        }
        if (!target) {
          recordCall("check_route_clearance", args, "error", `unknown destination "${to}"`);
          return fail(`No landmark in ${scene.name} matches "${to}". Call list_destinations for valid ids.`);
        }
        const origin = from?.label ?? "the main entrance";
        const need = minWidthMm === null ? "" : ` for a ${Math.round(minWidthMm)} mm clearance`;

        if (!plan.found) {
          recordCall("check_route_clearance", args, "answered", `${target.label}: unknown, no route`);
          return ok(
            `Verdict: UNKNOWN — no route from ${origin} to ${target.label} exists in the extracted ` +
              `route graph, which usually means the floor-plan extraction missed a connection. ` +
              `Call list_data_issues.`
          );
        }

        const doorsById = new Map(scene.doors.map((door) => [door.id, door]));
        const routeDoors = plan.steps
          .map((step) => (step.doorId ? doorsById.get(step.doorId) : undefined))
          .filter((door): door is NonNullable<typeof door> => door !== undefined);
        const mm = (width: number) => `${Math.round(width * 1000)} mm`;

        const limiting = minWidthMm === null
          ? []
          : routeDoors.filter((door) => Math.round(door.width * 1000) < minWidthMm);
        const unconfirmed = routeDoors.filter(
          (door) =>
            door.confidence < CONFIDENCE_FLOOR || door.evidence.width.confidence < CONFIDENCE_FLOOR
        );
        const routeDoorIds = new Set(routeDoors.map((door) => door.id));
        const disputed = getAgentSession().disputes.filter(
          (dispute) =>
            dispute.mutation !== null &&
            affectedDoorIds(dispute.mutation).some((id) => routeDoorIds.has(id))
        );
        const narrowest = routeDoors.reduce<(typeof routeDoors)[number] | null>(
          (best, door) => (best === null || door.width < best.width ? door : best),
          null
        );

        let verdict: "CLEAR" | "BLOCKED" | "UNKNOWN" = "CLEAR";
        if ((fallbackUsed && stepFree) || limiting.length) verdict = "BLOCKED";
        else if (unconfirmed.length || disputed.length) verdict = "UNKNOWN";

        const lines: string[] = [
          `Verdict: ${verdict} — ${origin} to ${target.label}${need}, ${formatMetres(plan.totalDistance)}.`
        ];
        if (fallbackUsed && stepFree) {
          lines.push(
            `Steps: the only route passes ${plan.blockers.map((item) => `"${item.doorLabel}"`).join(", ")}, recorded as not step-free.`
          );
        }
        if (limiting.length) {
          lines.push(
            `Too narrow: ${limiting.map((door) => `${door.label} (${mm(door.width)})`).join(", ")}.`
          );
        }
        if (narrowest) lines.push(`Narrowest doorway on the route: ${narrowest.label} at ${mm(narrowest.width)} clear.`);
        if (unconfirmed.length) {
          lines.push(
            `Unconfirmed measurements: ${unconfirmed
              .map((door) => `${door.label} (extracted at ${Math.round(Math.min(door.confidence, door.evidence.width.confidence) * 100)}% confidence)`)
              .join(", ")}.`
          );
        }
        if (disputed.length) {
          lines.push(
            `Disputed by visitors: ${disputed.map((item) => `${item.description} — "${item.reason}"`).join("; ")}.`
          );
        }
        lines.push(freshnessLine(scene, routeDoors, getAgentSession().confirmations));
        lines.push(
          "Widths come from the floor plan, checked for consistency, not measured on site. Turning " +
            "space, thresholds and gradients are not in this venue's data, so this is a doorway-width " +
            "and steps check only."
        );

        context.focusLandmark(target.id);
        recordCall("check_route_clearance", args, "answered", `${target.label}: ${verdict.toLowerCase()}`);
        return ok(lines.join("\n"));
      }
    },

    {
      name: "simulate_closure",
      description:
        "What-if, changing nothing: if a doorway were closed or a lift out of use, which " +
        "destinations would stop being reachable without steps from the main entrance, and " +
        "which would still be? For planned works or an out-of-service lift. Nothing is " +
        "proposed or recorded.",
      inputSchema: {
        type: "object",
        properties: {
          door: { type: "string", description: "A doorway to treat as closed, by name or id." },
          landmark: {
            type: "string",
            description: "A lift or other landmark to treat as out of use, by name or id."
          }
        },
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const doorQuery = str(args, "door");
        const landmarkQuery = str(args, "landmark");
        if (!doorQuery && !landmarkQuery) {
          return fail("Name a `door` to treat as closed, or a `landmark` to treat as out of use.");
        }

        let after: SpatialScene;
        let subject: string;
        if (doorQuery) {
          const door = resolveDoor(scene, doorQuery);
          if (!door) {
            return fail(`No doorway in ${scene.name} matches "${doorQuery}". The doorways here are: ${named(scene.doors)}.`);
          }
          after = withDoorClosed(scene, door.id);
          subject = `"${door.label}" were closed`;
        } else {
          const landmark = resolveLandmark(scene, landmarkQuery);
          if (!landmark) {
            return fail(`No landmark in ${scene.name} matches "${landmarkQuery}". Call list_destinations for valid ids.`);
          }
          after = withLandmarkOutOfUse(scene, landmark.id);
          subject = `"${landmark.label}" were out of use`;
        }

        const before = accessibilitySummary(scene);
        const next = accessibilitySummary(after);
        const labels = new Map(scene.landmarks.map((item) => [item.id, item.label]));
        const lost = [...before.reachableIds]
          .filter((id) => !next.reachableIds.has(id))
          .map((id) => labels.get(id) ?? id)
          .sort();

        recordCall("simulate_closure", args, "answered", `${subject}: ${lost.length} lost`);
        return ok(
          `If ${subject}: ` +
            (lost.length
              ? `${lost.length} destination(s) would lose step-free access from the main entrance — ${lost.join(", ")}.`
              : "no destination would lose step-free access from the main entrance.") +
            `\nStill reachable without steps: ${next.reachable.join(", ") || "none"}.\n` +
            `A simulation over the current plan. Nothing was proposed or changed.`
        );
      }
    },

    {
      name: "focus_view",
      description:
        "Move the 3D venue view on this page to a landmark, and optionally switch between " +
        "the 3D walkthrough and the flat 2D plan. Use it to show a person what you are " +
        "talking about instead of only describing it.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Landmark id or label to focus." },
          mode: { type: "string", enum: ["2d", "3d"], description: "Optional view mode." }
        },
        additionalProperties: false
      },
      annotations: readOnly,
      execute: (args) => {
        const scene = context.getScene();
        const mode = str(args, "mode");
        if (mode === "2d" || mode === "3d") context.setViewMode(mode);

        const query = str(args, "target");
        if (!query) {
          recordCall("focus_view", args, "answered", `view mode ${mode || "unchanged"}`);
          return ok(mode ? `Switched the page to the ${mode} view.` : "Nothing to focus.");
        }
        const landmark = resolveLandmark(scene, query);
        if (!landmark) {
          recordCall("focus_view", args, "error", `unknown landmark "${query}"`);
          return fail(`No landmark matches "${query}". Call list_destinations for valid ids.`);
        }
        context.focusLandmark(landmark.id);
        recordCall("focus_view", args, "answered", `focused ${landmark.label}`);
        return ok(
          `The page is now showing ${landmark.label}${mode ? ` in the ${mode} view` : ""}, ` +
            `with the route from the main entrance highlighted.`
        );
      }
    },

    {
      name: "propose_access_change",
      description:
        "Propose that a doorway's step-free status has changed in the real world — a visitor " +
        "finds a ramp removed, or a step installed. The proposal is checked against the " +
        "venue's topology rules and then waits for someone on the venue team to approve it. " +
        "Nothing changes on the strength of this call alone.",
      inputSchema: {
        type: "object",
        properties: {
          door: {
            type: "string",
            description: "The doorway, by its name or id. Names work: 'Quiet-room doorway'."
          },
          step_free: {
            type: "boolean",
            description: "True if the doorway IS now step-free, false if it is now blocked."
          },
          reason: {
            type: "string",
            description: "What the person actually observed, in their own words."
          }
        },
        required: ["door", "step_free", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const scene = context.getScene();
        const query = str(args, "door");
        const door = resolveDoor(scene, query);
        if (!door) {
          recordCall("propose_access_change", args, "error", `unknown door "${query}"`);
          return fail(
            `No doorway in ${scene.name} matches "${query}". The doorways here are: ` +
              `${named(scene.doors)}.`
          );
        }
        const missingReason = requireReason(args);
        if (missingReason) return missingReason;
        const stepFree = boolStrict(args, "step_free");
        if (stepFree === null) {
          // Defaulting here would file "blocked" on a visitor's behalf when
          // they never said so. Ask instead.
          return fail(
            "Pass `step_free` as true (the doorway is step-free now) or false (it is blocked now)."
          );
        }

        return submitMutation(context, "propose_access_change", args, {
          kind: "set-door-accessible",
          doorId: door.id,
          accessible: stepFree,
          reason: str(args, "reason"),
          cascade: true
        });
      }
    },

    {
      name: "propose_doorway",
      description:
        "Propose a doorway the floor-plan extraction missed, by naming the two rooms it " +
        "joins. Say which rooms in plain language and the page works out where the doorway " +
        "would have to sit. The topology gate rejects a doorway between rooms whose walls do " +
        "not actually touch, so a guess cannot become venue data.",
      inputSchema: {
        type: "object",
        properties: {
          room_a: { type: "string", description: "One room the doorway joins, by name." },
          room_b: { type: "string", description: "The other room the doorway joins, by name." },
          label: { type: "string", description: "Optional name for the doorway." },
          step_free: {
            type: "boolean",
            description: "Whether the doorway is step-free. Defaults to true."
          },
          width: {
            type: "number",
            description: "Clear width in metres, if the person measured it. Defaults to 0.9."
          },
          reason: { type: "string", description: "What the person observed." }
        },
        required: ["room_a", "room_b", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const scene = context.getScene();
        const reason = str(args, "reason");
        if (!reason) {
          return fail("Say what the person observed in `reason` — it is kept as provenance.");
        }

        const roomA = resolveRoom(scene, str(args, "room_a"));
        const roomB = resolveRoom(scene, str(args, "room_b"));
        const known = named(scene.rooms);

        if (!roomA || !roomB) {
          const missing = !roomA ? str(args, "room_a") : str(args, "room_b");
          recordCall("propose_doorway", args, "error", `unknown room "${missing}"`);
          return fail(`No room in ${scene.name} matches "${missing}". The rooms here are: ${known}.`);
        }
        if (roomA.id === roomB.id) {
          recordCall("propose_doorway", args, "error", "both rooms were the same");
          return fail(
            `A doorway joins two different rooms, and both arguments resolved to ` +
              `"${roomA.label}". The rooms here are: ${known}.`
          );
        }

        const { point } = sharedBoundaryPoint(roomA, roomB);
        const width = num(args, "width") ?? 0.9;

        return submitMutation(context, "propose_doorway", args, {
          kind: "add-door",
          label: str(args, "label") || `${roomA.label} to ${roomB.label}`,
          connects: [roomA.id, roomB.id],
          position: point,
          width,
          accessible: bool(args, "step_free", true),
          reason
        });
      }
    },

    {
      name: "propose_landmark",
      description:
        "Propose a landmark the floor-plan extraction missed — a restroom, lift, entrance or " +
        "destination someone found on the ground. Name the room it is in and the page places " +
        "it; there is no need to work out coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", description: "What the place is called." },
          type: {
            type: "string",
            enum: [...LANDMARK_TYPES],
            description: "What kind of place it is."
          },
          in_room: {
            type: "string",
            description: "The room it sits in, by name. For example 'North corridor'."
          },
          reason: { type: "string", description: "What the person observed." }
        },
        required: ["label", "type", "in_room", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const scene = context.getScene();
        const label = str(args, "label");
        const landmarkType = str(args, "type");
        const reason = str(args, "reason");
        const allowed: readonly string[] = LANDMARK_TYPES;

        if (!label) return fail("Give the landmark a name in `label`.");
        if (!allowed.includes(landmarkType)) {
          return fail(`\`type\` must be one of: ${allowed.join(", ")}.`);
        }
        if (!reason) {
          return fail("Say what the person observed in `reason` — it is kept as provenance.");
        }

        const query = str(args, "in_room");
        const room = resolveRoom(scene, query);
        if (!room) {
          recordCall("propose_landmark", args, "error", `unknown room "${query}"`);
          return fail(
            `No room in ${scene.name} matches "${query}". The rooms here are: ` +
              `${named(scene.rooms)}.`
          );
        }

        return submitMutation(context, "propose_landmark", args, {
          kind: "add-landmark",
          label,
          landmarkType: landmarkType as LandmarkType,
          position: roomCentroid(room.polygon),
          reason
        });
      }
    },

    {
      name: "propose_label_correction",
      description:
        "Propose a corrected name for a room, doorway or landmark that the vision model read " +
        "wrongly from the floor plan. Waits for human approval like every other change.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "The room, doorway or landmark to rename, by its current name or id."
          },
          new_label: { type: "string", description: "The correct name." },
          reason: { type: "string", description: "How the person knows." }
        },
        required: ["entity", "new_label", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const scene = context.getScene();
        const query = str(args, "entity");
        const label = str(args, "new_label");
        const reason = str(args, "reason");
        if (!label) return fail("Give the corrected name in `new_label`.");
        if (!reason) return fail("Say how the person knows in `reason` — it is kept as provenance.");

        const room = resolveRoom(scene, query);
        const door = room ? null : resolveDoor(scene, query);
        const landmark = room || door ? null : resolveLandmark(scene, query);
        const target = room ?? door ?? landmark;

        if (!target) {
          recordCall("propose_label_correction", args, "error", `unknown entity "${query}"`);
          return fail(
            `No room, doorway or landmark in ${scene.name} matches "${query}". ` +
              `Use describe_room or list_destinations to see what is here.`
          );
        }

        let entityKind: "room" | "door" | "landmark" = "landmark";
        if (room) entityKind = "room";
        else if (door) entityKind = "door";

        return submitMutation(context, "propose_label_correction", args, {
          kind: "relabel",
          entityKind,
          entityId: target.id,
          label,
          reason
        });
      }
    }
  ];

  const offered =
    context.canPropose === false ? tools.filter((tool) => tool.annotations?.readOnlyHint) : tools;

  // Every call is logged, including the argument-validation failures that
  // return before a tool body reaches its own recordCall. The body's own
  // entry wins when it made one, because it knows the outcome's meaning.
  return offered.map((tool) => ({
    ...tool,
    annotations: tool.annotations ?? writes,
    execute: async (args) => {
      const before = getAgentSession().calls[0]?.id;
      const result = await tool.execute(args);
      if (getAgentSession().calls[0]?.id === before) {
        const firstLine = result.content[0]?.text.split("\n")[0] ?? "";
        recordCall(tool.name, args, result.isError ? "error" : "answered", firstLine.slice(0, 120));
      }
      return result;
    }
  }));
}
