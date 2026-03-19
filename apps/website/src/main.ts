import "./style.css";
import { exchangePkceToken, toWebSocketUrl } from "./oidc";

type ServerMessage =
  | { type: "connected" }
  | { type: "recording" }
  | { type: "transcription"; text: string; bytes: number }
  | { type: "error"; message: string };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App container not found");
}

app.innerHTML = `
  <main class="mobile-app">
    <h1>VXBeamer Live Transcription</h1>
    <p class="subtitle">Speak on your phone, get your transcript on your computer.</p>

    <label class="field">
      Backend URL
      <input id="backend-url" value="${window.location.origin}" autocomplete="off" />
    </label>

    <div class="actions">
      <button id="sign-in" type="button">Sign in</button>
      <button id="start" type="button" disabled>Start speaking</button>
      <button id="stop" type="button" disabled>Finish</button>
    </div>

    <p id="status" class="status">Sign in to begin.</p>

    <label class="field">
      Transcript
      <textarea id="transcript" readonly placeholder="Your transcript appears here..."></textarea>
    </label>

    <div class="actions secondary">
      <button id="copy" type="button" disabled>Copy transcript</button>
      <a id="download" class="button-link disabled" download="failed-recording.webm" aria-disabled="true">Download recording (on error)</a>
    </div>
  </main>
`;

const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url")!;
const statusElement = document.querySelector<HTMLParagraphElement>("#status")!;
const transcriptElement = document.querySelector<HTMLTextAreaElement>("#transcript")!;
const signInButton = document.querySelector<HTMLButtonElement>("#sign-in")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const downloadLink = document.querySelector<HTMLAnchorElement>("#download")!;

const oidcClientId = "vxbeamer-mobile";
let accessToken: string | null = null;
let socket: WebSocket | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let downloadUrl: string | null = null;

function setStatus(text: string): void {
  statusElement.textContent = text;
}

function disableDownload(): void {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  downloadLink.removeAttribute("href");
  downloadLink.classList.add("disabled");
  downloadLink.setAttribute("aria-disabled", "true");
}

function enableDownload(): void {
  if (recordedChunks.length === 0) {
    return;
  }
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
  }
  downloadUrl = URL.createObjectURL(new Blob(recordedChunks, { type: "audio/webm" }));
  downloadLink.href = downloadUrl;
  downloadLink.classList.remove("disabled");
  downloadLink.setAttribute("aria-disabled", "false");
}

function sendMessage(payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function connectSocket(baseUrl: string): Promise<void> {
  if (!accessToken) {
    throw new Error("Sign in required");
  }
  const token = accessToken;

  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const wsUrl = new URL(toWebSocketUrl(baseUrl));
    wsUrl.searchParams.set("access_token", token);

    socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      setStatus("Connected. Tap Start speaking.");
      resolve();
    };

    socket.onerror = () => {
      reject(new Error("WebSocket connection failed"));
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        setStatus("Received invalid server response.");
        return;
      }

      if (message.type === "connected") {
        setStatus("Backend connected.");
      } else if (message.type === "recording") {
        setStatus("Recording in progress...");
      } else if (message.type === "transcription") {
        transcriptElement.value = message.text;
        copyButton.disabled = false;
        setStatus(`Transcription complete (${message.bytes} bytes).`);
      } else if (message.type === "error") {
        setStatus(`Error: ${message.message}`);
        enableDownload();
      }
    };

    socket.onclose = () => {
      if (startButton.disabled === false) {
        setStatus("Disconnected. Sign in again.");
      }
    };
  });
}

signInButton.addEventListener("click", async () => {
  signInButton.disabled = true;
  startButton.disabled = true;

  try {
    const baseUrl = backendUrlInput.value.trim();
    accessToken = await exchangePkceToken(baseUrl, oidcClientId);
    await connectSocket(baseUrl);
    startButton.disabled = false;
    setStatus("Authenticated. Ready to record.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sign in";
    setStatus(message);
    accessToken = null;
  } finally {
    signInButton.disabled = false;
  }
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  stopButton.disabled = false;
  transcriptElement.value = "";
  copyButton.disabled = true;
  disableDownload();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await connectSocket(backendUrlInput.value.trim());

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size === 0) {
        return;
      }

      recordedChunks.push(event.data);
      const arrayBuffer = await event.data.arrayBuffer();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(arrayBuffer);
      }
    };

    mediaRecorder.onstop = () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    };

    mediaRecorder.start(300);
    sendMessage({ type: "start" });
    setStatus("Recording started.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone unavailable";
    setStatus(message);
    startButton.disabled = false;
    stopButton.disabled = true;
  }
});

stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  startButton.disabled = false;

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }

  sendMessage({ type: "stop" });
  setStatus("Finishing and transcribing...");
});

copyButton.addEventListener("click", async () => {
  if (!transcriptElement.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(transcriptElement.value);
    setStatus("Transcript copied.");
  } catch {
    setStatus("Unable to copy transcript.");
  }
});
