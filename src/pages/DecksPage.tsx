import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api";
import { Field, Modal } from "../components/Modal";
import { ErrorBanner, Screen } from "../components/Screen";
import { SelectionPicker } from "../components/SelectionPicker";
import { useAction, useLoader } from "../hooks";
import type { CardSelection, Category, Deck } from "../types";

export function DecksPage() {
  const navigate = useNavigate();
  const decks = useLoader(() => api.listDecks(), []);
  const categories = useLoader(() => api.listCategories(), []);
  const [dialog, setDialog] = useState<"deck" | "sr" | "category" | null>(null);

  async function reload() {
    await Promise.all([decks.reload(), categories.reload()]);
  }

  const all = decks.data ?? [];
  const groups = groupByCategory(all, categories.data ?? []);

  return (
    <Screen title="Decks">
      <ErrorBanner message={decks.error ?? categories.error} />

      {all.length === 0 && !decks.loading && (
        <div className="empty">
          No decks yet.
          <br />
          Create one, then add cards by hand or import them as JSON.
        </div>
      )}

      {groups.map((group) => (
        <div key={group.name} className="deck-list">
          <div className="section-title">
            <span>{group.name}</span>
            {group.category && (
              <CategoryActions category={group.category} onDone={reload} />
            )}
          </div>
          {group.decks.map((deck) => (
            <div
              key={deck.id}
              className="deck-row"
              onClick={() => navigate(`/deck/${deck.id}`)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{deck.name}</div>
                <div className="meta">
                  {deck.cardCount} cards
                  {deck.description && ` · ${deck.description}`}
                </div>
              </div>
              {deck.kind === "sr" && <span className="badge sr">SR</span>}
              {deck.kind === "sr" && deck.dueCount > 0 && (
                <span className="badge due">{deck.dueCount} due</span>
              )}
            </div>
          ))}
        </div>
      ))}

      <div className="row wrap">
        <button className="btn primary" onClick={() => setDialog("deck")}>
          New deck
        </button>
        <button className="btn" onClick={() => setDialog("sr")}>
          New SR deck
        </button>
        <button className="btn ghost" onClick={() => setDialog("category")}>
          New category
        </button>
      </div>

      {dialog === "deck" && (
        <DeckModal
          categories={categories.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog === "sr" && (
        <SrDeckModal
          categories={categories.data ?? []}
          decks={all.filter((deck) => deck.kind === "normal")}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog === "category" && (
        <CategoryModal onClose={() => setDialog(null)} onSaved={reload} />
      )}
    </Screen>
  );
}

interface Group {
  name: string;
  category: Category | null;
  decks: Deck[];
}

/** Groups decks under their category, with uncategorised ones last. */
function groupByCategory(decks: Deck[], categories: Category[]): Group[] {
  const groups: Group[] = categories
    .map((category) => ({
      name: category.name,
      category,
      decks: decks.filter((deck) => deck.categoryId === category.id),
    }))
    .filter((group) => group.decks.length > 0);

  const loose = decks.filter((deck) => deck.categoryId === null);
  if (loose.length > 0) {
    groups.push({
      name: groups.length > 0 ? "Uncategorised" : "All decks",
      category: null,
      decks: loose,
    });
  }
  return groups;
}

function CategoryActions({
  category,
  onDone,
}: {
  category: Category;
  onDone: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const action = useAction();

  return (
    <span className="row">
      <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Rename">
        ✎
      </button>
      <button
        className="icon-btn"
        aria-label="Delete category"
        onClick={async () => {
          if (!confirm(`Delete the category "${category.name}"? Its decks are kept.`)) {
            return;
          }
          await action.run(() => api.deleteCategory(category.id));
          await onDone();
        }}
      >
        🗑
      </button>
      {editing && (
        <CategoryModal
          category={category}
          onClose={() => setEditing(false)}
          onSaved={onDone}
        />
      )}
    </span>
  );
}

export function CategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category?: Category;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      category ? api.updateCategory(category.id, name) : api.createCategory(name),
    );
    if (!saved) return;
    await onSaved();
    onClose();
  }

  return (
    <Modal
      title={category ? "Rename category" : "New category"}
      onClose={onClose}
      footer={
        <>
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
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

export function DeckModal({
  deck,
  categories,
  onClose,
  onSaved,
}: {
  deck?: Deck;
  categories: Category[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(deck?.name ?? "");
  const [description, setDescription] = useState(deck?.description ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(deck?.categoryId ?? null);
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      deck
        ? api.updateDeck(deck.id, name, categoryId, description)
        : api.createDeck(name, categoryId, description),
    );
    if (!saved) return;
    await onSaved();
    onClose();
  }

  return (
    <Modal
      title={deck ? "Edit deck" : "New deck"}
      onClose={onClose}
      footer={
        <>
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
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Category">
        <CategorySelect
          categories={categories}
          value={categoryId}
          onChange={setCategoryId}
        />
      </Field>
      <Field label="Description">
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

export function CategorySelect({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(event) =>
        onChange(event.target.value === "" ? null : Number(event.target.value))
      }
    >
      <option value="">No category</option>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </select>
  );
}

function SrDeckModal({
  categories,
  decks,
  onClose,
  onSaved,
}: {
  categories: Category[];
  decks: Deck[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [selections, setSelections] = useState<CardSelection[]>([]);
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      api.createSrDeck(name, categoryId, "", selections),
    );
    if (!saved) return;
    await onSaved();
    onClose();
  }

  return (
    <Modal
      title="New spaced repetition deck"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={action.busy}>
            Create
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
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Category">
        <CategorySelect
          categories={categories}
          value={categoryId}
          onChange={setCategoryId}
        />
      </Field>
      <div className="section-title">Cards to include</div>
      <div className="small muted">
        Tick a deck to take all of it, or fill in the two boxes to take a slice by
        card number.
      </div>
      <SelectionPicker decks={decks} value={selections} onChange={setSelections} />
    </Modal>
  );
}
