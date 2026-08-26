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
import { describeMutation, gateMutation, type SceneMutation } from "./gate";
import {
  accessibilitySummary,
  adjacentRooms,
  dataIssues,
  formatMetres,
  planRoute,
  polygonArea,
  resolveDoor,
  resolveLandmark,
  resolveRoom
} from "./queries";
import { queueProposal, recordCall, recordRefusal } from "./session";
import type { ToolDefinition, ToolResult } from "./types";

export interface ToolContext {
  getScene: () => SpatialScene;
  /** Move the 3D view to a landmark so the person sees what the agent found. */
  focusLandmark: (landmarkId: string) => void;
  setViewMode: (mode: "2d" | "3d") => void;
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
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Shared tail for every write tool: gate, then queue or refuse. */
function submitMutation(
  context: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  mutation: SceneMutation
): ToolResult {
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

  const impactLines: string[] = [];
  if (verdict.impact.lostStepFree.length) {
    impactLines.push(
      `Would remove step-free access to: ${verdict.impact.lostStepFree.join(", ")}.`
    );
  }
  if (verdict.impact.gainedStepFree.length) {
    impactLines.push(
      `Would restore step-free access to: ${verdict.impact.gainedStepFree.join(", ")}.`
    );
  }
  if (!impactLines.length) impactLines.push("No change to step-free reachability.");

  recordCall(toolName, args, "queued", `Queued for review: ${description}`);
  return ok(
    `Change passed the topology gate and is queued for human approval (${proposal.id}).\n` +
      `Proposed: ${description}\n` +
      `${impactLines.join(" ")}\n\n` +
      `It is not live yet. Someone on the venue team approves or rejects it in the ` +
      `Agent panel on this page.`
  );
}

export function buildTools(context: ToolContext): ToolDefinition[] {
  const readOnly = { readOnlyHint: true } as const;

  return [
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
            enum: ["entrance", "elevator", "stairs", "restroom", "destination"],
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
        const { plan, from, to: target, fallbackUsed } = planRoute(scene, {
          to,
          from: str(args, "from") || null,
          stepFree
        });

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
              `If that door has since been made accessible, report it with report_access_change.`
          );
        }

        recordCall(
          "find_step_free_route",
          args,
          "answered",
          `${target.label}: ${formatMetres(plan.totalDistance)}`
        );
        return ok(
          `${stepFree ? "Step-free route" : "Route"} from ${origin} to ${target.label}: ` +
            `${formatMetres(plan.totalDistance)} over ${plan.steps.length} segment(s).\n\n${steps}\n\n` +
            `Computed from the validated floor-plan geometry, not estimated.`
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
              `${scene.rooms.map((item) => `${item.label} (${item.id})`).join(", ")}.`
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
        "as barriers, and which doorways are too narrow for a wheelchair.",
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
        const narrow = summary.narrowDoors.length
          ? summary.narrowDoors.map((item) => `- ${item.label}: ${item.width} m clear width`).join("\n")
          : "- none below 0.85 m";

        recordCall(
          "check_accessibility",
          args,
          "answered",
          `${summary.reachable.length} reachable, ${summary.blocked.length} blocked`
        );
        return ok(
          `Step-free audit for ${scene.name}\n\n` +
            `Reachable step-free from the main entrance (${summary.reachable.length}):\n` +
            `${summary.reachable.map((label) => `- ${label}`).join("\n") || "- none"}\n\n` +
            `Not reachable step-free (${summary.blocked.length}):\n${blocked}\n\n` +
            `Doors recorded as barriers: ${summary.inaccessibleDoors.join(", ") || "none"}\n\n` +
            `Narrow doorways:\n${narrow}`
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
      name: "report_access_change",
      description:
        "Report that a doorway's step-free status has changed in the real world — for " +
        "example a visitor finds a temporary ramp removed, or a step installed. The change " +
        "is validated against the venue's topology rules and then queued for a human on the " +
        "venue team to approve. It does not go live on your say-so.",
      inputSchema: {
        type: "object",
        properties: {
          door: { type: "string", description: "Door id or label, from describe_room or check_accessibility." },
          step_free: {
            type: "boolean",
            description: "True if the door IS now step-free, false if it is now blocked."
          },
          reason: {
            type: "string",
            description: "What the person actually observed, in their words."
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
          recordCall("report_access_change", args, "error", `unknown door "${query}"`);
          return fail(
            `No door in ${scene.name} matches "${query}". Known doors: ` +
              `${scene.doors.map((item) => `${item.label} (${item.id})`).join(", ")}.`
          );
        }
        const reason = str(args, "reason");
        if (!reason) return fail("Pass what the person observed in `reason` — it is stored as provenance.");

        return submitMutation(context, "report_access_change", args, {
          kind: "set-door-accessible",
          doorId: door.id,
          accessible: bool(args, "step_free", false),
          reason,
          cascade: true
        });
      }
    },

    {
      name: "propose_landmark",
      description:
        "Propose a landmark the floor-plan extraction missed — a restroom, lift, entrance " +
        "or destination someone found on the ground. Coordinates are in metres from the " +
        "top-left of the plan; the gate rejects anything outside the building footprint.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", description: "What the place is called." },
          type: {
            type: "string",
            enum: ["entrance", "elevator", "stairs", "restroom", "destination"],
            description: "Landmark type."
          },
          x: { type: "number", description: "Metres from the left edge of the plan." },
          z: { type: "number", description: "Metres from the top edge of the plan." },
          reason: { type: "string", description: "What the person observed." }
        },
        required: ["label", "type", "x", "z", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const label = str(args, "label");
        const landmarkType = str(args, "type");
        const x = num(args, "x");
        const z = num(args, "z");
        const reason = str(args, "reason");
        const allowed = ["entrance", "elevator", "stairs", "restroom", "destination"];

        if (!label) return fail("Pass a `label` for the landmark.");
        if (!allowed.includes(landmarkType)) {
          return fail(`\`type\` must be one of: ${allowed.join(", ")}.`);
        }
        if (x === null || z === null) {
          const scene = context.getScene();
          return fail(
            `Pass numeric \`x\` and \`z\` in metres. This venue is ` +
              `${scene.dimensions.width} m wide and ${scene.dimensions.depth} m deep.`
          );
        }
        if (!reason) return fail("Pass what the person observed in `reason` — it is stored as provenance.");

        return submitMutation(context, "propose_landmark", args, {
          kind: "add-landmark",
          label,
          landmarkType: landmarkType as "entrance" | "elevator" | "stairs" | "restroom" | "destination",
          position: [x, z],
          reason
        });
      }
    },

    {
      name: "correct_label",
      description:
        "Correct the name of a room, door or landmark that the vision model read wrongly " +
        "from the floor plan. Queued for human approval like any other write.",
      inputSchema: {
        type: "object",
        properties: {
          entity_id: { type: "string", description: "The id of the room, door or landmark." },
          new_label: { type: "string", description: "The correct name." },
          reason: { type: "string", description: "How the person knows." }
        },
        required: ["entity_id", "new_label", "reason"],
        additionalProperties: false
      },
      execute: (args) => {
        const scene = context.getScene();
        const entityId = str(args, "entity_id");
        const label = str(args, "new_label");
        const reason = str(args, "reason");
        if (!label) return fail("Pass the corrected name in `new_label`.");
        if (!reason) return fail("Pass how the person knows in `reason` — it is stored as provenance.");

        const entityKind = scene.rooms.some((item) => item.id === entityId)
          ? "room"
          : scene.doors.some((item) => item.id === entityId)
            ? "door"
            : scene.landmarks.some((item) => item.id === entityId)
              ? "landmark"
              : null;

        if (!entityKind) {
          recordCall("correct_label", args, "error", `unknown entity "${entityId}"`);
          return fail(
            `No room, door or landmark in ${scene.name} has id "${entityId}". ` +
              `Use describe_room or list_destinations to get exact ids.`
          );
        }

        return submitMutation(context, "correct_label", args, {
          kind: "relabel",
          entityKind,
          entityId,
          label,
          reason
        });
      }
    }
  ];
}
