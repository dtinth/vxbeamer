import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { App } from "./App.tsx";
import { createIdbAudioStorage } from "./idbAudioStorage.ts";
import { attachAudioStorage } from "./recordedAudio.ts";

// Bring back the recordings saved on this device, and keep saving new ones.
const audioStorage = createIdbAudioStorage();
if (audioStorage) void attachAudioStorage(audioStorage);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
