import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Minting a presigned URL is the *whole* of the backend's involvement in eval
 * storage. The browser holds the audio (#38: eval runs are collected
 * client-side) and PUTs it to the bucket itself, so the recording never touches
 * this process — which is what keeps "the backend never stores recordings" a
 * structural fact rather than a rule someone has to remember. It also means no
 * bucket credential is ever handed to a browser: what crosses the wire is a
 * signature over one key, one method, and a deadline.
 */

/** The two kinds of object this bucket holds. Also the `type` discriminator. */
export type EvalObjectKind = "vote" | "eval-set";

export interface EvalUploadTarget {
  /** Presigned URL accepting exactly one PUT of `application/json`. */
  readonly url: string;
  /** The object key the PUT lands on, so a client can log where it went. */
  readonly key: string;
}

export interface EvalUploadTargets {
  readonly vote: EvalUploadTarget;
  readonly evalSet: EvalUploadTarget;
  readonly expiresInSeconds: number;
}

export interface EvalStorage {
  createUploadTargets(input: { messageId: string; at: number }): Promise<EvalUploadTargets>;
}

/**
 * How long a minted URL stays usable.
 *
 * The frontend PUTs within a second of the winner pick, so this is not sized for
 * the happy path — it is headroom for a phone that lost signal mid-upload, a
 * backgrounded tab, or a retry. Five minutes covers all three and still keeps
 * the capability short-lived: the URL is a write to the user's own bucket, and
 * nothing in this flow needs it to outlive the click that produced it. SigV4
 * permits up to 7 days; there is no reason to spend any of it. Note the deadline
 * bounds when the PUT may *start* — a large eval-set already in flight is not
 * cut off at expiry.
 */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** Both objects are JSON; the signature commits to that so the key cannot lie. */
const CONTENT_TYPE = "application/json";

/**
 * `2026-07-16T09:30:00.123Z` → `2026-07-16T09-30-00-123Z`.
 *
 * Colons are legal in S3 keys but are awkward everywhere a key is later used —
 * shell globs, URLs, filenames if you sync the bucket down. Millisecond
 * precision keeps same-second picks apart in a listing.
 */
function timestampSegment(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/**
 * Where an object lands.
 *
 * `votes/2026/07/16/2026-07-16T09-30-00-123Z-<messageId>.json`
 * `eval-sets/2026/07/16/2026-07-16T09-30-00-123Z-<messageId>.json`
 *
 * **Kind first.** The two kinds are read for different jobs at wildly different
 * sizes: "which configuration do I actually pick?" reads every vote (~1 KB each)
 * and no audio, while an eval-set is hundreds of KB of base64 WAV. A shared
 * prefix would force that question to list and filter megabytes to find
 * kilobytes. The `type` field inside the JSON serves a reader who already has
 * the object; the prefix serves the reader deciding what to fetch — both are
 * needed, and they cannot disagree because both derive from the same kind.
 *
 * **Then the date.** S3 lists keys in lexicographic order, so a date path is
 * what makes "votes from March" a bounded, cheap listing instead of a full
 * bucket scan. The vote stream grows once per winner pick forever; it is the one
 * prefix here guaranteed to get big.
 *
 * **Then time-then-id.** The timestamp sorts a day's objects chronologically;
 * the message id makes the key unique (it is a UUID) and joins a vote to its
 * eval-set — the same pick yields the same suffix under both prefixes, so the
 * audio for a vote is a key rewrite away rather than a search.
 *
 * The subject is deliberately **not** in the key. It rides in the payload, where
 * a reader segments on it after loading — vote objects are tiny, so filtering in
 * the reader costs nothing. Putting it in a key would print an opaque OIDC
 * identifier into bucket listings and access logs to buy a narrowing that
 * matters at millions of objects, not at one-per-pick.
 */
export function buildObjectKey(input: {
  kind: EvalObjectKind;
  messageId: string;
  at: number;
  prefix?: string | undefined;
}): string {
  const { kind, messageId, at } = input;
  const date = new Date(at);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const folder = kind === "vote" ? "votes" : "eval-sets";
  const prefix = normalizePrefix(input.prefix);
  return `${prefix}${folder}/${year}/${month}/${day}/${timestampSegment(at)}-${messageId}.json`;
}

/** Tolerates `foo`, `foo/`, and `/foo/` alike; yields `foo/` or `""`. */
function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

export interface EvalStorageEnv {
  EVAL_STORAGE_BUCKET?: string | undefined;
  EVAL_STORAGE_REGION?: string | undefined;
  EVAL_STORAGE_ENDPOINT?: string | undefined;
  EVAL_STORAGE_ACCESS_KEY_ID?: string | undefined;
  EVAL_STORAGE_SECRET_ACCESS_KEY?: string | undefined;
  EVAL_STORAGE_PREFIX?: string | undefined;
  EVAL_STORAGE_FORCE_PATH_STYLE?: string | undefined;
}

/**
 * Builds the presigner, or returns `null` when the bucket is not configured.
 *
 * `null` rather than a throw: eval storage is bookkeeping, and a server with no
 * bucket must still transcribe and still let a winner replace a primary answer.
 * The bucket name is the switch — a deployment that has not set one has not
 * asked for this feature, and booting is not the moment to argue about it.
 * Credentials, though, are checked here: a bucket named without keys is a
 * half-finished configuration, and failing at boot is far kinder than minting
 * URLs that 403 at the browser, where nobody is looking.
 */
export function createEvalStorage(env: EvalStorageEnv): EvalStorage | null {
  const bucket = env.EVAL_STORAGE_BUCKET?.trim();
  if (!bucket) return null;

  const accessKeyId = env.EVAL_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.EVAL_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "EVAL_STORAGE_BUCKET is set, but EVAL_STORAGE_ACCESS_KEY_ID and " +
        "EVAL_STORAGE_SECRET_ACCESS_KEY are not — eval storage cannot sign uploads",
    );
  }

  const client = new S3Client({
    // S3-compatible vendors (MinIO, R2, B2) ignore the region but the signature
    // covers it, so it still has to be *something* both ends agree on.
    region: env.EVAL_STORAGE_REGION?.trim() || "us-east-1",
    endpoint: env.EVAL_STORAGE_ENDPOINT?.trim() || undefined,
    forcePathStyle: env.EVAL_STORAGE_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId, secretAccessKey },
    // Required for presigning to work at all. The SDK's default
    // ("WHEN_SUPPORTED") computes a CRC32 of the request body and signs it into
    // the URL — but at signing time the body is empty, so it bakes in the
    // checksum of zero bytes and every real upload is rejected as corrupt. The
    // body here is not ours to checksum: it is composed in the browser and
    // never passes through this process. TLS covers the wire.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const prefix = env.EVAL_STORAGE_PREFIX;

  return {
    async createUploadTargets({ messageId, at }) {
      const sign = async (kind: EvalObjectKind): Promise<EvalUploadTarget> => {
        const key = buildObjectKey({ kind, messageId, at, prefix });
        const url = await getSignedUrl(
          client,
          new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: CONTENT_TYPE }),
          { expiresIn: UPLOAD_URL_TTL_SECONDS },
        );
        return { url, key };
      };
      // Signing is local HMAC — no call reaches S3 — so minting the eval-set URL
      // that an unticked save-for-eval will never use costs microseconds. That is
      // cheaper than a request flag the backend would have to trust and branch
      // on, and it keeps the response shape constant.
      const [vote, evalSet] = await Promise.all([sign("vote"), sign("eval-set")]);
      return { vote, evalSet, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
    },
  };
}
