/* Node runner for the same suite test.html runs in the browser.
 *
 *     node test.mjs
 *
 * Same modules, same assertions, no npm install, no build step. The browser
 * page exists because this tool ships as a static page and a suite you cannot
 * run where the code runs is not a suite; this file exists because a green
 * page is easy to not look at.
 */

import { runTests } from "./js/tests.js";

const { results, passed, failed } = await runTests();

for (const r of results) {
  console.log((r.ok ? "PASS  " : "FAIL  ") + r.name);
  console.log("      " + r.detail);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) {
  console.log("\nA failure here is not a flaky test. Every case is offline and deterministic.");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
