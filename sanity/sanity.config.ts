import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";
import { schemaTypes } from "./schema";
import { projectId, dataset } from "./project";

export default defineConfig({
  name: "spatialize-access", title: "Spatialize · Access evidence",
  projectId, dataset,
  plugins: [structureTool()], schema: { types: schemaTypes }
});
