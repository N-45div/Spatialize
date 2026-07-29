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
  error: string | null;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

export async function createIngestionRun(plan: File): Promise<IngestionRun> {
  const body = new FormData();
  body.append("plan", plan);
  const response = await fetch(`${apiBaseUrl}/api/runs`, {
    method: "POST",
    body
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Plan upload failed with status ${response.status}`);
  }
  return response.json() as Promise<IngestionRun>;
}
