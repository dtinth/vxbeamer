import { beforeAll, expect, test, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvalRow } from "../evalRun.ts";

// `EvalDialog` reaches the store, which reads localStorage as it loads. Stub it
// before the import lands, exactly as the SettingsSheet tests do.
let EvalRowCard: typeof import("./EvalDialog.tsx").EvalRowCard;

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
  ({ EvalRowCard } = await import("./EvalDialog.tsx"));
});

// Real output from one 9 s Thai clip. The gap between these two is the feature.
const QWEN_TRANSCRIPT =
  "project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia " +
  "โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.";
const BYTEPLUS_TRANSCRIPT =
  "project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。";

function row(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    configurationId: "qwen/qwen3-asr-flash-realtime",
    label: "Qwen3-ASR-Flash (raw)",
    isPrimary: false,
    status: "done",
    partial: "",
    final: QWEN_TRANSCRIPT,
    error: null,
    usage: [],
    framesSent: 90,
    ...overrides,
  };
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

test("a finished row leads with the transcript, not with the model's name", () => {
  const markup = render(<EvalRowCard row={row()} selectable pending={false} />);

  expect(markup).toContain(QWEN_TRANSCRIPT);
  expect(markup).toContain("Qwen3-ASR-Flash (raw)");
  // The prose is the thing being judged, so it gets the type size; the label is
  // an eyebrow above it.
  expect(markup).toContain("text-base leading-relaxed whitespace-pre-wrap");
});

test("two rows on the same clip read completely differently", () => {
  const markup = render(
    <>
      <EvalRowCard row={row()} selectable pending={false} />
      <EvalRowCard
        row={row({
          configurationId: "byteplus/bigmodel",
          label: "BytePlus Seed-ASR (raw)",
          final: BYTEPLUS_TRANSCRIPT,
        })}
        selectable
        pending={false}
      />
    </>,
  );

  expect(markup).toContain(QWEN_TRANSCRIPT);
  expect(markup).toContain(BYTEPLUS_TRANSCRIPT);
});

test("a settled row with a transcript is a button that says what tapping it does", () => {
  const markup = render(<EvalRowCard row={row()} selectable pending={false} />);

  expect(markup).toContain("<button");
  expect(markup).toContain("Use this answer");
});

test("a row that is still running cannot be picked", () => {
  const markup = render(
    <EvalRowCard
      row={row({ status: "listening", final: null })}
      selectable={false}
      pending={false}
    />,
  );

  expect(markup).not.toContain("<button");
  expect(markup).not.toContain("Use this answer");
});

test("a row whose pick is in flight says so and stops accepting taps", () => {
  const markup = render(<EvalRowCard row={row()} selectable pending />);

  expect(markup).toContain("Saving…");
  expect(markup).toContain("disabled");
});

// --- Rows that do not behave alike ---

test("a streaming row shows its interim text as it arrives", () => {
  const markup = render(
    <EvalRowCard
      row={row({ status: "listening", partial: "project นี้เขียนด้วย", final: null })}
      selectable={false}
      pending={false}
    />,
  );

  expect(markup).toContain("project นี้เขียนด้วย");
  expect(markup).toContain("Listening");
});

test("a row that never streams shows a live ellipsis rather than looking stalled", () => {
  // A buffering batch adapter is silent for the whole clip and only calls its
  // vendor once the audio stops. That silence is healthy.
  const markup = render(
    <EvalRowCard
      row={row({ status: "finishing", partial: "", final: null })}
      selectable={false}
      pending={false}
    />,
  );

  expect(markup).toContain("eval-ellipsis");
  // Named for the wait, not for the socket.
  expect(markup).toContain("Transcribing");
});

test("the transcript area holds its height so a slow row does not shove the list", () => {
  const waiting = render(
    <EvalRowCard
      row={row({ status: "listening", final: null })}
      selectable={false}
      pending={false}
    />,
  );

  expect(waiting).toContain("min-height:3.25rem");
});

test("a row that is out of the running claims no room for text it will never get", () => {
  // Three uncredentialled configurations each holding three blank lines pushed
  // the one row with an answer off a phone screen.
  const skipped = render(
    <EvalRowCard
      row={row({ status: "skipped", final: null, error: "Not configured on this server" })}
      selectable={false}
      pending={false}
    />,
  );
  const failed = render(
    <EvalRowCard
      row={row({ status: "failed", final: null, error: "boom" })}
      selectable={false}
      pending={false}
    />,
  );

  expect(skipped).not.toContain("min-height");
  expect(failed).not.toContain("min-height");
});

test("a failed row names what went wrong instead of showing an empty result", () => {
  const markup = render(
    <EvalRowCard
      row={row({ status: "failed", final: null, error: "DASHSCOPE_API_KEY not configured" })}
      selectable={false}
      pending={false}
    />,
  );

  expect(markup).toContain("DASHSCOPE_API_KEY not configured");
  expect(markup).toContain("Failed");
  expect(markup).not.toContain("<button");
  // Something broke, and it is worth the alarm.
  expect(markup).toContain("text-(--m3-error)");
});

test("an unconfigured configuration is still listed, so the gap is visible", () => {
  const markup = render(
    <EvalRowCard
      row={row({
        status: "skipped",
        final: null,
        error: "Not configured on this server",
        label: "BytePlus Seed-ASR (raw)",
      })}
      selectable={false}
      pending={false}
    />,
  );

  expect(markup).toContain("BytePlus Seed-ASR (raw)");
  expect(markup).toContain("Not configured on this server");
  expect(markup).toContain("Not set up");
  // But not as a fault: it never entered the run, and a server with three
  // uncredentialled configurations is not three things going wrong.
  expect(markup).not.toContain("text-(--m3-error)");
});

// --- The primary, and cost ---

test("marks the row whose answer a winner would replace", () => {
  const markup = render(<EvalRowCard row={row({ isPrimary: true })} selectable pending={false} />);

  expect(markup).toContain("Current");
  // The primary is a candidate like any other — same card, same tap target.
  expect(markup).toContain("Use this answer");
});

test("shows a row's cost in fine print once usage arrives", () => {
  const markup = render(
    <EvalRowCard
      row={row({ usage: [{ sku: "asr", unitPrice: 0.0001, quantity: 10 }] })}
      selectable
      pending={false}
    />,
  );

  expect(markup).toContain("$0.0010");
});

test("says nothing about cost when there is no usage to report", () => {
  const markup = render(<EvalRowCard row={row()} selectable pending={false} />);

  expect(markup).not.toContain("$");
});
