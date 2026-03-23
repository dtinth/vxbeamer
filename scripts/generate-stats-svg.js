#!/usr/bin/env node
// Generates stats.svg — cost & stats infographic for README

const QWEN_PER_SEC = 0.000035;
const GROQ_INPUT_TOKENS_PER_HOUR = 37814;
const GROQ_OUTPUT_TOKENS_PER_HOUR = 35944;
const GROQ_INPUT_PRICE_PER_1M = 0.15; // gpt-oss-120b on Groq
const GROQ_OUTPUT_PRICE_PER_1M = 0.6;

const SECS_PER_HOUR = 3600;

const qwenCost = QWEN_PER_SEC * SECS_PER_HOUR;
const groqCost =
  (GROQ_INPUT_TOKENS_PER_HOUR / 1_000_000) * GROQ_INPUT_PRICE_PER_1M +
  (GROQ_OUTPUT_TOKENS_PER_HOUR / 1_000_000) * GROQ_OUTPUT_PRICE_PER_1M;
const totalCost = qwenCost + groqCost;

const fmt = (n) => `$${n.toFixed(4)}`;

// Layout
const W = 640;
const H = 140;
const PAD = 32;
const COL = (W - PAD * 2) / 3;

const ACCENT = "#6366f1";
const ACCENT2 = "#22d3ee";
const ACCENT3 = "#f59e0b";
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
  <text x="${PAD}" y="30" font-size="13" font-weight="600" fill="${TEXT}" font-family="system-ui,sans-serif">Cost per hour of audio</text>
  <text x="${W - PAD}" y="30" text-anchor="end" font-size="11" fill="${MUTED}" font-family="system-ui,sans-serif">Qwen3-ASR-Flash + gpt-oss-120b on Groq</text>

  <!-- Stat cards -->
  ${card(PAD, CARD_Y, COL - 8, CARD_H)}
  ${card(PAD + COL, CARD_Y, COL - 8, CARD_H)}
  ${card(PAD + COL * 2, CARD_Y, COL - 8, CARD_H)}

  ${stat(PAD + (COL - 8) / 2, ROW_Y, fmt(qwenCost), "Qwen3-ASR-Flash (ASR)", ACCENT)}
  ${stat(PAD + COL + (COL - 8) / 2, ROW_Y, fmt(groqCost), "gpt-oss-120b / Groq (LLM)", ACCENT2)}
  ${stat(PAD + COL * 2 + (COL - 8) / 2, ROW_Y, fmt(totalCost), "Total", ACCENT3)}
</svg>`;

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "stats.svg");
writeFileSync(outPath, svg.trim());
console.log(`Written: ${outPath}`);
console.log(`ASR:   ${fmt(qwenCost)}/hr`);
console.log(`LLM:   ${fmt(groqCost)}/hr`);
console.log(`Total: ${fmt(totalCost)}/hr`);
console.log(
  `\nPlease update the alt text in README.md to:\n  ![Cost per hour of audio — ${fmt(totalCost)}](./stats.svg)`,
);
