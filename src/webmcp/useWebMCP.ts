/**
 * Registers the Spatialize tool surface with the browser's WebMCP agent host.
 *
 * Each of the thirteen tools in `./tools` is published with the standard call:
 *
 *   document.modelContext.registerTool({
 *     name: "find_step_free_route",
 *     description: "Compute a route between two places in this venue…",
 *     inputSchema: { type: "object", properties: { … }, required: ["to"] },
 *     annotations: { readOnlyHint: true },
 *     execute: async (input) => { … }
 *   }, { signal });
 *
 * Tools are registered once per venue. Swapping in a different floor plan tears
 * the old set down through its AbortController and registers a fresh one, which
 * is what fires the browser's `toolchange` event — an agent that has been idle
 * on the page learns the venue changed underneath it.
 */
import { useEffect, useRef, useState } from "react";
import type { SpatialScene } from "../domain/spatial-scene";
import { buildTools, type ToolContext } from "./tools";
import { webmcpSupported } from "./types";

export interface WebMCPStatus {
  supported: boolean;
  registered: string[];
  error: string | null;
}

interface WebMCPHandlers {
  focusLandmark: (landmarkId: string) => void;
  setViewMode: (mode: "2d" | "3d") => void;
}

export function useWebMCP(
  scene: SpatialScene,
  handlers: WebMCPHandlers,
  options?: { canPropose?: boolean }
): WebMCPStatus {
  const canPropose = options?.canPropose ?? true;
  const [status, setStatus] = useState<WebMCPStatus>(() => ({
    supported: webmcpSupported(),
    registered: [],
    error: null
  }));

  // Tools resolve these at call time, never at render time, so a re-render
  // never needs to tear down and re-register the tool set.
  const sceneRef = useRef(scene);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    sceneRef.current = scene;
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!webmcpSupported()) return;

    const controller = new AbortController();
    const context: ToolContext = {
      getScene: () => sceneRef.current,
      focusLandmark: (id) => handlersRef.current.focusLandmark(id),
      setViewMode: (mode) => handlersRef.current.setViewMode(mode),
      canPropose
    };

    const tools = buildTools(context);

    const register = async () => {
      const modelContext = document.modelContext;
      if (!modelContext) return;

      const registered: string[] = [];
      for (const tool of tools) {
        await modelContext.registerTool(tool, { signal: controller.signal });
        if (controller.signal.aborted) return;
        registered.push(tool.name);
      }
      setStatus({ supported: true, registered, error: null });
    };

    register().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setStatus({
        supported: true,
        registered: [],
        error: error instanceof Error ? error.message : "Tool registration failed"
      });
    });

    return () => controller.abort();
    // Re-register when the venue changes, or when a venue record appears or
    // goes away — the write tools exist only while there is one. Either way
    // the browser fires toolchange and an idle agent learns the surface moved.
  }, [scene.id, canPropose]);

  return status;
}
