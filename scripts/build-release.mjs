import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
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

let appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform === "darwin" && !appleSigningIdentity) {
  const identities = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const match = identities.stdout.match(/"([^"]*Developer ID Application[^"]*)"/);
  if (!match) throw new Error("No Developer ID Application signing identity is available in the macOS keychain.");
  appleSigningIdentity = match[1];
}

const tauri = resolve(root, `node_modules/.bin/tauri${process.platform === "win32" ? ".cmd" : ""}`);
const releaseEnv = {
  ...process.env,
  ...(appleSigningIdentity ? { APPLE_SIGNING_IDENTITY: appleSigningIdentity } : {}),
  TAURI_SIGNING_PRIVATE_KEY: signingKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
};
rmSync(resolve(root, "src-tauri/target/release/bundle"), { recursive: true, force: true });
// Tauri builds and notarizes the app/updater payload only. OpenKiwi's DMG is
// always created separately with the dedicated create-dmg tool so its layout
// and signing path never depend on Tauri's built-in DMG bundler.
const result = spawnSync(tauri, ["build", "--bundles", "app"], {
  cwd: root,
  env: releaseEnv,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform === "darwin") {
  const tauriArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const appBundle = resolve(root, "src-tauri/target/release/bundle/macos/OpenKiwi.app");
  if (!existsSync(appBundle)) throw new Error(`Built app not found at ${appBundle}`);

  const dmgDirectory = resolve(root, "src-tauri/target/release/bundle/dmg");
  rmSync(dmgDirectory, { recursive: true, force: true });
  mkdirSync(dmgDirectory, { recursive: true });
  const createDmg = spawnSync("create-dmg", [
    "--overwrite",
    `--identity=${appleSigningIdentity}`,
    "--dmg-title=OpenKiwi",
    appBundle,
    dmgDirectory,
  ], { cwd: root, stdio: "inherit" });
  if (createDmg.error) throw new Error(`Could not run create-dmg: ${createDmg.error.message}`);
  if (createDmg.status !== 0) process.exit(createDmg.status ?? 1);

  const createdDmgs = readdirSync(dmgDirectory).filter((entry) => entry.endsWith(".dmg"));
  if (createdDmgs.length !== 1) throw new Error(`create-dmg produced ${createdDmgs.length} DMGs; expected exactly one.`);
  const dmg = resolve(root, `src-tauri/target/release/bundle/dmg/OpenKiwi_${version}_${tauriArch}.dmg`);
  const createdDmg = resolve(dmgDirectory, createdDmgs[0]);
  if (createdDmg !== dmg) renameSync(createdDmg, dmg);
  if (!existsSync(dmg)) throw new Error(`Built DMG not found at ${dmg}`);

  const stapled = spawnSync("xcrun", ["stapler", "validate", dmg], { stdio: "ignore" });
  if (stapled.status !== 0) {
    const credentials = process.env.APPLE_ID
      ? ["--apple-id", process.env.APPLE_ID, "--password", process.env.APPLE_PASSWORD, "--team-id", process.env.APPLE_TEAM_ID]
      : ["--issuer", process.env.APPLE_API_ISSUER, "--key-id", process.env.APPLE_API_KEY, "--key", process.env.APPLE_API_KEY_PATH];
    const notarize = spawnSync("xcrun", ["notarytool", "submit", dmg, ...credentials, "--wait"], { stdio: "inherit" });
    if (notarize.status !== 0) process.exit(notarize.status ?? 1);
    const staple = spawnSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    if (staple.status !== 0) process.exit(staple.status ?? 1);
  }
}

const prepare = spawnSync(process.execPath, [resolve(root, "scripts/prepare-release.mjs")], { cwd: root, stdio: "inherit" });
if (prepare.status !== 0) process.exit(prepare.status ?? 1);

console.log(`OpenKiwi ${version} is signed, notarized, and staged for publishing.`);
