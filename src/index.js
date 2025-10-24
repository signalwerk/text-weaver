#!/usr/bin/env node
/**
 * OCR line-break fixer with LLM-assisted *hyphen-split* classification.
 *
 * Rules (as requested):
 * - We DO NOT ask the LLM about normal linebreaks.
 * - Default for non-hyphen single linebreaks: JOIN_WITH_SPACE.
 * - Only send hyphen-at-line-end splits to LLM to choose:
 *     - UNHYPHENATE
 *     - KEEP_HYPHEN_JOIN
 * - If LLM confidence < threshold: leave hyphen+newline untouched and flag for review.
 *
 * Usage:
 *   node ocr-unwrap.js input.txt > output.txt
 *   # or:
 *   cat input.txt | node ocr-unwrap.js > output.txt
 *
 * Env (.env supported):
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o-mini
 *   MAX_CANDIDATES_PER_CALL=10
 *   CONFIDENCE_THRESHOLD=0.7
 *
 * Optional file:
 *   keep-hyphens.txt   # one compound per line (e.g., Peer-to-Peer)
 *
 * Output:
 *   - Cleaned text to stdout.
 *   - JSON audit (batches + summary) to stderr.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

// --- Config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("ERROR: Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_CANDIDATES_PER_CALL = Number(
  process.env.MAX_CANDIDATES_PER_CALL || 10,
);
const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.7);
const KEEP_HYPHENS_PATH = path.resolve(process.cwd(), "keep-hyphens.txt");

// --- Helpers ---
async function readAllText(maybePath) {
  if (maybePath && fs.existsSync(maybePath)) {
    return fs.readFileSync(maybePath, "utf8");
  }
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function loadKeepHyphenList() {
  try {
    if (fs.existsSync(KEEP_HYPHENS_PATH)) {
      const raw = fs.readFileSync(KEEP_HYPHENS_PATH, "utf8");
      return new Set(
        raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  } catch {}
  return new Set();
}

/**
 * Detect ONLY hyphen-split candidates of the form:
 *   <letters> - [spaces] \n [spaces] <non-space>
 *
 * Returns sorted candidates with spans [start,end) covering:
 *   "-<spaces>\n<spaces>" (up to just before the first non-space char on the right)
 */
function buildHyphenCandidates(text) {
  const cands = [];
  // Use Unicode letters; ensure we catch German umlauts/ß etc.
  const re = /(\p{L}+)-[ \t]*\n[ \t]*([^\s])/gu;

  for (const match of text.matchAll(re)) {
    const full = match[0];
    const leftWord = match[1]; // without hyphen
    const idx = match.index;

    // After the left word, the substring looks like:
    //   "-" <spaces> "\n" <spaces> <firstNonSpaceChar>
    const afterLeft = full.slice(leftWord.length); // starts with '-'
    const m2 = afterLeft.match(/^-\s*\n\s*/);
    if (!m2) continue; // safety
    const hyphenBlockLen = m2[0].length;

    const spanStart = idx + leftWord.length; // at the hyphen
    const spanEnd = spanStart + hyphenBlockLen; // before the first non-space char

    const leftCtxStart = Math.max(0, idx - 60);
    const rightCtxEnd = Math.min(text.length, idx + full.length + 60);

    cands.push({
      id: `h_${cands.length + 1}`,
      type: "HYPHEN_SPLIT",
      span: { start: spanStart, end: spanEnd },
      fragments: {
        left_line_end: leftWord + "-",
        right_line_start: text.slice(
          spanEnd,
          Math.min(text.length, spanEnd + 32),
        ),
      },
      left_context: text.slice(leftCtxStart, spanStart + 1), // include the hyphen
      right_context: text.slice(spanEnd, rightCtxEnd),
    });
  }

  cands.sort((a, b) => a.span.start - b.span.start);
  return cands;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(original, candidates, keepHyphenList) {
  const rules = {
    languages: ["de", "en"],
    keep_real_compound_hyphens: Array.from(keepHyphenList),
    do_not_adjust_punctuation_spacing: true,
  };

  const output_schema = {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            decision: { enum: ["UNHYPHENATE", "KEEP_HYPHEN_JOIN"] },
            replacement: { type: "string" },
            confidence: { type: "number" },
            rationale_short: { type: "string" },
            flag_review: { type: "boolean" },
          },
          required: ["id", "decision", "replacement", "confidence"],
        },
      },
    },
    required: ["decisions"],
  };

  const system = `You are a careful text restorer for OCR output.
You ONLY classify hyphenated line-end splits and output strict JSON.
German + English only. Do NOT propose edits outside candidate spans.
Decisions:
- UNHYPHENATE: remove trailing '-' + linebreak and join fragments (e.g., Kompe-\\ntenzen -> Kompetenzen).
- KEEP_HYPHEN_JOIN: keep real hyphenated compound; remove only the linebreak (Peer-to-\\nPeer -> Peer-to-Peer).
Do not adjust punctuation spacing or any other formatting. Return ONLY JSON per schema.`;

  const userPayload = {
    original_text_excerpt: original,
    candidates,
    rules,
    output_schema,
    format: "Return ONLY valid JSON matching the schema. No extra text.",
  };

  return { system, userPayload };
}

async function callOpenAIChatJSON({ model, system, userPayload }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${txt || res.statusText}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("LLM did not return valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.decisions)) {
    throw new Error("LLM JSON missing 'decisions' array.");
  }
  return parsed.decisions;
}

/**
 * Apply LLM patches to hyphen-split spans (left->right).
 * - If decision is UNHYPHENATE or KEEP_HYPHEN_JOIN and confidence OK: replace span with provided replacement.
 * - If confidence below threshold: skip (keep original hyphen+newline) and flag for review.
 */
function applyHyphenPatches(original, candidates, decisions, threshold) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const patches = [];

  for (const cand of candidates) {
    const d = byId.get(cand.id);
    if (!d) continue;

    if (typeof d.confidence !== "number") d.confidence = 0;
    if (d.confidence < threshold) {
      d.flag_review = true;
      continue; // leave untouched for review
    }

    if (d.decision === "UNHYPHENATE" || d.decision === "KEEP_HYPHEN_JOIN") {
      patches.push({
        id: d.id,
        start: cand.span.start,
        end: cand.span.end,
        replacement: d.replacement,
        decision: d.decision,
        confidence: d.confidence,
        rationale_short: d.rationale_short || "",
      });
    }
  }

  // Apply non-overlapping patches left-to-right
  patches.sort((a, b) => a.start - b.start);

  const nonOverlapping = [];
  let lastEnd = -1;
  for (const p of patches) {
    if (p.start >= lastEnd) {
      nonOverlapping.push(p);
      lastEnd = p.end;
    }
  }

  let text = original;
  let offset = 0;
  const applied = [];
  for (const p of nonOverlapping) {
    const realStart = p.start + offset;
    const realEnd = p.end + offset;
    const slice = text.slice(realStart, realEnd);
    // Expect slice to include a newline and a '-' nearby
    if (
      !slice.includes("\n") ||
      !text.slice(Math.max(0, realStart - 1), realEnd + 1).includes("-")
    ) {
      continue; // safety
    }
    text = text.slice(0, realStart) + p.replacement + text.slice(realEnd);
    offset += p.replacement.length - (realEnd - realStart);
    applied.push(p);
  }

  return { text, applied };
}

/**
 * Join *remaining* single linebreaks with a single space, preserving paragraphs.
 * IMPORTANT: We do NOT join linebreaks that come immediately after a hyphen,
 * to avoid altering low-confidence hyphen cases left for manual review.
 */
function joinSoftLinebreaksDefault(text) {
  // Replace X\nY with X␠Y where X != '\n' and Y != '\n' and X != '-'
  return text.replace(/([^\n-])\n(?!\n)/g, "$1 ");
}

(async function main() {
  try {
    const inputPath =
      process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : null;
    const original = await readAllText(inputPath);
    const keepHyphens = loadKeepHyphenList();

    // 1) Build ONLY hyphen candidates
    const hyphenCands = buildHyphenCandidates(original);

    let working = original;
    let appliedAll = [];
    let flagged = [];

    if (hyphenCands.length > 0) {
      const batches = chunk(hyphenCands, MAX_CANDIDATES_PER_CALL);

      for (let i = 0; i < batches.length; i++) {
        const { system, userPayload } = buildPrompt(
          working,
          batches[i],
          keepHyphens,
        );

        const decisions = await callOpenAIChatJSON({
          model: OPENAI_MODEL,
          system,
          userPayload,
        });

        // Log batch to stderr
        console.error(
          JSON.stringify(
            { batch: i + 1, totalBatches: batches.length, decisions },
            null,
            2,
          ),
        );

        const { text: newText, applied } = applyHyphenPatches(
          working,
          batches[i],
          decisions,
          CONFIDENCE_THRESHOLD,
        );

        // Gather low-confidence flags (not applied)
        for (const d of decisions) {
          if (
            typeof d.confidence !== "number" ||
            d.confidence < CONFIDENCE_THRESHOLD
          ) {
            flagged.push({
              id: d.id,
              decision: d.decision,
              confidence: d.confidence || 0,
              rationale_short: d.rationale_short || "",
            });
          }
        }

        working = newText;
        appliedAll = appliedAll.concat(applied);
      }
    }

    // 2) Default behavior for remaining single linebreaks (non-paragraph): JOIN_WITH_SPACE
    //    (but skip those that follow a hyphen)
    const finalText = joinSoftLinebreaksDefault(working);

    // 3) Summary audit
    console.error(
      JSON.stringify(
        {
          summary: {
            hyphen_candidates: hyphenCands.length,
            applied_hyphen_patches: appliedAll.length,
            flagged_low_confidence: flagged.length,
            default_join_with_space_applied: finalText !== working, // boolean hint
          },
          flagged,
        },
        null,
        2,
      ),
    );

    process.stdout.write(finalText);
  } catch (err) {
    console.error("ERROR:", err?.message || String(err));
    process.exit(1);
  }
})();
