#!/usr/bin/env node
/**
 * Hyphen-split fixer with optional LLM classification.
 *
 * - Only hyphen-at-line-end splits are sent to the LLM.
 * - Single non-paragraph linebreaks are joined with a single space by default.
 * - Word-based context windows (configurable).
 * - keep-hyphens.txt = rule list to always KEEP hyphen and join (skip LLM).
 *
 * Usage:
 *   node ocr-unwrap.js input.txt > output.txt
 *   # or:
 *   cat input.txt | node ocr-unwrap.js > output.txt
 *
 * Env (.env supported):
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o-mini
 *   MAX_CANDIDATES_PER_CALL=300
 *   CONFIDENCE_THRESHOLD=0.7
 *   WORD_CONTEXT_BEFORE=6
 *   WORD_CONTEXT_AFTER=6
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

// ---------- Config ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("ERROR: Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_CANDIDATES_PER_CALL = Number(
  process.env.MAX_CANDIDATES_PER_CALL || 300,
);
const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.7);
const WORD_CONTEXT_BEFORE = Number(process.env.WORD_CONTEXT_BEFORE || 6);
const WORD_CONTEXT_AFTER = Number(process.env.WORD_CONTEXT_AFTER || 6);
const KEEP_HYPHENS_PATH = path.resolve(process.cwd(), "keep-hyphens.txt");

// ---------- IO ----------
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

// Trim each line; ignore blank or comment lines; case-insensitive set
function loadKeepHyphenList() {
  try {
    if (!fs.existsSync(KEEP_HYPHENS_PATH)) return new Set();
    const raw = fs.readFileSync(KEEP_HYPHENS_PATH, "utf8");
    const items = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    return new Set(items.map((s) => s.toLowerCase()));
  } catch {
    return new Set();
  }
}

// ---------- Text helpers ----------
function isWordChar(ch) {
  return /\p{L}/u.test(ch);
}

// Grab up to N whole words immediately BEFORE position `pos`
function wordContextBefore(text, pos, n) {
  let i = pos - 1;
  const words = [];
  let inWord = false;
  let end = pos;
  while (i >= 0 && words.length < n) {
    const ch = text[i];
    const w = isWordChar(ch);
    if (w && !inWord) {
      // end index of this word is current end
      end = i + 1;
      inWord = true;
    } else if (!w && inWord) {
      // hit the start of a word
      const start = i + 1;
      words.push(text.slice(start, end));
      inWord = false;
    }
    i--;
  }
  if (inWord) {
    const start = i + 1;
    words.push(text.slice(start, end));
  }
  words.reverse();
  return words.join(" ");
}

// Grab up to N whole words immediately AFTER position `pos`
function wordContextAfter(text, pos, n) {
  let i = pos;
  const words = [];
  const L = text.length;
  let inWord = false;
  let start = pos;
  while (i < L && words.length < n) {
    const ch = text[i];
    const w = isWordChar(ch);
    if (w && !inWord) {
      inWord = true;
      start = i;
    } else if (!w && inWord) {
      words.push(text.slice(start, i));
      inWord = false;
    }
    i++;
  }
  if (inWord) {
    words.push(text.slice(start, i));
  }
  return words.join(" ");
}

// Return the contiguous right token (letters) starting at `pos`
function rightWordToken(text, pos) {
  const m = text.slice(pos).match(/^\p{L}+/u);
  return m ? m[0] : "";
}

// ---------- Candidate detection (hyphen + newline only) ----------
/**
 * Detect hyphen-split candidates of the form:
 *   <letters>- [spaces] \n [spaces] <non-space>
 *
 * Span covers "-<spaces>\n<spaces>" up to just before the first non-space char.
 * Leading/trailing spaces on either line won't break detection.
 */
function buildHyphenCandidates(text) {
  const cands = [];
  const re = /(\p{L}+)-[ \t]*\n[ \t]*([^\s])/gu;

  for (const match of text.matchAll(re)) {
    const full = match[0];
    const leftWord = match[1];
    const idx = match.index;

    // Compute span: start at hyphen, end right before first non-space char after newline
    const afterLeft = full.slice(leftWord.length); // starts with '-'
    const m2 = afterLeft.match(/^-\s*\n\s*/);
    if (!m2) continue;
    const hyphenBlockLen = m2[0].length;

    const spanStart = idx + leftWord.length;
    const spanEnd = spanStart + hyphenBlockLen;

    // Word-based context windows
    const left_context = wordContextBefore(
      text,
      spanStart,
      WORD_CONTEXT_BEFORE,
    );
    const right_context = wordContextAfter(text, spanEnd, WORD_CONTEXT_AFTER);

    // Right token preview
    const rightToken = rightWordToken(text, spanEnd);

    cands.push({
      id: `h_${cands.length + 1}`,
      type: "HYPHEN_SPLIT",
      span: { start: spanStart, end: spanEnd },
      leftWord,
      rightToken,
      fragments: {
        left_line_end: leftWord + "-",
        right_line_start: text.slice(
          spanEnd,
          Math.min(text.length, spanEnd + 32),
        ),
      },
      left_context,
      right_context,
    });
  }

  cands.sort((a, b) => a.span.start - b.span.start);
  return cands;
}

// ---------- OpenAI ----------
function buildPrompt(original, candidates) {
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
            // Span-only replacement:
            // UNHYPHENATE -> "" (delete the span)
            // KEEP_HYPHEN_JOIN -> "-" (keep the hyphen, remove break+spaces)
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

  const system = `You classify ONLY hyphen-at-line-end splits and return strict JSON.
- Languages: German and English.
- Never modify text outside the candidate span.
- Decisions:
  • UNHYPHENATE: remove trailing '-' + linebreak and join fragments (e.g., Kompe-\\ntenzen -> Kompetenzen).
  • KEEP_HYPHEN_JOIN: keep real hyphenated compound; remove only the linebreak (Peer-to-\\nPeer -> Peer-to-Peer).
- Do NOT normalize punctuation or spacing beyond the span.
- Use high confidence when the choice is clear (e.g., dictionary/common compounds, keep list patterns).
- Output MUST be valid JSON per schema; no extra text.`;

  // Minimal few-shot example (assistant shows JSON only)
  const exampleUser = {
    original_text_excerpt:
      "… Methoden den Kompe-\n tenzen …\nDas Protokoll ist Peer-to-\nPeer kompatibel …",
    candidates: [
      {
        id: "ex1",
        type: "HYPHEN_SPLIT",
        span: { start: 19, end: 22 },
        fragments: { left_line_end: "Kompe-", right_line_start: "tenzen" },
        left_context: "Methoden den Kompe-",
        right_context: "tenzen und der …",
      },
      {
        id: "ex2",
        type: "HYPHEN_SPLIT",
        span: { start: 66, end: 70 },
        fragments: { left_line_end: "Peer-to-", right_line_start: "Peer" },
        left_context: "… ist Peer-to-",
        right_context: "Peer kompatibel …",
      },
    ],
    output_schema,
    format: "Return ONLY valid JSON matching the schema. No extra text.",
  };

  const exampleAssistant = {
    decisions: [
      {
        id: "ex1",
        decision: "UNHYPHENATE",
        replacement: "",
        confidence: 0.97,
        flag_review: false,
      },
      {
        id: "ex2",
        decision: "KEEP_HYPHEN_JOIN",
        replacement: "-",
        confidence: 0.98,
        flag_review: false,
      },
    ],
  };

  const userPayload = {
    original_text_excerpt: original,
    candidates: candidates.map((c) => ({
      id: c.id,
      type: c.type,
      span: c.span,
      fragments: c.fragments,
      left_context: c.left_context,
      right_context: c.right_context,
    })),
    output_schema,
    format: "Return ONLY valid JSON matching the schema. No extra text.",
  };

  return {
    system,
    // We include a single compact few-shot example to anchor behavior
    fewshot: [
      { role: "user", content: JSON.stringify(exampleUser) },
      { role: "assistant", content: JSON.stringify(exampleAssistant) },
    ],
    userPayload,
  };
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
    throw new Error("Model did not return valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.decisions)) {
    throw new Error("JSON missing 'decisions' array.");
  }
  return parsed.decisions;
}

// ---------- Patching ----------
function applyHyphenPatches(original, candidates, decisions, threshold) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const patches = [];
  const low = [];

  for (const cand of candidates) {
    const d = byId.get(cand.id);
    if (!d) continue;
    if (typeof d.confidence !== "number") d.confidence = 0;
    if (d.confidence < threshold) {
      d.flag_review = true;
      low.push({
        id: d.id,
        decision: d.decision,
        confidence: d.confidence,
        rationale_short: d.rationale_short || "",
      });
      continue;
    }
    if (d.decision === "UNHYPHENATE" || d.decision === "KEEP_HYPHEN_JOIN") {
      patches.push({
        id: d.id,
        start: cand.span.start,
        end: cand.span.end,
        replacement: d.replacement, // "" or "-"
        decision: d.decision,
        confidence: d.confidence,
        rationale_short: d.rationale_short || "",
      });
    }
  }

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
    // sanity check: expect newline within slice
    if (!slice.includes("\n")) continue;
    text = text.slice(0, realStart) + p.replacement + text.slice(realEnd);
    offset += p.replacement.length - (realEnd - realStart);
    applied.push(p);
  }
  return { text, applied, low };
}

/**
 * Join remaining single linebreaks with a single space (paragraphs preserved).
 * - Handles stray spaces around the newline.
 * - Does NOT join when the char immediately before newline is a hyphen (left for review).
 */
function joinSoftLinebreaksDefault(text) {
  return text.replace(/([^\n])[\t ]*\n(?!\n)[\t ]*/g, (m, prev) => {
    if (prev === "-") return m; // keep as-is after hyphen
    return prev + " ";
  });
}

// ---------- Main ----------
(async function main() {
  try {
    const inputPath =
      process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : null;
    const original = await readAllText(inputPath);

    // 1) Detect hyphen candidates
    const hyphenCands = buildHyphenCandidates(original);

    // 2) Apply keep-hyphens.txt decisions locally (case-insensitive)
    const keepList = loadKeepHyphenList();
    const localKeep = [];
    const llmCands = [];
    for (const c of hyphenCands) {
      const compound = (c.leftWord + "-" + c.rightToken).toLowerCase();
      if (c.rightToken && keepList.has(compound)) {
        // Keep hyphen and remove break: span replacement is "-"
        localKeep.push({
          id: c.id,
          start: c.span.start,
          end: c.span.end,
          replacement: "-",
          decision: "KEEP_HYPHEN_JOIN",
          confidence: 1.0,
          rationale_short: "rule",
        });
      } else {
        llmCands.push(c);
      }
    }

    // 3) Apply local keep patches first
    let working = original;
    if (localKeep.length) {
      localKeep.sort((a, b) => a.start - b.start);
      let offset = 0;
      for (const p of localKeep) {
        const s = p.start + offset,
          e = p.end + offset;
        working = working.slice(0, s) + p.replacement + working.slice(e);
        offset += p.replacement.length - (e - s);
      }
    }

    // 4) Send remaining candidates to LLM (if any), batched
    let appliedAll = [...localKeep];
    let flagged = [];
    if (llmCands.length) {
      // Re-map spans for working text? Spans still valid because local patches did not
      // modify candidate indices for llmCands (they were chosen from the original list).
      // To be safe, rebuild candidates on current 'working' limited to these ids.
      const currentCands = buildHyphenCandidates(working).filter((nc) =>
        llmCands.some((c) => c.id === nc.id),
      );

      const batches = [];
      for (let i = 0; i < currentCands.length; i += MAX_CANDIDATES_PER_CALL) {
        batches.push(currentCands.slice(i, i + MAX_CANDIDATES_PER_CALL));
      }

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const { system, userPayload } = buildPrompt(working, batch);
        const decisions = await callOpenAIChatJSON({
          model: OPENAI_MODEL,
          system,
          userPayload,
        });
        console.error(
          JSON.stringify(
            { batch: i + 1, totalBatches: batches.length, decisions },
            null,
            2,
          ),
        );
        const {
          text: newText,
          applied,
          low,
        } = applyHyphenPatches(working, batch, decisions, CONFIDENCE_THRESHOLD);
        working = newText;
        appliedAll = appliedAll.concat(applied);
        flagged = flagged.concat(low);
      }
    }

    // 5) Default join of remaining single linebreaks
    const finalText = joinSoftLinebreaksDefault(working);

    // 6) Audit
    console.error(
      JSON.stringify(
        {
          summary: {
            hyphen_candidates_total: hyphenCands.length,
            applied_keep_rules: localKeep.length,
            applied_model_patches: appliedAll.length - localKeep.length,
            flagged_low_confidence: flagged.length,
            default_join_with_space_applied: finalText !== working,
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
