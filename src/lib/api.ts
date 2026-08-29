import type { AccessibilityImpact, SceneMutation } from "../webmcp/gate";

export interface IngestionRun {
  runId: string;
  status: "source-stored" | "extracting" | "review-required" | "approved" | "failed";
  source: {
    key: string;
    sha256: string;
    contentType: string;
    size: number;
    uri: string;
  };
  sceneVersion: number;
  error: string | null;
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
  confidence: number | null;
}

export interface AskResponse {
  status: "ok" | "low-confidence";
  question?: string;
  transcript: {
    text: string;
    words: WordTiming[];
    meanConfidence: number;
    manifestHash: string;
  } | null;
  answer: { script: string } | null;
  audio: {
    url: string | null;
    mediaType: string;
    durationSeconds: number | null;
    manifestHash: string;
    voice?: string;
  } | null;
  mutations: { kind: string; summary: string; entity_id: string }[];
  sceneVersion?: number;
  sceneChanged?: boolean;
  message?: string;
  warnings: string[];
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

async function readError(response: Response, fallback: string): Promise<never> {
  const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
  throw new Error(payload?.detail ?? `${fallback} (status ${response.status})`);
}

export async function fetchRun(runId: string): Promise<IngestionRun> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}`);
  if (!response.ok) await readError(response, "Run fetch failed");
  return response.json() as Promise<IngestionRun>;
}

export async function ensureDemoRun(): Promise<IngestionRun> {
  const response = await fetch(`${apiBaseUrl}/api/runs/demo`, { method: "POST" });
  if (!response.ok) await readError(response, "Demo scene unavailable");
  return response.json() as Promise<IngestionRun>;
}

export async function createIngestionRun(plan: File): Promise<IngestionRun> {
  const body = new FormData();
  body.append("plan", plan);
  const response = await fetch(`${apiBaseUrl}/api/runs`, { method: "POST", body });
  if (!response.ok) await readError(response, "Plan upload failed");
  return response.json() as Promise<IngestionRun>;
}

export async function extractRun(runId: string): Promise<IngestionRun> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/extract`, { method: "POST" });
  if (!response.ok) await readError(response, "Extraction failed");
  return response.json() as Promise<IngestionRun>;
}

export async function fetchScene(runId: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/scene`);
  if (!response.ok) await readError(response, "Scene fetch failed");
  return response.json();
}

export interface ConversationTurn {
  question: string;
  answer: string;
}

export async function askVenue(
  runId: string,
  input: { text?: string; audio?: Blob; audioType?: string; history?: ConversationTurn[] }
): Promise<AskResponse> {
  const body = new FormData();
  if (input.audio) {
    body.append("audio", input.audio, `question.${input.audioType?.includes("mp4") ? "m4a" : "webm"}`);
  }
  if (input.text) body.append("text", input.text);
  if (input.history?.length) body.append("history", JSON.stringify(input.history.slice(-4)));
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/ask`, { method: "POST", body });
  if (!response.ok) await readError(response, "The venue could not answer");
  return response.json() as Promise<AskResponse>;
}

export async function narrateText(
  runId: string,
  text: string
): Promise<{ audio: NonNullable<AskResponse["audio"]> }> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/narrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) await readError(response, "Narration unavailable");
  return response.json() as Promise<{ audio: NonNullable<AskResponse["audio"]> }>;
}

export async function approveRun(
  runId: string,
  resolvedIssueIds: string[]
): Promise<IngestionRun> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolved_issue_ids: resolvedIssueIds })
  });
  if (!response.ok) await readError(response, "Approval failed");
  return response.json() as Promise<IngestionRun>;
}

/**
 * The venue role is a shared token. It arrives once in the URL (`?venue=…`),
 * is kept in this browser, and is sent only on approve and decline. Nothing
 * in the page ever displays it.
 */
const VENUE_TOKEN_KEY = "spatialize-venue-token";

export function rememberVenueToken(token: string | null) {
  try {
    if (token) localStorage.setItem(VENUE_TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the token is simply not remembered */
  }
}

function venueHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(VENUE_TOKEN_KEY);
    return token ? { "X-Venue-Token": token } : {};
  } catch {
    return {};
  }
}

export interface ReviewProposalRecord {
  id: string;
  description: string;
  reason: string;
  mutation: Record<string, unknown>;
  status: "pending" | "approved" | "declined";
  baseSceneVersion: number;
  impact: AccessibilityImpact;
  proposedAt: string;
  decidedAt: string | null;
  resultingSceneVersion: number | null;
  candidateScene: { key: string; sha256: string };
}

export interface ReviewCallRecord {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "answered" | "queued" | "refused" | "error";
  summary: string;
  at: string;
}

/** Everything agents proposed on a run and what people decided. */
export interface ReviewLedger {
  runId: string;
  proposals: ReviewProposalRecord[];
  calls: ReviewCallRecord[];
}

export async function fetchReview(runId: string): Promise<ReviewLedger> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/review`);
  if (!response.ok) await readError(response, "Review ledger unavailable");
  return response.json() as Promise<ReviewLedger>;
}

/**
 * A proposal is a mutation, never a scene. The server applies it to its own
 * copy of the venue, so a proposal cannot carry anything its description
 * does not say.
 */
export async function postProposal(
  runId: string,
  body: { id: string; mutation: SceneMutation; baseSceneVersion: number }
): Promise<ReviewProposalRecord> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) await readError(response, "The venue did not accept the proposal");
  return response.json() as Promise<ReviewProposalRecord>;
}

export interface ApprovalResult {
  proposal: ReviewProposalRecord;
  run: IngestionRun;
  /** The scene the server just installed, so the page need not refetch it. */
  scene: unknown;
}

export async function approveProposalRemote(
  runId: string,
  proposalId: string
): Promise<ApprovalResult> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/proposals/${proposalId}/approve`, {
    method: "POST",
    headers: venueHeaders()
  });
  if (!response.ok) await readError(response, "Approval failed");
  return response.json() as Promise<ApprovalResult>;
}

export async function declineProposalRemote(
  runId: string,
  proposalId: string
): Promise<ReviewProposalRecord> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/proposals/${proposalId}/decline`, {
    method: "POST",
    headers: venueHeaders()
  });
  if (!response.ok) await readError(response, "Decline failed");
  return response.json() as Promise<ReviewProposalRecord>;
}

export async function postAudit(runId: string, calls: ReviewCallRecord[]): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/runs/${runId}/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calls })
  });
  if (!response.ok) await readError(response, "Audit write failed");
}

export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `${apiBaseUrl}${url}` : url;
}
