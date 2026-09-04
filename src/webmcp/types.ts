/**
 * Minimal typings for the WebMCP browser API (Chrome 149+ origin trial).
 *
 * The standard exposes `document.modelContext`; `navigator.modelContext` was the
 * pre-Chrome-150 spelling and is deprecated. We type only what Spatialize uses.
 * See https://developer.chrome.com/docs/ai/webmcp/imperative-api
 */

/** A single block of tool output, in MCP content form. */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export type ToolContent = ToolTextContent;

/**
 * What an `execute` callback hands back. Chrome normalises bare strings, but we
 * always return the canonical shape so the result is identical across agents.
 */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Hints that let an agent reason about a tool before calling it. `readOnlyHint`
 * is the important one for Spatialize: it separates the questions an agent may
 * answer freely from the writes that have to clear the topology gate.
 */
/**
 * Chrome's WebMCP annotations. Note this is not the MCP spec's set: there is
 * no `destructiveHint` or `idempotentHint` here. The destructive signal is
 * `consequentialHint`, added in Chrome 154 — set it on a tool whose call a
 * person should confirm first.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  /** High-stakes, irreversible or real-world action. Chrome 154+. */
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

/** JSON Schema describing a tool's arguments. Kept loose on purpose. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface RegisterToolOptions {
  /** Aborting this signal unregisters the tool. */
  signal?: AbortSignal;
  /** Origins allowed to see this tool when the page is framed. */
  exposedTo?: string[];
}

export interface ModelContext {
  registerTool: (
    tool: ToolDefinition,
    options?: RegisterToolOptions
  ) => Promise<void> | void;
  getTools?: () => Promise<ToolDefinition[]>;
  addEventListener?: EventTarget["addEventListener"];
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

/** True when this browser can accept WebMCP tool registrations. */
export function webmcpSupported(): boolean {
  return typeof document !== "undefined" && typeof document.modelContext?.registerTool === "function";
}
