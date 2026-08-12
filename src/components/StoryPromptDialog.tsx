import { useState } from "react";

import { api, copyToClipboard, pasteFromClipboard } from "../api";
import { useAction, useLoader } from "../hooks";
import type { ApplyResult, Deck } from "../types";
import { Field, Modal } from "./Modal";
import { RangeFields } from "./SelectionPicker";
import { ErrorBanner } from "./Screen";

interface Props {
  deck: Deck;
  onClose: () => void;
  onApplied: () => Promise<void>;
}

/**
 * Walks the user through the round trip to an LLM: pick a prompt and a slice,
 * copy the request, paste the reply back, attach the stories.
 */
export function StoryPromptDialog({ deck, onClose, onApplied }: Props) {
  const prompts = useLoader(() => api.listStoryPrompts(), []);
  const [promptId, setPromptId] = useState<number | null>(null);
  const [fromIndex, setFromIndex] = useState<number | null>(null);
  const [toIndex, setToIndex] = useState<number | null>(null);
  const [copiedCount, setCopiedCount] = useState<number | null>(null);
  const [response, setResponse] = useState("");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const action = useAction();

  const chosen = promptId ?? prompts.data?.[0]?.id ?? null;

  async function copyRequest() {
    if (chosen === null) return;
    const request = await action.run(() =>
      api.buildStoryRequest(chosen, { deckId: deck.id, fromIndex, toIndex }),
    );
    if (!request) return;
    await copyToClipboard(request.text);
    setCopiedCount(request.cardCount);
  }

  async function apply() {
    const applied = await action.run(() => api.applyStoryResponse(deck.id, response));
    if (!applied) return;
    setResult(applied);
    await onApplied();
  }

  return (
    <Modal
      title="Prompt a story"
      onClose={onClose}
      footer={
        copiedCount === null ? (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={copyRequest}
              disabled={action.busy || chosen === null}
            >
              Copy to clipboard
            </button>
          </>
        ) : (
          <>
            <button
              className="btn ghost"
              onClick={async () => setResponse(await pasteFromClipboard())}
            >
              Paste
            </button>
            <div className="spacer" />
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button
              className="btn primary"
              onClick={apply}
              disabled={action.busy || response.trim() === ""}
            >
              Attach stories
            </button>
          </>
        )
      }
    >
      <ErrorBanner message={action.error ?? prompts.error} />

      {copiedCount === null ? (
        <>
          {(prompts.data ?? []).length === 0 ? (
            <div className="empty">
              You have not written any story prompts yet.
              <br />
              Add one on the Prompts tab first.
            </div>
          ) : (
            <Field label="Story prompt">
              <select
                value={chosen ?? ""}
                onChange={(event) => setPromptId(Number(event.target.value))}
              >
                {(prompts.data ?? []).map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={`Cards (of ${deck.cardCount}, blank means all)`}>
            <RangeFields
              fromIndex={fromIndex}
              toIndex={toIndex}
              onChange={(key, raw) => {
                const parsed = raw.trim() === "" ? null : Number(raw);
                const value = Number.isFinite(parsed) ? parsed : null;
                if (key === "fromIndex") setFromIndex(value);
                else setToIndex(value);
              }}
            />
          </Field>
          <div className="notice">
            The prompt, the formatting rules and the selected cards are copied to
            your clipboard. Paste that into any LLM, then bring its answer back
            here.
          </div>
        </>
      ) : (
        <>
          <div className="notice">
            Copied {copiedCount} cards. Paste it into an LLM, then paste the reply
            below.
          </div>
          <textarea
            className="mono"
            rows={10}
            value={response}
            autoFocus
            placeholder='[{"index": 1, "story": "..."}]'
            onChange={(event) => setResponse(event.target.value)}
          />
          {result && (
            <div className="notice">
              Attached {result.updated} stories.
              {result.unmatched.length > 0 && (
                <>
                  <br />
                  No card matched: {result.unmatched.join(", ")}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
