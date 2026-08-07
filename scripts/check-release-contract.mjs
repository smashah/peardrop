import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
const requiredSteps = [
  "docker push \"$image:$version\"",
  "bumpy ci release --expect-mode publish",
  "npm view",
  "Verify GitHub release",
  "Promote verified relay image",
];

let previousIndex = -1;
for (const step of requiredSteps) {
  const index = workflow.indexOf(step);
  if (index === -1) throw new Error(`Release workflow is missing: ${step}`);
  if (index <= previousIndex) throw new Error(`Release workflow step is out of order: ${step}`);
  previousIndex = index;
}

const latestPush = workflow.indexOf('docker push "$IMAGE:latest"');
if (latestPush <= previousIndex) throw new Error("The latest relay tag must move only after release verification");

process.stdout.write("Release workflow contract passed.\n");
