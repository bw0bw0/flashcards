import { useState } from "react";

import { api, copyToClipboard, pasteFromClipboard } from "../api";
import { useAction, useLoader } from "../hooks";
import type { ImportResult } from "../types";
import { Modal } from "./Modal";
import { ErrorBanner } from "./Screen";

const EXAMPLE = `[
  { "front": "犬", "back": "dog", "comment": "inu" },
  { "front": "猫", "back": "cat", "comment": "neko" }
]`;

interface Props {
  deckId: number;
  onClose: () => void;
  onImported: () => Promise<void>;
}

export function ImportDialog({ deckId, onClose, onImported }: Props) {
  const [json, setJson] = useState("");
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const action = useAction();

  async function run() {
    const imported = await action.run(() => api.importCards(deckId, json, replace));
    if (!imported) return;
    setResult(imported);
    await onImported();
  }

  return (
    <Modal
      title="Import cards"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn ghost"
            onClick={async () => setJson(await pasteFromClipboard())}
          >
            Paste
          </button>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={run}
            disabled={action.busy || json.trim() === ""}
          >
            Import
          </button>
        </>
      }
    >
      <ErrorBanner message={action.error} />
      <div className="notice">
        A JSON array of objects with <code>front</code>, and optionally{" "}
        <code>back</code>, <code>comment</code> and <code>story</code>. Cards are
        numbered in the order they appear.
      </div>
      <textarea
        className="mono"
        rows={10}
        value={json}
        placeholder={EXAMPLE}
        onChange={(event) => setJson(event.target.value)}
      />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={replace}
          onChange={(event) => setReplace(event.target.checked)}
        />
        Replace the cards already in this deck
      </label>
      {result && (
        <div className="notice">
          Imported {result.imported} cards
          {result.skipped > 0 && `, skipped ${result.skipped} without a front`}. The
          deck now has {result.total}.
        </div>
      )}
    </Modal>
  );
}

export function ExportDialog({
  deckId,
  onClose,
}: {
  deckId: number;
  onClose: () => void;
}) {
  const json = useLoader(() => api.exportCards(deckId), [deckId]);
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      title="Export cards"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn primary"
            onClick={async () => {
              await copyToClipboard(json.data ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ErrorBanner message={json.error} />
      <textarea className="mono" rows={14} value={json.data ?? ""} readOnly />
    </Modal>
  );
}
