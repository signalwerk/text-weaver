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
 *   node src/index.js input.txt --output output.txt
 *   node src/index.js --no-llm input.txt -o output.txt  # Skip LLM, use rules only
 *   # or pipe (legacy, but may include debug output from libraries):
 *   node src/index.js input.txt > output.txt
 *   cat input.txt | node src/index.js > output.txt
 *
 * Flags:
 *   --no-llm           Skip LLM processing; only apply keep-hyphens.txt rules
 *   --output, -o FILE  Write output to FILE instead of stdout
 *   --debug            Write LLM requests/responses to .debug/ folder
 *
 * Env (.env supported):
 *   OPENAI_API_KEY=sk-...   (required unless --no-llm is used)
 *   OPENAI_MODEL=gpt-4o-mini
 *   MAX_CANDIDATES_PER_CALL=20
 *   CONFIDENCE_THRESHOLD=0.7
 *   WORD_CONTEXT_BEFORE=6
 *   WORD_CONTEXT_AFTER=6
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

// ---------- Parse CLI arguments ----------
const args = process.argv.slice(2);
const NO_LLM = args.includes("--no-llm");
const DEBUG = args.includes("--debug");

// Find output file (--output <file> or -o <file>)
let outputPath = null;
const outputFlagIndex = args.findIndex(
  (arg) => arg === "--output" || arg === "-o",
);
if (outputFlagIndex !== -1 && args[outputFlagIndex + 1]) {
  outputPath = args[outputFlagIndex + 1];
}

// Find input file (non-flag argument that isn't the output path)
const inputPath =
  args.find(
    (arg, idx) =>
      !arg.startsWith("--") &&
      !arg.startsWith("-") &&
      arg !== outputPath &&
      args[idx - 1] !== "--output" &&
      args[idx - 1] !== "-o",
  ) || null;

// Debug directory
const DEBUG_DIR = path.resolve(process.cwd(), ".debug");
if (DEBUG && !fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

// ---------- Config ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!NO_LLM && !OPENAI_API_KEY) {
  console.error("ERROR: Missing OPENAI_API_KEY in environment.");
  console.error("Use --no-llm flag to skip LLM processing.");
  process.exit(1);
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_CANDIDATES_PER_CALL = Number(
  process.env.MAX_CANDIDATES_PER_CALL || 20,
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

// Extract full hyphenated compound going backwards from position (before the hyphen)
// e.g., for "state-of-the-" at position of final hyphen, returns "state-of-the"
function leftCompoundToken(text, pos) {
  // Look backwards to capture: word-word-word pattern
  let i = pos - 1;
  let compound = "";
  
  // Go backwards collecting letters and hyphens
  while (i >= 0) {
    const ch = text[i];
    if (/\p{L}/u.test(ch) || ch === "-") {
      compound = ch + compound;
      i--;
    } else {
      break;
    }
  }
  
  // Remove trailing hyphen if present
  return compound.replace(/-$/, "");
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

    // Right token (first word after the split)
    const rightToken = rightWordToken(text, spanEnd);
    
    // Extract full left compound (including any existing hyphens)
    // e.g., "state-of-the" for "state-of-the-\nart"
    const leftCompound = leftCompoundToken(text, spanStart);

    // Word-based context windows
    // Left context: words before the compound, then the compound with hyphen
    const beforeCompound = wordContextBefore(text, idx - (leftCompound.length - leftWord.length), WORD_CONTEXT_BEFORE);
    const left_context = (beforeCompound ? beforeCompound + " " : "") + leftCompound + "-";

    // Right context: right token, then words after it
    const afterRight = wordContextAfter(
      text,
      spanEnd + rightToken.length,
      WORD_CONTEXT_AFTER,
    );
    const right_context = rightToken + (afterRight ? " " + afterRight : "");

    cands.push({
      id: `h_${cands.length + 1}`,
      type: "HYPHEN_SPLIT",
      span: { start: spanStart, end: spanEnd },
      leftWord,
      leftCompound, // Full compound for keep-hyphens matching
      rightToken,
      fragments: {
        start: leftCompound + "-",
        end: rightToken,
      },
      left_context,
      right_context,
    });
  }

  cands.sort((a, b) => a.span.start - b.span.start);
  return cands;
}

// ---------- LLM Response Sanitization ----------
/**
 * Sanitize and parse LLM response that may contain:
 * - JSON wrapped in Markdown fences (```json ... ```)
 * - Illegal backslash escapes (\Z → \\Z)
 * - Extra prose before/after the JSON
 * - Malformed JSON structures
 *
 * Returns the parsed object or null if parsing fails.
 */
function sanitizeAndParseLLMResponse(content) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  // Helper to strip fences, find JSON, repair escapes, and parse
  function tryParse(str) {
    // Remove leading ```json (or ```lang) and trailing ```
    const withoutFences = str
      .replace(/^\s*```[^\n]*\n?/i, "") // opening fence
      .replace(/\n?```\s*$/, ""); // closing fence

    // Find the first {...} or [...] block
    const jsonMatch = withoutFences.match(/(\{|\[)[\s\S]*(\}|\])/m);
    if (!jsonMatch) return null;

    let jsonString = jsonMatch[0];

    // Repair illegal backslash escapes (keep valid ones: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX)
    // Match backslash NOT followed by valid escape char or \u followed by 4 hex digits
    jsonString = jsonString.replace(
      /\\(?!(["\\\/bfnrt]|u[0-9a-fA-F]{4}))/g,
      "\\\\",
    );

    // Parse and return null on failure
    try {
      return JSON.parse(jsonString);
    } catch {
      return null;
    }
  }

  // First attempt: parse the whole content
  let data = tryParse(content);

  // Second attempt: if failed, cut everything before the first fence and retry
  if (!data) {
    const fenceIdx = content.indexOf("```");
    if (fenceIdx !== -1) {
      data = tryParse(content.slice(fenceIdx));
    }
  }

  return data;
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
            confidence: { type: "number" },
          },
          required: ["id", "decision", "confidence"],
        },
      },
    },
    required: ["decisions"],
  };

  const system = `You classify ONLY hyphen-at-line-end splits and return strict JSON.
- Languages: German and English.
- Decisions:
  • UNHYPHENATE: the hyphen is a word-split artifact; join fragments (e.g., Kompe-\\ntenzen -> Kompetenzen).
  • KEEP_HYPHEN_JOIN: the hyphen is part of a real compound word; keep it (Peer-to-\\nPeer -> Peer-to-Peer).
- Use high confidence (0.9+) when the choice is clear (e.g., dictionary words, common compounds).
- Use medium confidence (0.7-0.9) when context helps but there's some ambiguity.
- Use low confidence (<0.7) when genuinely uncertain.
- Output MUST be valid JSON per schema; no extra text.`;

  // Minimal few-shot example (assistant shows JSON only)
  const exampleUser = {
    candidates: [
      {
        id: "ex1",
        fragments: { start: "Kompe-", end: "tenzen" },
        left_context: "Methoden den Kompe-",
        right_context: "tenzen und der",
      },
      {
        id: "ex2",
        fragments: { start: "Peer-to-", end: "Peer" },
        left_context: "ist Peer-to-",
        right_context: "Peer kompatibel",
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
        confidence: 0.97,
      },
      {
        id: "ex2",
        decision: "KEEP_HYPHEN_JOIN",
        confidence: 0.98,
      },
    ],
  };

  const userPayload = {
    candidates: candidates.map((c) => ({
      id: c.id,
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

// Token tracking and cost calculation
const tokenStats = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  requests: 0,
};

// Pricing per 1M tokens (as of 2025)
const PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
};

function calculateCost(model, promptTokens, completionTokens) {
  const pricing = PRICING[model] || PRICING["gpt-4o-mini"];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

async function callOpenAIChatJSON({ model, system, userPayload, batchNumber }) {
  const requestPayload = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${txt || res.statusText}`);
  }
  const data = await res.json();

  // Track tokens
  if (data.usage) {
    tokenStats.prompt_tokens += data.usage.prompt_tokens || 0;
    tokenStats.completion_tokens += data.usage.completion_tokens || 0;
    tokenStats.total_tokens += data.usage.total_tokens || 0;
    tokenStats.requests += 1;
  }

  // Write debug response file
  if (DEBUG) {
    const responseFile = path.join(
      DEBUG_DIR,
      `response_batch_${batchNumber}.json`,
    );
    fs.writeFileSync(responseFile, JSON.stringify(data, null, 2), "utf8");
  }

  const content = data?.choices?.[0]?.message?.content || "";

  // Use sanitization to handle malformed responses
  const parsed = sanitizeAndParseLLMResponse(content);

  if (!parsed) {
    throw new Error(
      "Model did not return valid JSON. Content: " + content.substring(0, 200),
    );
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error(
      "JSON missing 'decisions' array. Got keys: " +
        Object.keys(parsed).join(", "),
    );
  }

  // Validate and enhance decisions with automatic replacement
  for (const decision of parsed.decisions) {
    if (!decision.id || typeof decision.id !== "string") {
      throw new Error(
        `Decision missing valid 'id' field: ${JSON.stringify(decision)}`,
      );
    }
    if (
      !decision.decision ||
      !["UNHYPHENATE", "KEEP_HYPHEN_JOIN"].includes(decision.decision)
    ) {
      throw new Error(
        `Decision '${decision.id}' has invalid 'decision' field: ${decision.decision}`,
      );
    }

    // Automatically calculate replacement based on decision
    decision.replacement = decision.decision === "UNHYPHENATE" ? "" : "-";
  }

  return parsed.decisions;
}

// ---------- Patching ----------
function applyHyphenPatches(original, candidates, decisions, threshold) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const patches = [];
  const low = [];
  const warnings = [];

  // Validate all candidates got responses
  const missingResponses = [];
  for (const cand of candidates) {
    const d = byId.get(cand.id);
    if (!d) {
      missingResponses.push(cand.id);
      warnings.push({
        type: "missing_response",
        id: cand.id,
        message: `No LLM response for candidate ${cand.id}`,
      });
    }
  }

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
      });
      warnings.push({
        type: "low_confidence",
        id: d.id,
        decision: d.decision,
        confidence: d.confidence,
        message: `Low confidence (${d.confidence.toFixed(2)}) for ${cand.id}, skipping patch`,
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
      });
    } else {
      warnings.push({
        type: "invalid_decision",
        id: d.id,
        decision: d.decision,
        message: `Invalid decision "${d.decision}" for ${cand.id}`,
      });
    }
  }

  patches.sort((a, b) => a.start - b.start);
  
  // Detect overlapping patches
  const nonOverlapping = [];
  const overlapping = [];
  let lastEnd = -1;
  for (const p of patches) {
    if (p.start >= lastEnd) {
      nonOverlapping.push(p);
      lastEnd = p.end;
    } else {
      overlapping.push(p.id);
      warnings.push({
        type: "overlapping_patch",
        id: p.id,
        message: `Patch ${p.id} overlaps with previous patch, skipping`,
      });
    }
  }

  let text = original;
  let offset = 0;
  const applied = [];
  const failedSanity = [];
  
  for (const p of nonOverlapping) {
    const realStart = p.start + offset;
    const realEnd = p.end + offset;
    const slice = text.slice(realStart, realEnd);
    
    // sanity check: expect newline within slice
    if (!slice.includes("\n")) {
      failedSanity.push(p.id);
      warnings.push({
        type: "sanity_check_failed",
        id: p.id,
        slice_preview: JSON.stringify(slice),
        message: `Sanity check failed for ${p.id}: no newline in span (offset may have shifted)`,
      });
      continue;
    }
    
    text = text.slice(0, realStart) + p.replacement + text.slice(realEnd);
    offset += p.replacement.length - (realEnd - realStart);
    applied.push(p);
  }
  
  return { text, applied, low, warnings, missingResponses, overlapping, failedSanity };
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
    const original = await readAllText(inputPath);

    // 1) Detect hyphen candidates
    const hyphenCands = buildHyphenCandidates(original);

    // 2) Apply keep-hyphens.txt decisions locally (case-insensitive)
    const keepList = loadKeepHyphenList();
    const localKeep = [];
    const llmCands = [];
    for (const c of hyphenCands) {
      // Use full compound (leftCompound includes any existing hyphens)
      const compound = (c.leftCompound + "-" + c.rightToken).toLowerCase();
      if (c.rightToken && keepList.has(compound)) {
        // Keep hyphen and remove break: span replacement is "-"
        localKeep.push({
          id: c.id,
          start: c.span.start,
          end: c.span.end,
          replacement: "-",
          decision: "KEEP_HYPHEN_JOIN",
          confidence: 1.0,
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

    // 4) Send remaining candidates to LLM (if any and if not NO_LLM), batched
    let appliedAll = [...localKeep];
    let flagged = [];
    let allWarnings = [];

    if ((!NO_LLM || DEBUG) && llmCands.length) {
      // Rebuild candidates on current 'working' text to get accurate spans
      const currentCands = buildHyphenCandidates(working);

      if (currentCands.length === 0) {
        console.error(
          "Warning: No candidates found after applying keep-rules. Skipping LLM.",
        );
      } else {
        const batches = [];
        for (let i = 0; i < currentCands.length; i += MAX_CANDIDATES_PER_CALL) {
          batches.push(currentCands.slice(i, i + MAX_CANDIDATES_PER_CALL));
        }

        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          const { system, userPayload } = buildPrompt(working, batch);

          // Write debug request file (in both LLM and no-LLM modes)
          if (DEBUG) {
            const requestPayload = {
              model: OPENAI_MODEL,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: system },
                { role: "user", content: userPayload },
              ],
            };
            const suffix = NO_LLM ? "_noLLM" : "";
            const requestFile = path.join(
              DEBUG_DIR,
              `request_batch_${i + 1}${suffix}.json`,
            );
            fs.writeFileSync(
              requestFile,
              JSON.stringify(requestPayload, null, 2),
              "utf8",
            );
          }

          // Only call API if not in NO_LLM mode
          if (!NO_LLM) {
            const decisions = await callOpenAIChatJSON({
              model: OPENAI_MODEL,
              system,
              userPayload,
              batchNumber: i + 1,
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
              warnings,
              missingResponses,
              overlapping,
              failedSanity,
            } = applyHyphenPatches(
              working,
              batch,
              decisions,
              CONFIDENCE_THRESHOLD,
            );
            working = newText;
            appliedAll = appliedAll.concat(applied);
            flagged = flagged.concat(low);
            allWarnings = allWarnings.concat(warnings);
            
            // Log warnings for this batch
            if (warnings.length > 0) {
              console.error(`\n⚠️  Batch ${i + 1} Warnings:`);
              for (const w of warnings) {
                console.error(`  - [${w.type}] ${w.message}`);
              }
            }
          }
        }

        // Log debug file creation in NO_LLM mode
        if (NO_LLM && DEBUG) {
          console.error(
            `✓ Debug: Wrote ${batches.length} request file(s) to ${DEBUG_DIR}/`,
          );
        }

        // Log skipping in NO_LLM mode (without debug)
        if (NO_LLM && !DEBUG && llmCands.length) {
          console.error(
            `Skipping ${llmCands.length} candidates (--no-llm mode)`,
          );
        }
      }
    }

    // Handle case when NO_LLM is true, DEBUG is false, and we have candidates
    // (didn't enter the above block because (!NO_LLM || DEBUG) was false)
    if (NO_LLM && !DEBUG && llmCands.length) {
      console.error(`Skipping ${llmCands.length} candidates (--no-llm mode)`);
    }

    // 5) Default join of remaining single linebreaks
    const finalText = joinSoftLinebreaksDefault(working);

    // 6) Audit with token stats
    const totalCost = calculateCost(
      OPENAI_MODEL,
      tokenStats.prompt_tokens,
      tokenStats.completion_tokens,
    );

    const summary = {
      mode: NO_LLM ? "no-llm" : "llm",
      hyphen_candidates_total: hyphenCands.length,
      applied_keep_rules: localKeep.length,
      applied_model_patches: appliedAll.length - localKeep.length,
      flagged_low_confidence: flagged.length,
      default_join_with_space_applied: finalText !== working,
      skipped_llm_candidates: NO_LLM ? llmCands.length : 0,
    };

    if (!NO_LLM && tokenStats.requests > 0) {
      summary.token_usage = {
        prompt_tokens: tokenStats.prompt_tokens,
        completion_tokens: tokenStats.completion_tokens,
        total_tokens: tokenStats.total_tokens,
        requests: tokenStats.requests,
        model: OPENAI_MODEL,
        estimated_cost_usd: parseFloat(totalCost.toFixed(6)),
      };
    }

    // Add warnings summary
    if (allWarnings.length > 0) {
      const warningsByType = {};
      for (const w of allWarnings) {
        warningsByType[w.type] = (warningsByType[w.type] || 0) + 1;
      }
      summary.warnings = warningsByType;
    }

    console.error(
      JSON.stringify(
        {
          summary,
          flagged,
          warnings: allWarnings.length > 0 ? allWarnings : undefined,
        },
        null,
        2,
      ),
    );

    // Display token summary in a friendly format
    if (!NO_LLM && tokenStats.requests > 0) {
      console.error("\n" + "=".repeat(60));
      console.error("📊 TOKEN USAGE & COST SUMMARY");
      console.error("=".repeat(60));
      console.error(`Model:              ${OPENAI_MODEL}`);
      console.error(`API Requests:       ${tokenStats.requests}`);
      console.error(
        `Prompt Tokens:      ${tokenStats.prompt_tokens.toLocaleString()}`,
      );
      console.error(
        `Completion Tokens:  ${tokenStats.completion_tokens.toLocaleString()}`,
      );
      console.error(
        `Total Tokens:       ${tokenStats.total_tokens.toLocaleString()}`,
      );
      console.error(`Estimated Cost:     $${totalCost.toFixed(6)} USD`);
      console.error("=".repeat(60) + "\n");
    }
    
    // Display warnings summary if any
    if (allWarnings.length > 0) {
      console.error("\n" + "=".repeat(60));
      console.error("⚠️  WARNINGS SUMMARY");
      console.error("=".repeat(60));
      const warningsByType = {};
      for (const w of allWarnings) {
        warningsByType[w.type] = (warningsByType[w.type] || []);
        warningsByType[w.type].push(w);
      }
      for (const [type, warnings] of Object.entries(warningsByType)) {
        console.error(`\n${type.toUpperCase().replace(/_/g, " ")} (${warnings.length}):`);
        for (const w of warnings.slice(0, 5)) { // Show first 5 of each type
          console.error(`  • ${w.id}: ${w.message}`);
        }
        if (warnings.length > 5) {
          console.error(`  ... and ${warnings.length - 5} more`);
        }
      }
      console.error("=".repeat(60) + "\n");
    }

    // Write output to file or stdout
    if (outputPath) {
      fs.writeFileSync(outputPath, finalText, "utf8");
      console.error(`✓ Output written to: ${outputPath}`);
    } else {
      process.stdout.write(finalText);
    }
  } catch (err) {
    console.error("ERROR:", err?.message || String(err));
    process.exit(1);
  }
})();
