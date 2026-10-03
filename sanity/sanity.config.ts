import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";
import { schemaTypes } from "./schema";

export default defineConfig({
  name: "spatialize-access", title: "Spatialize · Access evidence",
  // Build-only placeholders: configure real IDs before running or deploying Studio.
  projectId: process.env.SANITY_STUDIO_PROJECT_ID || "demo1234",
  dataset: process.env.SANITY_STUDIO_DATASET || "production",
  plugins: [structureTool()], schema: { types: schemaTypes }
});
