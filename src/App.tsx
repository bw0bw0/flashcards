import { HashRouter, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { PromptsPage } from "./pages/PromptsPage";
import { SrTrainer } from "./pages/SrTrainer";
import { StoryTrainer } from "./pages/StoryTrainer";
import { StudyPage } from "./pages/StudyPage";

export default function App() {
  return (
    <HashRouter>
      <div className="app">
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<DecksPage />} />
            <Route path="/study" element={<StudyPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
          </Route>
          <Route path="/deck/:deckId" element={<DeckPage />} />
          <Route path="/deck/:deckId/story" element={<StoryTrainer />} />
          <Route path="/deck/:deckId/review" element={<SrTrainer />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
