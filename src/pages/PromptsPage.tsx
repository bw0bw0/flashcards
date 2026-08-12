import { useState } from "react";

import { api } from "../api";
import { Field, Modal } from "../components/Modal";
import { ErrorBanner, Screen } from "../components/Screen";
import { useAction, useLoader } from "../hooks";
import type { StoryPrompt } from "../types";

const PLACEHOLDER = `Write a short, vivid mnemonic story for each card that links
the front to the back. Keep every story under 40 words and
mention the reading at least once.`;

/** The library of instructions used to ask an LLM for card stories. */
export function PromptsPage() {
  const prompts = useLoader(() => api.listStoryPrompts(), []);
  const [editing, setEditing] = useState<StoryPrompt | null>(null);
  const [creating, setCreating] = useState(false);

  const list = prompts.data ?? [];

  return (
    <Screen title="Story prompts">
      <ErrorBanner message={prompts.error} />

      <div className="notice">
        A story prompt tells an LLM how to write the story for a card. Pick one
        from a deck's <strong>Prompt a story</strong> button to copy the request,
        then paste the answer back to attach the stories.
      </div>

      {list.length === 0 && !prompts.loading && (
        <div className="empty">No story prompts yet.</div>
      )}

      <div className="deck-list">
        {list.map((prompt) => (
          <div key={prompt.id} className="deck-row" onClick={() => setEditing(prompt)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{prompt.name}</div>
              <div className="meta">{firstLine(prompt.prompt)}</div>
            </div>
          </div>
        ))}
      </div>

      <button className="btn primary block" onClick={() => setCreating(true)}>
        New prompt
      </button>

      {(creating || editing) && (
        <PromptModal
          prompt={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={prompts.reload}
        />
      )}
    </Screen>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function PromptModal({
  prompt,
  onClose,
  onSaved,
}: {
  prompt?: StoryPrompt;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [text, setText] = useState(prompt?.prompt ?? "");
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      prompt
        ? api.updateStoryPrompt(prompt.id, name, text)
        : api.createStoryPrompt(name, text),
    );
    if (!saved) return;
    await onSaved();
    onClose();
  }

  return (
    <Modal
      title={prompt ? "Edit prompt" : "New prompt"}
      onClose={onClose}
      footer={
        <>
          {prompt && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm(`Delete "${prompt.name}"?`)) return;
                const done = await action.run(() => api.deleteStoryPrompt(prompt.id));
                if (done === undefined) return;
                await onSaved();
                onClose();
              }}
            >
              Delete
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={action.busy}>
            Save
          </button>
        </>
      }
    >
      <ErrorBanner message={action.error} />
      <Field label="Name">
        <input
          type="text"
          value={name}
          autoFocus
          placeholder="Mnemonic stories"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Instruction for the LLM">
        <textarea
          rows={8}
          value={text}
          placeholder={PLACEHOLDER}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div className="small muted">
        The cards and the reply format are appended automatically, so write only
        the instruction itself.
      </div>
    </Modal>
  );
}
