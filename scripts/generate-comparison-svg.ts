#!/usr/bin/env node
// Generates a model-comparison table as an SVG (dtinth/vxbeamer#86).
//
//   node scripts/generate-comparison-svg.ts testdata/comparison/test-audio.json
//
// Writes the SVG next to the JSON. Each transcript is scored with the mixed
// error rate in packages/vxasr/src/score.ts: see there for why this is not
// plain WER.
//
// The table is HTML inside a <foreignObject>, because SVG <text> cannot wrap
// lines, and a long Thai transcript must wrap. The row heights are estimated
// from the text length, because an SVG must give its own size and there is no
// layout engine here to measure with. The estimate is deliberately generous.

import { readFileSync, writeFileSync } from "node:fs";
import { score, type ScoreResult } from "../packages/vxasr/src/score.ts";

interface ComparisonFile {
  audio: string;
  reference: string;
  source: string;
  results: { model: string; route: string; date: string; transcript: string }[];
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("usage: generate-comparison-svg.ts <comparison.json>");
const data = JSON.parse(readFileSync(inputPath, "utf8")) as ComparisonFile;

const rows = data.results
  .map((result) => ({ ...result, score: score(data.reference, result.transcript) }))
  .sort((a, b) => a.score.errorRate - b.score.errorRate || a.model.localeCompare(b.model));

// Layout, in px.
const W = 980;
const PAD = 24;
const MODEL_W = 250;
const SCORE_W = 110;
const TRANSCRIPT_W = W - PAD * 2 - MODEL_W - SCORE_W;
const FONT = 14;
const LINE = 22;
const CELL_PAD_Y = 8;

/** A generous estimate of how wide `text` is at `FONT`, so rows never overflow. */
function estimateWidth(text: string): number {
  let em = 0;
  for (const { segment } of new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text)) {
    em += segment === " " ? 0.3 : 0.62;
  }
  return em * FONT;
}

function rowHeight(result: ScoreResult, transcript: string, model: string): number {
  const deleted = result.segments
    .filter((segment) => segment.kind === "deleted")
    .map((segment) => segment.text)
    .join("");
  const transcriptLines = Math.ceil(estimateWidth(transcript + deleted) / (TRANSCRIPT_W - 16));
  const modelLines = Math.ceil(estimateWidth(model) / (MODEL_W - 16)) + 1; // + the route line
  return Math.max(transcriptLines, modelLines, 2) * LINE + CELL_PAD_Y * 2;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderTranscript(result: ScoreResult): string {
  return result.segments
    .map((segment) => {
      const text = escape(segment.text);
      if (segment.kind === "separator") return text;
      if (segment.kind === "deleted") return `<del>${text}</del>`;
      return segment.status === "correct"
        ? `<b class="ok">${text}</b>`
        : `<b class="bad">${text}</b>`;
    })
    .join("");
}

const percent = (result: ScoreResult) => `${Math.max(0, (1 - result.errorRate) * 100).toFixed(1)}%`;

const HEADER_H = 96;
const TABLE_HEAD_H = 34;
const FOOTER_TEXT_W = W - PAD * 2;
// The accepted reference is long, so its lines are estimated like a row's.
const FOOTER_H =
  12 +
  18 * (1 + Math.ceil(estimateWidth(`Accepted reference: ${data.reference}`) / FOOTER_TEXT_W)) +
  PAD;
const bodyHeights = rows.map((row) => rowHeight(row.score, row.transcript, row.model));
const H = HEADER_H + TABLE_HEAD_H + bodyHeights.reduce((sum, h) => sum + h, 0) + FOOTER_H;

const tableRows = rows
  .map(
    (row, index) => `
      <tr style="height:${bodyHeights[index]}px">
        <td class="model">${escape(row.model)}<div class="route">${escape(row.route)} · ${escape(row.date)}</div></td>
        <td class="transcript">${renderTranscript(row.score)}</td>
        <td class="score">${percent(row.score)}<div class="route">${row.score.errors} / ${row.score.referenceTokens} errors</div></td>
      </tr>`,
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="14" fill="#ffffff" />
  <foreignObject x="0" y="0" width="${W}" height="${H}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="root">
      <style>
        .root { padding: ${PAD}px; font: ${FONT}px/${LINE}px system-ui, "Noto Sans Thai", "Leelawadee UI", Thonburi, sans-serif; color: #1f2328; }
        h1 { margin: 0; font-size: 17px; line-height: 26px; }
        p { margin: 0; color: #59636e; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 14px; }
        th { text-align: left; font-size: 12px; color: #59636e; font-weight: 600; height: ${TABLE_HEAD_H - 14}px; border-bottom: 1px solid #d1d9e0; padding: 0 8px; }
        td { vertical-align: top; padding: ${CELL_PAD_Y}px 8px; border-bottom: 1px solid #eef1f4; overflow-wrap: anywhere; }
        .model { font-weight: 600; font-size: 13px; }
        .route { font-weight: 400; font-size: 11px; color: #59636e; }
        .score { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
        b { font-weight: 400; border-radius: 3px; }
        .ok { color: #116329; background: #dafbe1; }
        .bad { color: #a40e26; background: #ffcecb; text-decoration: underline wavy #cf222e; }
        del { color: #a40e26; opacity: 0.7; }
      </style>
      <h1>Thai speech recognition: one clip, ${rows.length} models</h1>
      <p>Score = 100% − mixed error rate (each Latin word and each Thai character is one token; spaces, punctuation and case are ignored).</p>
      <p><b class="ok">Green</b> = correct. <b class="bad">Red</b> = wrong or extra. <del>Struck out</del> = missing. One run per model, so a score is one sample, not an average.</p>
      <table>
        <colgroup><col style="width:${MODEL_W}px" /><col style="width:${TRANSCRIPT_W}px" /><col style="width:${SCORE_W}px" /></colgroup>
        <tr><th>Model</th><th>Transcript</th><th style="text-align:right">Score</th></tr>${tableRows}
      </table>
      <p style="margin-top:12px">Audio: ${escape(data.audio)} (9.2 s). Source: ${escape(data.source)}.</p>
      <p>Accepted reference: ${escape(data.reference)}</p>
    </div>
  </foreignObject>
</svg>
`;

const outputPath = inputPath.replace(/\.json$/, ".svg");
writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath}`);
for (const row of rows) console.log(`${percent(row.score).padStart(7)}  ${row.model}`);
