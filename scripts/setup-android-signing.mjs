import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(repoRoot, "src-tauri", "gen", "android");
const appGradle = join(androidRoot, "app", "build.gradle.kts");
const keystorePath = join(androidRoot, "flashcards-release.jks");
const keystorePropertiesPath = join(androidRoot, "keystore.properties");
const keyAlias = process.env.ANDROID_KEY_ALIAS || "flashcards";
const isCi = process.env.CI === "true";
const encodedKeystore = process.env.ANDROID_KEYSTORE_BASE64;

if (!existsSync(appGradle)) {
  console.error(
    "Missing src-tauri/gen/android/app/build.gradle.kts. Run `npx tauri android init` after installing the Android SDK, then run this script again.",
  );
  process.exit(1);
}

mkdirSync(androidRoot, { recursive: true });

let password = process.env.ANDROID_KEY_PASSWORD;
if (!password && existsSync(keystorePropertiesPath)) {
  const existing = readFileSync(keystorePropertiesPath, "utf8").match(/^password=(.+)$/m);
  password = existing?.[1];
}

if (!password) {
  if (isCi) {
    console.error(
      "Missing ANDROID_KEY_PASSWORD. Add ANDROID_KEYSTORE_BASE64, ANDROID_KEY_PASSWORD, and ANDROID_KEY_ALIAS to GitHub Actions secrets.",
    );
    process.exit(1);
  }

  password = randomBytes(24).toString("base64url");
}

if (encodedKeystore) {
  writeFileSync(keystorePath, Buffer.from(encodedKeystore, "base64"));
} else if (isCi) {
  console.error(
    "Missing ANDROID_KEYSTORE_BASE64. Add a base64-encoded release keystore to GitHub Actions secrets.",
  );
  process.exit(1);
} else if (!existsSync(keystorePath)) {
  const result = spawnSync(
    "keytool",
    [
      "-genkeypair",
      "-v",
      "-keystore",
      keystorePath,
      "-storetype",
      "JKS",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "10000",
      "-alias",
      keyAlias,
      "-storepass",
      password,
      "-keypass",
      password,
      "-dname",
      "CN=Flashcards, OU=Personal, O=Flashcards, L=Stockholm, ST=Stockholm, C=SE",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

writeFileSync(
  keystorePropertiesPath,
  `password=${password}\nkeyAlias=${keyAlias}\nstoreFile=${keystorePath.replaceAll("\\", "\\\\")}\n`,
);

let gradle = readFileSync(appGradle, "utf8");

if (!gradle.includes("import java.io.FileInputStream")) {
  gradle = `import java.io.FileInputStream\nimport java.util.Properties\n${gradle}`;
} else if (!gradle.includes("import java.util.Properties")) {
  gradle = gradle.replace(
    "import java.io.FileInputStream",
    "import java.io.FileInputStream\nimport java.util.Properties",
  );
}

if (!gradle.includes('create("release")')) {
  gradle = gradle.replace(
    /(\nandroid\s*\{)/,
    `$1
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            keystoreProperties.load(FileInputStream(keystorePropertiesFile))

            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }
`,
  );
}

const releaseSigningLine = 'signingConfig = signingConfigs.getByName("release")';

if (!gradle.includes(releaseSigningLine)) {
  gradle = gradle.replace(
    /getByName\("release"\)\s*\{([\s\S]*?)\n\s*\}/,
    (match, body) =>
      match.replace(
        body,
        `${body}
            ${releaseSigningLine}`,
      ),
  );
}

writeFileSync(appGradle, gradle);

console.log("Android release signing is configured.");
