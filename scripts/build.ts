import { mkdir } from "node:fs/promises";

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const requested = process.argv.slice(2);
await mkdir("dist", { recursive: true });
for (const target of requested.length ? requested : targets) {
  if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}`);
  const suffix = target.startsWith("windows") ? ".exe" : "";
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "src/cli/index.ts",
      "--compile",
      "--minify",
      `--target=bun-${target}`,
      "--outfile",
      `dist/atriveo-engine-${target}${suffix}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode) process.exit(result.exitCode);
}
if (
  process.platform === "darwin" &&
  (!requested.length || (requested.includes("darwin-arm64") && requested.includes("darwin-x64")))
) {
  for (const command of [
    [
      "lipo",
      "-create",
      "dist/atriveo-engine-darwin-arm64",
      "dist/atriveo-engine-darwin-x64",
      "-output",
      "dist/atriveo-engine-darwin-universal",
    ],
    ["codesign", "--force", "--sign", "-", "dist/atriveo-engine-darwin-universal"],
    ["codesign", "--verify", "--verbose", "dist/atriveo-engine-darwin-universal"],
  ]) {
    const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode) process.exit(result.exitCode);
  }
}
