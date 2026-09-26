// npm test: the logic tests (no browser), then the end-to-end run in Chromium.
import { spawnSync } from "node:child_process";

const steps = [
  ["node", ["--test", "test/unit.test.mjs"]],
  ["node", ["test/e2e.mjs"]],
];
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
