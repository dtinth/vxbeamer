// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { AudioSource } from "../audio.ts";

// React only batches state updates inside `act` when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  closed = false;
  sent: unknown[] = [];
  private listeners = new Map<string, Array<() => void>>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener();
  }
}

/** A mic whose `start()` stays pending until the test lets it finish — the slow `getUserMedia`. */
function createSlowSources() {
  const sources: Array<{
    source: AudioSource;
    finishStart: () => void;
    stopped: boolean;
  }> = [];
  const createAudioSource = (): AudioSource => {
    let finish: () => void = () => {};
    const entry = {
      stopped: false,
      finishStart: () => finish(),
      source: {
        start: () => new Promise<void>((resolve) => (finish = resolve)),
        stop: () => {
          entry.stopped = true;
        },
        getFrequencyData: () => null,
      } satisfies AudioSource,
    };
    sources.push(entry);
    return entry.source;
  };
  return { sources, createAudioSource };
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const store = await import("../store.ts");
  store.$sessionToken.set("header.payload.signature");
  store.$backendUrl.set("https://backend.example");
  const { RecordingBar } = await import("./RecordingBar.tsx");
  const { sources, createAudioSource } = createSlowSources();
  act(() => root.render(<RecordingBar createAudioSource={createAudioSource} />));
  const button = () => container.querySelector<HTMLButtonElement>("[data-shortcut=record-toggle]")!;
  const tap = () => act(() => button().click());
  /** Let the pending `start()` finish and its continuation run. */
  const finishMic = async (index: number) => {
    await act(async () => {
      sources[index]!.finishStart();
    });
  };
  return { store, sources, tap, finishMic, button };
}

/** Sources still capturing: started and not yet stopped. */
function live(sources: Array<{ stopped: boolean }>) {
  return sources.filter((s) => !s.stopped);
}

test("Start, Stop, Start in quick succession leaves exactly one recording active", async () => {
  const { store, sources, tap, finishMic } = await mount();

  tap(); // Start — the mic is still opening
  tap(); // Stop — pressed before the first recording was ever live
  tap(); // Start again
  await finishMic(0);
  if (sources[1]) await finishMic(1);
  if (sources[2]) await finishMic(2);

  // Whatever is still capturing must be the one recording the app knows about.
  expect(live(sources)).toHaveLength(1);
  expect(store.$activeRecordingReferenceId.get()).not.toBeNull();
  const sockets = FakeWebSocket.instances.filter((ws) => !ws.closed);
  expect(sockets).toHaveLength(1);
});

test("a Stop pressed while the mic is still starting cancels that recording", async () => {
  const { store, sources, tap, finishMic } = await mount();

  tap(); // Start
  tap(); // Stop, before the mic has opened
  await finishMic(0);

  expect(live(sources)).toHaveLength(0);
  expect(store.$activeRecordingReferenceId.get()).toBeNull();
  expect(FakeWebSocket.instances.filter((ws) => !ws.closed)).toHaveLength(0);
});
