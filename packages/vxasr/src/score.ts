/**
 * Mixed error rate (MER) for Thai speech with English terms in it
 * (dtinth/vxbeamer#86).
 *
 * Plain WER needs word boundaries, and written Thai has none: they come from a
 * tokenizer, and a different tokenizer gives a different score for the same
 * transcript. So the unit here depends on the script:
 *
 * - A run of non-Thai letters or digits (`TypeScript`, `MongoDB`) is one token.
 * - Each Thai grapheme cluster is one token, so a tone mark or an above/below
 *   vowel stays with the consonant it sits on.
 * - Spaces and punctuation are not tokens. Random spacing between Thai words,
 *   upper/lower case and a trailing full stop are therefore not errors.
 *
 * A reference can give alternatives, `{โปรเจกต์|project}`, for text that has
 * more than one correct spelling. A transcript is scored against the
 * combination of alternatives that it matches best.
 */

export type TokenStatus = "correct" | "substituted" | "inserted";

/** One token of a transcript, located in the original text. */
export interface Token {
  /** Normalised text, used for comparison. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A piece of the transcript, in order, for display. */
export type ScoredSegment =
  | { readonly kind: "token"; readonly text: string; readonly status: TokenStatus }
  /** Text between tokens (spaces, punctuation). Not scored. */
  | { readonly kind: "separator"; readonly text: string }
  /** Reference text that the transcript left out. */
  | { readonly kind: "deleted"; readonly text: string };

export interface ScoreResult {
  /** Substitutions + deletions + insertions. */
  readonly errors: number;
  /** Tokens in the best-matching reference. */
  readonly referenceTokens: number;
  /** `errors / referenceTokens`. Can be more than 1 when the transcript has many insertions. */
  readonly errorRate: number;
  /** The reference with the alternatives that matched best. */
  readonly matchedReference: string;
  readonly segments: readonly ScoredSegment[];
}

const THAI = /\p{Script=Thai}/u;
const WORD = /[\p{L}\p{N}\p{M}]/u;
const graphemes = new Intl.Segmenter("th", { granularity: "grapheme" });

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let word: { start: number; end: number } | undefined;
  const endWord = () => {
    if (!word) return;
    tokens.push({ text: normalise(text.slice(word.start, word.end)), ...word });
    word = undefined;
  };

  for (const { segment, index } of graphemes.segment(text)) {
    const end = index + segment.length;
    if (THAI.test(segment)) {
      endWord();
      tokens.push({ text: normalise(segment), start: index, end });
    } else if (WORD.test(segment)) {
      if (word) word.end = end;
      else word = { start: index, end };
    } else {
      endWord();
    }
  }
  endWord();
  return tokens;
}

function normalise(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** Every reference that `{a|b}` alternatives can give. */
export function expandAlternatives(reference: string): string[] {
  const match = /\{([^{}]*)\}/.exec(reference);
  if (!match) return [reference];
  const before = reference.slice(0, match.index);
  const after = reference.slice(match.index + match[0].length);
  return match[1]!
    .split("|")
    .flatMap((choice) => expandAlternatives(after).map((rest) => before + choice + rest));
}

type Operation =
  | { readonly op: "match" | "substitute"; readonly ref: number; readonly hyp: number }
  | { readonly op: "delete"; readonly ref: number }
  | { readonly op: "insert"; readonly hyp: number };

/** Levenshtein distance over tokens, with one optimal alignment. */
function align(ref: readonly Token[], hyp: readonly Token[]) {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const cost = new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i++) cost[i * cols] = i;
  for (let j = 0; j < cols; j++) cost[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = ref[i - 1]!.text === hyp[j - 1]!.text;
      cost[i * cols + j] = Math.min(
        cost[(i - 1) * cols + (j - 1)]! + (same ? 0 : 1),
        cost[(i - 1) * cols + j]! + 1,
        cost[i * cols + (j - 1)]! + 1,
      );
    }
  }

  const operations: Operation[] = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    const here = cost[i * cols + j]!;
    if (i > 0 && j > 0) {
      const same = ref[i - 1]!.text === hyp[j - 1]!.text;
      if (here === cost[(i - 1) * cols + (j - 1)]! + (same ? 0 : 1)) {
        operations.push({ op: same ? "match" : "substitute", ref: i - 1, hyp: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && here === cost[(i - 1) * cols + j]! + 1) {
      operations.push({ op: "delete", ref: i - 1 });
      i--;
    } else {
      operations.push({ op: "insert", hyp: j - 1 });
      j--;
    }
  }
  operations.reverse();
  return { distance: cost[rows * cols - 1]!, operations };
}

export function score(reference: string, transcript: string): ScoreResult {
  const hyp = tokenize(transcript);

  let best: { reference: string; ref: Token[]; alignment: ReturnType<typeof align> } | undefined;
  for (const candidate of expandAlternatives(reference)) {
    const ref = tokenize(candidate);
    const alignment = align(ref, hyp);
    const better =
      !best ||
      alignment.distance < best.alignment.distance ||
      // On a tie, the longer reference gives the lower (kinder) rate.
      (alignment.distance === best.alignment.distance && ref.length > best.ref.length);
    if (better) best = { reference: candidate, ref, alignment };
  }
  const { ref, alignment } = best!;

  const segments: ScoredSegment[] = [];
  let cursor = 0;
  const pushToken = (index: number, status: TokenStatus) => {
    const token = hyp[index]!;
    if (token.start > cursor) {
      segments.push({ kind: "separator", text: transcript.slice(cursor, token.start) });
    }
    segments.push({ kind: "token", text: transcript.slice(token.start, token.end), status });
    cursor = token.end;
  };
  for (const operation of alignment.operations) {
    if (operation.op === "match") pushToken(operation.hyp, "correct");
    else if (operation.op === "substitute") pushToken(operation.hyp, "substituted");
    else if (operation.op === "insert") pushToken(operation.hyp, "inserted");
    else {
      const token = ref[operation.ref]!;
      segments.push({ kind: "deleted", text: best!.reference.slice(token.start, token.end) });
    }
  }
  if (cursor < transcript.length) {
    segments.push({ kind: "separator", text: transcript.slice(cursor) });
  }

  const referenceTokens = ref.length;
  return {
    errors: alignment.distance,
    referenceTokens,
    errorRate:
      referenceTokens === 0 ? (hyp.length === 0 ? 0 : 1) : alignment.distance / referenceTokens,
    matchedReference: best!.reference,
    segments,
  };
}
