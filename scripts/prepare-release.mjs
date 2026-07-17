import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = packageJson.version;
if (tauriConfig.version !== version) throw new Error(`Version mismatch: package.json=${version}, tauri.conf.json=${tauriConfig.version}`);
if (process.platform !== "darwin") throw new Error("The current OpenKiwi release preparation workflow targets macOS.");

const tauriArch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platform = `darwin-${tauriArch}`;
const macosBundle = resolve(root, "src-tauri/target/release/bundle/macos");
const appSource = resolve(macosBundle, "OpenKiwi.app");
const updaterSource = resolve(macosBundle, "OpenKiwi.app.tar.gz");
const signatureSource = `${updaterSource}.sig`;
const dmgCandidates = [
  resolve(root, `src-tauri/target/release/bundle/dmg/OpenKiwi_${version}_${tauriArch}.dmg`),
  resolve(root, "src-tauri/target/release/bundle/dmg/OpenKiwi.dmg"),
];
const dmgSource = dmgCandidates.find(existsSync);

for (const path of [appSource, updaterSource, signatureSource]) {
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}\nRun npm run release:build first.`);
}
if (!dmgSource) throw new Error(`Missing DMG. Looked for:\n${dmgCandidates.join("\n")}`);

function requireSuccess(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${label} failed.${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

requireSuccess("codesign", ["--verify", "--deep", "--strict", appSource], "App signature verification");
requireSuccess("xcrun", ["stapler", "validate", appSource], "App notarization ticket validation");
requireSuccess("spctl", ["--assess", "--type", "execute", "--verbose=4", appSource], "App Gatekeeper assessment");
requireSuccess("codesign", ["--verify", "--verbose=4", dmgSource], "DMG signature verification");
requireSuccess("xcrun", ["stapler", "validate", dmgSource], "DMG notarization ticket validation");
requireSuccess("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgSource], "DMG Gatekeeper assessment");
const bundledVersion = requireSuccess("plutil", ["-extract", "CFBundleShortVersionString", "raw", resolve(appSource, "Contents/Info.plist")], "Bundle version check");
if (bundledVersion !== version) throw new Error(`Bundle version mismatch: expected ${version}, found ${bundledVersion}`);

const output = resolve(root, "release-assets/latest");
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(output)) rmSync(resolve(output, entry), { recursive: true, force: true });

const updaterName = `OpenKiwi_${version}_${tauriArch}.app.tar.gz`;
const dmgName = `OpenKiwi_${version}_${tauriArch}.dmg`;
copyFileSync(updaterSource, resolve(output, updaterName));
copyFileSync(dmgSource, resolve(output, dmgName));
copyFileSync(resolve(root, "src-tauri/icons/openkiwi-ok-master.png"), resolve(output, "OpenKiwi-icon.png"));

const notesPath = resolve(root, "release-assets/release-notes.md");
const notes = existsSync(notesPath)
  ? readFileSync(notesPath, "utf8").trim()
  : `OpenKiwi ${version}`;
const signature = readFileSync(signatureSource, "utf8").trim();
const updaterUrl = `https://github.com/m17h/OpenKiwi/releases/download/v${version}/${updaterName}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: { signature, url: updaterUrl },
  },
};
writeFileSync(resolve(output, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
writeFileSync(resolve(output, "release-notes.md"), `${notes}\n`);

console.log(`Prepared OpenKiwi ${version} release assets in ${output}`);
for (const entry of readdirSync(output).sort()) console.log(`- ${basename(entry)}`);
