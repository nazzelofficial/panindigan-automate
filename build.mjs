import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";

/**
 * Build orchestrator for Panindigan Automate.
 *
 * Steps, in order:
 *   1. Clean the dist/ directory.
 *   2. Type check the full source tree under strict settings.
 *   3. Emit the ESM build (dist/esm).
 *   4. Emit the CommonJS build (dist/cjs).
 *   5. Emit the type declarations (dist/types).
 *
 * Any step failing aborts the build with a non-zero exit code.
 */

const steps = [
  { label: "clean", run: () => cleanDist() },
  { label: "typecheck", run: () => npx("tsc -p tsconfig.json --noEmit") },
  { label: "build esm", run: () => npx("tsc -p tsconfig.build.json") },
  { label: "build cjs", run: () => npx("tsc -p tsconfig.cjs.json") },
  { label: "package cjs", run: () => markCjs() },
  { label: "build types", run: () => npx("tsc -p tsconfig.types.json") },
];

function cleanDist() {
  if (existsSync("dist")) {
    rmSync("dist", { recursive: true, force: true });
  }
}

function markCjs() {
  mkdirSync("dist/cjs", { recursive: true });
  writeFileSync("dist/cjs/package.json", `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`, "utf8");

  // Make require("panindigan-automate") itself callable (fca-style entry):
  // re-export the default (login) function as module.exports with all named
  // exports attached. Existing named imports and destructuring keep working.
  const cjsEntry = "dist/cjs/index.js";
  const source = readFileSync(cjsEntry, "utf8");
  const shim =
    "\n// CommonJS convenience shim: require(\"panindigan-automate\") is callable.\n" +
    "const __panindigan_login = module.exports.default;\n" +
    "if (typeof __panindigan_login === \"function\") {\n" +
    "  module.exports = Object.assign(__panindigan_login, module.exports, {\n" +
    "    default: __panindigan_login,\n" +
    "    login: __panindigan_login,\n" +
    "  });\n" +
    "}\n";
  writeFileSync(cjsEntry, source + shim, "utf8");
}

function npx(command) {
  execSync(`npx ${command}`, { stdio: "inherit", shell: process.platform === "win32" });
}

for (const step of steps) {
  console.log(`[panindigan] ${step.label}...`);
  step.run();
}

console.log("[panindigan] build complete");
