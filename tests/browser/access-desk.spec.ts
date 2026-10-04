import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  const response = await request.post("http://127.0.0.1:8788/api/runs/demo");
  const run = await response.json() as { runId: string };
  await page.addInitScript(id => localStorage.setItem("spatialize-run-id", id), run.runId);
  await page.goto("/#studio");
  await expect(page.getByRole("button", { name: "Check access", exact: true })).toBeEnabled();
});

test("personal clearance and sourced evidence work in an ordinary browser", async ({ page }) => {
  const desk = page.getByRole("region", { name: "Access desk", exact: true });
  await expect(desk.getByText("Demo fixtures", { exact: true })).toBeVisible();
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("CLEAR");
  await desk.locator(".evidence-list > summary").click();
  await expect(desk.getByText("Harbor Arts access guide", { exact: true })).toBeVisible();
  await desk.getByLabel("Required clear width").fill("1300");
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("BLOCKED");
  await expect(desk.getByRole("button", { name: /is 1200 mm wide/ })).toBeVisible();
  await page.screenshot({ path: "test-results/access-clearance.png", fullPage: true });
});

test("preview does not publish; approval persists and exposes conflicting claims", async ({ page }) => {
  const desk = page.getByRole("region", { name: "Access desk", exact: true });
  await desk.getByRole("combobox", { name: "Destination", exact: true }).selectOption("gallery-mark");
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("BLOCKED");
  await desk.locator(".move-desk > summary").click();
  await desk.getByRole("button", { name: "Preview move", exact: true }).click();
  await expect(desk.locator(".move-preview")).toContainText("BLOCKED → CLEAR");
  await expect(desk.locator(".verdict-line strong")).toHaveText("BLOCKED");
  await desk.getByRole("button", { name: "Submit for review", exact: true }).click();
  await desk.getByRole("button", { name: "Approve move", exact: true }).click();
  await expect(desk.getByText("approved · Published access v2", { exact: true })).toBeVisible();
  await page.reload();
  await expect(desk.getByRole("button", { name: "Check access", exact: true })).toBeEnabled();
  await desk.getByRole("combobox", { name: "Destination", exact: true }).selectOption("quiet-mark");
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("UNKNOWN");
  await desk.locator(".evidence-list > summary").click();
  await expect(desk.getByText("Visitor report: quiet-room threshold", { exact: true })).toBeVisible();
  await expect(desk.getByText("disputed", { exact: true })).toBeVisible();
  await desk.getByRole("button", { name: /Sources disagree/ }).click();
  await desk.locator(".access-answer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/access-evidence.png", fullPage: true });
});

test("an invalid move is rejected with useful feedback", async ({ page }) => {
  const desk = page.getByRole("region", { name: "Access desk", exact: true });
  await desk.locator(".move-desk > summary").click();
  await desk.getByLabel("X · metres", { exact: true }).fill("7.1");
  await desk.getByRole("button", { name: "Preview move", exact: true }).click();
  await expect(desk.getByRole("alert")).toContainText("footprint must fit");
  await expect(desk.getByRole("button", { name: "Submit for review", exact: true })).toHaveCount(0);
});

test("the evidence agent answers after the computed verdict and shows its Knowledge Base reads", async ({ page }) => {
  // The real API computes the verdict; only the paid provider's fields are stubbed.
  await page.route("**/api/runs/*/access", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), agentConfigured: true } });
  });
  await page.route("**/api/runs/*/access/check", async route => {
    const request = route.request().postDataJSON() as { useAgent: boolean; question: string };
    const response = await route.fetch();
    if (!request.useAgent) return route.fulfill({ response });
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ response, json: { ...await response.json(), agentStatus: "connected", agentMessage: null,
      agentSummary: `Answering "${request.question}": the venue guide and a disputed visitor report disagree.`,
      contextReads: [
        { tool: "initial_context", arguments: "{}", output: "Outline: disputed_reports, venue_guide", successful: true },
        { tool: "knowledge_base_read", arguments: "{\"paths\":[\"disputed_reports\"]}", output: "Both claims, side by side", successful: true }
      ] } });
  });
  await page.reload();
  const desk = page.getByRole("region", { name: "Access desk", exact: true });
  await expect(desk.getByRole("checkbox", { name: "Ask" })).toBeChecked();
  await desk.getByRole("combobox", { name: "Destination", exact: true }).selectOption("quiet-mark");
  await desk.getByLabel("Your question").fill("Is the quiet room step-free?");
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("BLOCKED");
  await expect(desk.getByRole("status").filter({ hasText: "reading the Knowledge Base" })).toBeVisible();
  await expect(desk.locator(".agent-research").filter({ hasText: "What the sources say" }))
    .toContainText("Answering \"Is the quiet room step-free?\"");
  await expect(desk.getByText(/1 Knowledge Base read ·/)).toBeVisible();
  await expect(desk.locator(".verdict-line strong")).toHaveText("BLOCKED");
  await desk.getByText("Context retrieval record (2 calls)").click();
  await expect(desk.getByText("knowledge_base_read · retrieved")).toBeVisible();
});

test("access desk remains usable on a phone-sized screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const desk = page.getByRole("region", { name: "Access desk", exact: true });
  await desk.getByRole("button", { name: "Check access", exact: true }).click();
  await expect(desk.locator(".verdict-line strong")).toHaveText("CLEAR");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await desk.locator(".access-answer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/access-mobile.png" });
});
