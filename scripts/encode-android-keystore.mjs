import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(repoRoot, "src-tauri", "gen", "android");
const keystorePath = join(androidRoot, "flashcards-release.jks");
const outputPath = `${keystorePath}.base64.txt`;

if (!existsSync(keystorePath)) {
  console.error(
    "Missing src-tauri/gen/android/flashcards-release.jks. Run `npm run android:signing` first.",
  );
  process.exit(1);
}

const encoded = readFileSync(keystorePath).toString("base64");
writeFileSync(outputPath, `${encoded}\n`);

console.log(`Wrote ${outputPath}`);
