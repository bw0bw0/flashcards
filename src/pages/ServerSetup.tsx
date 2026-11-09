import { useEffect, useState } from "react";

import { api, errorMessage } from "../api";
import { ErrorBanner, Screen } from "../components/Screen";
import { archiveLegacyDatabase, legacyDatabaseSize, readLegacyDatabase } from "../legacy";
import {
  checkServer,
  getServerUrl,
  normaliseServerUrl,
  setServerUrl,
  type Health,
} from "../server";

interface Props {
  /** First start: there is no server yet, so there is nowhere to go back to. */
  firstRun?: boolean;
  /** Called once a server is saved (and any upload is dealt with). */
  onDone: (url: string) => void;
}

type Step =
  | { kind: "address" }
  | { kind: "upload"; url: string; health: Health; size: number }
  | { kind: "uploaded"; url: string; backup: string | null };

/**
 * Asks for the server's address and checks it answers. If the device still
 * has the database from before the app used a server, offers to upload it.
 */
export function ServerSetup({ firstRun, onDone }: Props) {
  const [address, setAddress] = useState(getServerUrl() ?? "");
  const [step, setStep] = useState<Step>({ kind: "address" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacySize, setLegacySize] = useState<number | null>(null);

  useEffect(() => {
    void legacyDatabaseSize().then(setLegacySize);
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const url = normaliseServerUrl(address);
      const health = await checkServer(url);
      setServerUrl(url);
      setAddress(url);
      if (legacySize !== null) {
        setStep({ kind: "upload", url, health, size: legacySize });
      } else {
        onDone(url);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function upload(url: string, replace: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { database, wal } = await readLegacyDatabase();
      const result = await api.importDatabase(database, wal, replace);
      await archiveLegacyDatabase();
      setLegacySize(null);
      setStep({ kind: "uploaded", url, backup: result.backup });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={firstRun ? "Welcome" : "Server"} back={!firstRun}>
      <ErrorBanner message={error} />

      {step.kind === "address" && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <div className="notice">
            Your decks, cards and review history live on your flashcards server. Enter its
            address — with <code>tailscale serve</code> that is the machine's Tailscale name,
            like <code>my-pc.tail1234.ts.net</code>.
          </div>
          <label className="field">
            <span>Server address</span>
            <input
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="my-pc.tail1234.ts.net"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <button className="btn primary block" type="submit" disabled={busy || !address.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          {!firstRun && legacySize !== null && (
            <div className="muted small">
              This device still has flashcards from before the app used a server. Connect to
              upload them.
            </div>
          )}
        </form>
      )}

      {step.kind === "upload" && (
        <div className="stack">
          <div className="notice">
            Connected to {step.url}.
            <br />
            This device still has the flashcards you made before the app used a server (
            {formatSize(step.size)}). Upload them to the server?
          </div>
          {!step.health.empty && (
            <div className="error-banner">
              The server already has decks. Uploading replaces everything on it with this
              device's data. The server keeps a backup of what it had.
            </div>
          )}
          <button
            className={`btn block ${step.health.empty ? "primary" : "danger"}`}
            disabled={busy}
            onClick={() => upload(step.url, !step.health.empty)}
          >
            {busy ? "Uploading…" : step.health.empty ? "Upload" : "Replace the server's data"}
          </button>
          <button className="btn ghost block" disabled={busy} onClick={() => onDone(step.url)}>
            Not now
          </button>
          <div className="muted small">
            Choosing "Not now" leaves the data on this device. You can upload it later from the
            server settings.
          </div>
        </div>
      )}

      {step.kind === "uploaded" && (
        <div className="stack">
          <div className="notice">
            Uploaded. Your flashcards are on the server now.
            {step.backup && (
              <>
                <br />
                The server's previous data is kept in <code>{step.backup}</code>.
              </>
            )}
          </div>
          <button className="btn primary block" onClick={() => onDone(step.url)}>
            Continue
          </button>
        </div>
      )}
    </Screen>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
