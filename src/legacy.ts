import { invoke } from "@tauri-apps/api/core";

/**
 * The database the app kept on the device before it moved to a server. If
 * one is still there, the setup screen offers to upload it once.
 */

/** Size in bytes of the old local database, or null if there is none. */
export async function legacyDatabaseSize(): Promise<number | null> {
  try {
    return await invoke<number | null>("legacy_database_size");
  } catch {
    // Not running inside the app (e.g. `vite dev` in a browser).
    return null;
  }
}

async function readPart(part: "database" | "wal"): Promise<string | null> {
  const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_legacy_database", { part }));
  return bytes.length === 0 ? null : toBase64(bytes);
}

/** The old database and its write-ahead log, base64-encoded for upload. */
export async function readLegacyDatabase(): Promise<{ database: string; wal: string | null }> {
  const database = await readPart("database");
  if (!database) throw new Error("the old database is empty");
  return { database, wal: await readPart("wal") };
}

/** Renames the old database so the upload isn't offered again. */
export async function archiveLegacyDatabase(): Promise<void> {
  await invoke("archive_legacy_database");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
