import { Template, defaultBuildLogger } from "e2b";

import { template, TEMPLATE_NAME } from "./template.js";

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set. Grab one at https://e2b.dev/dashboard");
  process.exit(1);
}

await Template.build(template, TEMPLATE_NAME, {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
});

console.log(`\nBuilt template "${TEMPLATE_NAME}".`);
