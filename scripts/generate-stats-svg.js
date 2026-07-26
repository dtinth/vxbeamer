#!/usr/bin/env node
// Generates stats.svg — cost & throughput infographic for README

// Qwen3.5-Omni-Flash Realtime: a single model does ASR and formatting in one
// pass, so there is no separate post-processing cost to break out — just
// audio-in tokens and the text those tokens produce.
const OMNI_AUDIO_TOKENS_PER_SEC = 7;
const OMNI_AUDIO_PRICE_PER_1M = 4.5;
// Empirical, from an analytics DB of actual usage (4.74 hours of audio,
// 32,947 transcribed words): text tokens and words don't derive from a fixed
// rate, they're however much the model chose to say — 55,494 input text
// tokens + 35,884 output text tokens over that sample.
const SAMPLE_HOURS = 4.74;
const SAMPLE_WORDS = 32947;
const OMNI_TEXT_INPUT_TOKENS_PER_HOUR = 11708;
const OMNI_TEXT_OUTPUT_TOKENS_PER_HOUR = 7570;
const OMNI_TEXT_INPUT_PRICE_PER_1M = 0.55;
const OMNI_TEXT_OUTPUT_PRICE_PER_1M = 3.3;

const SECS_PER_HOUR = 3600;
const WORDS_PER_HOUR = SAMPLE_WORDS / SAMPLE_HOURS;

const audioCost =
  ((OMNI_AUDIO_TOKENS_PER_SEC * SECS_PER_HOUR) / 1_000_000) * OMNI_AUDIO_PRICE_PER_1M;
const textCost =
  (OMNI_TEXT_INPUT_TOKENS_PER_HOUR / 1_000_000) * OMNI_TEXT_INPUT_PRICE_PER_1M +
  (OMNI_TEXT_OUTPUT_TOKENS_PER_HOUR / 1_000_000) * OMNI_TEXT_OUTPUT_PRICE_PER_1M;
const totalCostPerHour = audioCost + textCost;
const wordsPerDollar = WORDS_PER_HOUR / totalCostPerHour;

const fmtCost = (n) => `$${n.toFixed(4)}`;
const fmtWords = (n) => Math.round(n).toLocaleString("en-US");

// Layout
const W = 640;
const H = 140;
const PAD = 32;
const GAP = 16;
const COL = (W - PAD * 2 - GAP) / 2;

const ACCENT = "#6366f1";
const ACCENT2 = "#22d3ee";
const BG = "#353433";
const CARD = "#252423";
const TEXT = "#e9e8e7";
const MUTED = "#8b8685";

function card(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${CARD}" />`;
}

function stat(cx, y, value, label, color) {
  return `
    <text x="${cx}" y="${y}" text-anchor="middle" font-size="22" font-weight="700" fill="${color}" font-family="ui-monospace,monospace">${value}</text>
    <text x="${cx}" y="${y + 20}" text-anchor="middle" font-size="11" fill="${MUTED}" font-family="system-ui,sans-serif">${label}</text>`;
}

const CARD_Y = 44;
const CARD_H = 72;
const ROW_Y = CARD_Y + 36;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="14" fill="${BG}" />

  <!-- Title -->
  <text x="${PAD}" y="30" font-size="13" font-weight="600" fill="${TEXT}" font-family="system-ui,sans-serif">Cost &amp; throughput</text>
  <text x="${W - PAD}" y="30" text-anchor="end" font-size="11" fill="${MUTED}" font-family="system-ui,sans-serif">Qwen3.5-Omni-Flash Realtime</text>

  <!-- Stat cards -->
  ${card(PAD, CARD_Y, COL, CARD_H)}
  ${card(PAD + COL + GAP, CARD_Y, COL, CARD_H)}

  ${stat(PAD + COL / 2, ROW_Y, fmtCost(totalCostPerHour), "per hour of audio", ACCENT)}
  ${stat(PAD + COL + GAP + COL / 2, ROW_Y, fmtWords(wordsPerDollar), "words per $1", ACCENT2)}
</svg>`;

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "stats.svg");
writeFileSync(outPath, svg.trim());
console.log(`Written: ${outPath}`);
console.log(`Cost:  ${fmtCost(totalCostPerHour)}/hr`);
console.log(`Words: ${fmtWords(wordsPerDollar)}/$1`);
console.log(
  `\nPlease update the alt text in README.md to:\n  ![Cost per hour of audio — ${fmtCost(totalCostPerHour)}, ${fmtWords(wordsPerDollar)} words per dollar](./stats.svg)`,
);
