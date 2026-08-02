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

export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `${apiBaseUrl}${url}` : url;
}
