import { useState } from "react";
import { HashRouter, Route, Routes, useNavigate } from "react-router-dom";

import { Layout } from "./components/Layout";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { PromptsPage } from "./pages/PromptsPage";
import { ServerSetup } from "./pages/ServerSetup";
import { SrTrainer } from "./pages/SrTrainer";
import { StoryTrainer } from "./pages/StoryTrainer";
import { StudyPage } from "./pages/StudyPage";
import { getServerUrl } from "./server";

export default function App() {
  // Until a server is set up there is nothing to show but the setup screen.
  const [configured, setConfigured] = useState(() => getServerUrl() !== null);

  return (
    <HashRouter>
      <div className="app">
        {configured ? (
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<DecksPage />} />
              <Route path="/study" element={<StudyPage />} />
              <Route path="/prompts" element={<PromptsPage />} />
            </Route>
            <Route path="/deck/:deckId" element={<DeckPage />} />
            <Route path="/deck/:deckId/story" element={<StoryTrainer />} />
            <Route path="/deck/:deckId/review" element={<SrTrainer />} />
            <Route path="/settings" element={<ServerSettings />} />
          </Routes>
        ) : (
          <ServerSetup firstRun onDone={() => setConfigured(true)} />
        )}
      </div>
    </HashRouter>
  );
}

function ServerSettings() {
  const navigate = useNavigate();
  return <ServerSetup onDone={() => navigate("/", { replace: true })} />;
}
