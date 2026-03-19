import "./style.css";
import { handleCallback, startSignIn, toWebSocketUrl } from "./oidc";

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
      <input id="backend-url" value="${localStorage.getItem("vxbeamer_backend_url") ?? window.location.origin}" autocomplete="off" />
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

const SAMPLE_RATE = 16000;

// Inline AudioWorklet processor: converts Float32 mic samples to Int16 PCM
const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      const int16 = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function createWavBlob(chunks: Int16Array[], sampleRate: number): Blob {
  const pcmLength = chunks.reduce((n, c) => n + c.length, 0) * 2;
  const buffer = new ArrayBuffer(44 + pcmLength);
  const view = new DataView(buffer);
  const write = (offset: number, value: number, bytes: number) => {
    for (let i = 0; i < bytes; i++) view.setUint8(offset + i, (value >> (8 * i)) & 0xff);
  };
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  write(4, 36 + pcmLength, 4);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  write(16, 16, 4);
  write(20, 1, 2); // PCM
  write(22, 1, 2); // mono
  write(24, sampleRate, 4);
  write(28, sampleRate * 2, 4); // byte rate
  write(32, 2, 2); // block align
  write(34, 16, 2); // bits per sample
  writeStr(36, "data");
  write(40, pcmLength, 4);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i]!, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

let accessToken: string | null = null;
let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let recordedChunks: Int16Array[] = [];
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
  downloadUrl = URL.createObjectURL(createWavBlob(recordedChunks, SAMPLE_RATE));
  downloadLink.href = downloadUrl;
  downloadLink.setAttribute("download", "failed-recording.wav");
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

// Handle OIDC redirect callback on page load
void (async () => {
  try {
    const result = await handleCallback();
    if (result) {
      accessToken = result.accessToken;
      backendUrlInput.value = result.backendUrl;
      await connectSocket(result.backendUrl);
      startButton.disabled = false;
      setStatus("Authenticated. Ready to record.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign-in failed";
    setStatus(message);
  }
})();

signInButton.addEventListener("click", async () => {
  signInButton.disabled = true;

  try {
    const baseUrl = backendUrlInput.value.trim();
    localStorage.setItem("vxbeamer_backend_url", baseUrl);
    await startSignIn(baseUrl);
  } catch (error) {
    // startSignIn redirects and never returns; any error here is a real failure
    const message = error instanceof Error ? error.message : "Unable to sign in";
    setStatus(message);
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
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const workletBlob = new Blob([PCM_WORKLET_CODE], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(workletBlob);
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const source = audioContext.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const int16 = new Int16Array(event.data);
      recordedChunks.push(int16);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(event.data);
      }
    };

    source.connect(workletNode);
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

  workletNode?.disconnect();
  workletNode = null;
  void audioContext?.close();
  audioContext = null;

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
