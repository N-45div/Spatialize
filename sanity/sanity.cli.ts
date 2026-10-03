import { defineCliConfig } from "sanity/cli";
import { projectId, dataset } from "./project";
export default defineCliConfig({
  api: { projectId, dataset },
  deployment: { appId: "olpn4af1b3yviontkjffhoaa" },
});
