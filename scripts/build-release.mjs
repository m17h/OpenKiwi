import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const defaultKey = resolve(homedir(), ".tauri/openkiwi-updater.key");
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY || defaultKey;
if (!signingKey.includes("untrusted comment") && !existsSync(signingKey)) throw new Error(`Updater signing key not found at ${signingKey}`);

let signingPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
if (!signingPassword && process.platform === "darwin") {
  const keychain = spawnSync("security", ["find-generic-password", "-a", process.env.USER || "", "-s", "com.openkiwi.updater-signing", "-w"], { encoding: "utf8" });
  if (keychain.status === 0) signingPassword = keychain.stdout.trim();
}
if (!signingPassword) throw new Error("Updater signing password is unavailable. On Morgan’s Mac it should be stored in Keychain as com.openkiwi.updater-signing.");

if (process.platform === "darwin") {
  const hasAppleId = process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID;
  const hasApiKey = process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_PATH;
  if (!hasAppleId && !hasApiKey) {
    throw new Error("A release build must be notarized. Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID (or the App Store Connect API key variables) for this command.");
  }
}

const tauri = resolve(root, `node_modules/.bin/tauri${process.platform === "win32" ? ".cmd" : ""}`);
const result = spawnSync(tauri, ["build", "--bundles", "app,dmg"], {
  cwd: root,
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: signingKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword },
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const prepare = spawnSync(process.execPath, [resolve(root, "scripts/prepare-release.mjs")], { cwd: root, stdio: "inherit" });
if (prepare.status !== 0) process.exit(prepare.status ?? 1);

const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
console.log(`OpenKiwi ${version} is signed, notarized, and staged for publishing.`);
