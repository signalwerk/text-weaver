/**
 * Hyphen-split fixer with optional LLM classification.
 *
 * - Only hyphen-at-line-end splits are sent to the LLM.
 * - Single non-paragraph linebreaks are joined with a single space by default.
 * - Word-based context windows (configurable).
 * - keepHyphens = rule list to always KEEP hyphen and join (skip LLM).
 *
 * This module has no Node.js dependencies and runs in the browser as well.
 * The CLI lives in ./cli.js.
 *
 * Usage:
 *   import { unwrapText } from "text-weaver";
 *   const { text, summary } = await unwrapText(input, { apiKey: "sk-..." });
 *   const { text } = await unwrapText(input, { llm: false }); // rules only
 */

import { defaultKeepHyphens } from "./keep-hyphens.js";

export { defaultKeepHyphens };

export const defaultOptions = {
  llm: true,
  model: "gpt-4o-mini",
  temperature: undefined, // not sent unless set
  reasoningEffort: undefined, // not sent unless set
  maxCandidatesPerCall: 20,
  confidenceThreshold: 0.7,
  wordContextBefore: 6,
  wordContextAfter: 6,
};

// Trim each line; ignore blank or comment lines
export function parseKeepHyphenList(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
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

// Extract full compound going backwards from position (before the separator)
// e.g., for "state-of-the-" at position of final hyphen, returns "state-of-the"
// e.g., for "A/" at position of slash, returns "A"
function leftCompoundToken(text, pos) {
  // Look backwards to capture: word-word-word or word/word pattern
  let i = pos - 1;
  let compound = "";

  // Go backwards collecting letters, hyphens, and slashes
  while (i >= 0) {
    const ch = text[i];
    if (/\p{L}/u.test(ch) || ch === "-" || ch === "/") {
      compound = ch + compound;
      i--;
    } else {
      break;
    }
  }

  // Remove trailing separator if present
  return compound.replace(/[-\/]$/, "");
}

// ---------- Candidate detection (hyphen/slash + newline) ----------
/**
 * Detect split candidates of the form:
 *   <letters>- [spaces] \n [spaces] <non-space>  (hyphen split)
 *   <letters>/ [spaces] \n [spaces] <non-space>  (slash split)
 *
 * Span covers "[-/]<spaces>\n<spaces>" up to just before the first non-space char.
 * Leading/trailing spaces on either line won't break detection.
 */
export function buildHyphenCandidates(
  text,
  {
    wordContextBefore: contextBefore = defaultOptions.wordContextBefore,
    wordContextAfter: contextAfter = defaultOptions.wordContextAfter,
  } = {},
) {
  const cands = [];
  // Match both hyphen and slash at end of line
  const re = /(\p{L}+)([-\/])[ \t]*\n[ \t]*([^\s])/gu;

  for (const match of text.matchAll(re)) {
    const full = match[0];
    const leftWord = match[1];
    const separator = match[2]; // "-" or "/"
    const idx = match.index;

    // Compute span: start at separator, end right before first non-space char after newline
    const afterLeft = full.slice(leftWord.length); // starts with '-' or '/'
    const m2 = afterLeft.match(/^[-\/]\s*\n\s*/);
    if (!m2) continue;
    const separatorBlockLen = m2[0].length;

    const spanStart = idx + leftWord.length;
    const spanEnd = spanStart + separatorBlockLen;

    // Right token (first word after the split)
    const rightToken = rightWordToken(text, spanEnd);

    // Extract full left compound (including any existing hyphens/slashes)
    // e.g., "state-of-the" for "state-of-the-\nart" or "A" for "A/\nB"
    const leftCompound = leftCompoundToken(text, spanStart);

    // Determine if this is a special case that should auto-keep the separator
    let autoKeep = false;
    let autoReason = "";

    // Rule 1: Slash at end of line → always keep (e.g., A/B-Testing)
    if (separator === "/") {
      autoKeep = true;
      autoReason = "slash";
    }

    // Rule 2: Hyphen followed by uppercase letter → likely compound (e.g., Time-Series)
    if (separator === "-" && rightToken && /^\p{Lu}/u.test(rightToken)) {
      autoKeep = true;
      autoReason = "hyphen-uppercase";
    }

    // Word-based context windows
    // Left context: words before the compound, then the compound with separator
    const beforeCompound = wordContextBefore(text, idx - (leftCompound.length - leftWord.length), contextBefore);
    const left_context = (beforeCompound ? beforeCompound + " " : "") + leftCompound + separator;

    // Right context: right token, then words after it
    const afterRight = wordContextAfter(
      text,
      spanEnd + rightToken.length,
      contextAfter,
    );
    const right_context = rightToken + (afterRight ? " " + afterRight : "");

    cands.push({
      id: `h_${cands.length + 1}`,
      type: separator === "/" ? "SLASH_SPLIT" : "HYPHEN_SPLIT",
      span: { start: spanStart, end: spanEnd },
      leftWord,
      leftCompound, // Full compound for keep-hyphens matching
      rightToken,
      separator,
      autoKeep,
      autoReason,
      fragments: {
        start: leftCompound + separator,
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
export function sanitizeAndParseLLMResponse(content) {
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

// Pricing per 1M tokens (as of 2025)
const PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
};

export function calculateCost(model, promptTokens, completionTokens) {
  const pricing = PRICING[model] || PRICING["gpt-4o-mini"];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

// temperature and reasoning effort are only sent when set, since not every
// model supports them (e.g. reasoning models only accept the default temperature)
function buildRequestPayload({
  model,
  temperature,
  reasoningEffort,
  system,
  userContent,
}) {
  return {
    model,
    ...(temperature != null && { temperature }),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };
}

async function callOpenAIChatJSON({
  fetchFn,
  apiKey,
  model,
  temperature,
  reasoningEffort,
  system,
  userPayload,
  batchNumber,
  tokenStats,
  onResponse,
}) {
  const requestPayload = buildRequestPayload({
    model,
    temperature,
    reasoningEffort,
    system,
    userContent: JSON.stringify(userPayload),
  });

  const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

  onResponse?.({ batchNumber, data });

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

  // Sort patches by position (start) in ascending order for overlap detection
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

  // Sort patches in REVERSE order (end to start)
  // This way, applying patches doesn't affect positions of earlier patches
  nonOverlapping.sort((a, b) => b.start - a.start);

  let text = original;
  const applied = [];
  const failedSanity = [];

  // Apply patches from end to start - no offset tracking needed!
  for (const p of nonOverlapping) {
    const slice = text.slice(p.start, p.end);

    // Sanity check: expect newline within slice
    if (!slice.includes("\n")) {
      failedSanity.push(p.id);
      warnings.push({
        type: "sanity_check_failed",
        id: p.id,
        slice_preview: JSON.stringify(slice.substring(0, 50)),
        span: `${p.start}-${p.end}`,
        message: `Sanity check failed for ${p.id}: no newline in span [${p.start}:${p.end}]`,
      });
      continue;
    }

    // Apply patch: replace span with replacement
    text = text.slice(0, p.start) + p.replacement + text.slice(p.end);
    applied.push(p);
  }

  // Sort applied patches back to original order for reporting
  applied.sort((a, b) => a.start - b.start);

  return { text, applied, low, warnings, missingResponses, overlapping, failedSanity };
}

/**
 * Join remaining single linebreaks with a single space (paragraphs preserved).
 * - Handles stray spaces around the newline.
 * - Does NOT join when the char immediately before newline is a hyphen or slash (left for review).
 */
export function joinSoftLinebreaksDefault(text) {
  return text.replace(/([^\n])[\t ]*\n(?!\n)[\t ]*/g, (m, prev) => {
    if (prev === "-" || prev === "/") return m; // keep as-is after hyphen or slash
    return prev + " ";
  });
}

// ---------- Main ----------
/**
 * Unwrap `original`: fix hyphen/slash splits and join soft linebreaks.
 *
 * Options (see defaultOptions):
 *   llm                  false = rules only, no API key required
 *   apiKey               OpenAI API key (required when llm is true)
 *   temperature          sent to the model only when set (number)
 *   reasoningEffort      sent as reasoning_effort only when set (e.g. "low")
 *   model, maxCandidatesPerCall, confidenceThreshold,
 *   wordContextBefore, wordContextAfter
 *   keepHyphens          compounds to always keep (case-insensitive)
 *   fetch                fetch implementation (default: globalThis.fetch)
 *   onRequest({ batchNumber, totalBatches, payload, sent })
 *                        called for every batch, also when llm is false
 *   onResponse({ batchNumber, data })    raw OpenAI response
 *   onDecisions({ batchNumber, totalBatches, decisions })
 *   onLog(message)       progress / diagnostic messages
 *
 * Returns { text, summary, flagged, warnings, tokenUsage }.
 */
export async function unwrapText(original, options = {}) {
  const {
    llm,
    apiKey,
    model,
    temperature,
    reasoningEffort,
    maxCandidatesPerCall,
    confidenceThreshold,
    wordContextBefore,
    wordContextAfter,
  } = { ...defaultOptions, ...options };
  const keepHyphens = options.keepHyphens ?? defaultKeepHyphens;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { onRequest, onResponse, onDecisions } = options;
  const log = options.onLog ?? (() => {});

  if (llm && !apiKey) {
    throw new Error("Missing OpenAI API key (or use llm: false).");
  }

  const contextOptions = { wordContextBefore, wordContextAfter };
  const tokenStats = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    requests: 0,
  };

  // 1) Detect hyphen candidates
  const hyphenCands = buildHyphenCandidates(original, contextOptions);

  // 2) Apply algorithmic rules and keep-hyphens decisions locally
  const keepList = new Set(keepHyphens.map((s) => s.toLowerCase()));
  const localKeep = [];
  const llmCands = [];
  for (const c of hyphenCands) {
    let shouldKeep = false;
    let reason = "";

    // Check algorithmic rules first (slash, hyphen+uppercase)
    if (c.autoKeep) {
      shouldKeep = true;
      reason = c.autoReason;
    }

    // Check keep-hyphens list (only for hyphen splits)
    if (!shouldKeep && c.separator === "-") {
      const compound = (c.leftCompound + "-" + c.rightToken).toLowerCase();
      if (c.rightToken && keepList.has(compound)) {
        shouldKeep = true;
        reason = "keep-list";
      }
    }

    if (shouldKeep) {
      // Keep separator and remove break
      localKeep.push({
        id: c.id,
        start: c.span.start,
        end: c.span.end,
        replacement: c.separator,
        decision: "KEEP_SEPARATOR",
        confidence: 1.0,
        reason: reason,
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

  // 4) Send remaining candidates to LLM (if any), batched.
  //    Without LLM the requests are still built when someone listens (debug).
  let appliedAll = [...localKeep];
  let flagged = [];
  let allWarnings = [];

  if ((llm || onRequest) && llmCands.length) {
    // Rebuild candidates on current 'working' text to get accurate spans
    const currentCands = buildHyphenCandidates(working, contextOptions);

    if (currentCands.length === 0) {
      log("Warning: No candidates found after applying keep-rules. Skipping LLM.");
    } else {
      const batches = [];
      for (let i = 0; i < currentCands.length; i += maxCandidatesPerCall) {
        batches.push(currentCands.slice(i, i + maxCandidatesPerCall));
      }

      // Collect ALL decisions from ALL batches first
      const allDecisions = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const { system, userPayload } = buildPrompt(working, batch);

        onRequest?.({
          batchNumber: i + 1,
          totalBatches: batches.length,
          sent: llm,
          payload: buildRequestPayload({
            model,
            temperature,
            reasoningEffort,
            system,
            userContent: userPayload,
          }),
        });

        // Only call API in LLM mode
        if (llm) {
          const decisions = await callOpenAIChatJSON({
            fetchFn,
            apiKey,
            model,
            temperature,
            reasoningEffort,
            system,
            userPayload,
            batchNumber: i + 1,
            tokenStats,
            onResponse,
          });
          onDecisions?.({
            batchNumber: i + 1,
            totalBatches: batches.length,
            decisions,
          });
          allDecisions.push(...decisions);
        }
      }

      // Apply ALL patches at once from the original working text
      // This ensures spans remain valid since we work from end to start
      if (llm && allDecisions.length > 0) {
        const { text: newText, applied, low, warnings } = applyHyphenPatches(
          working,
          currentCands,
          allDecisions,
          confidenceThreshold,
        );
        working = newText;
        appliedAll = appliedAll.concat(applied);
        flagged = flagged.concat(low);
        allWarnings = allWarnings.concat(warnings);
      }
    }
  }

  // 5) Default join of remaining single linebreaks
  const finalText = joinSoftLinebreaksDefault(working);

  // 6) Audit with token stats
  // Break down local keep rules by reason
  const keepReasons = {};
  for (const k of localKeep) {
    keepReasons[k.reason] = (keepReasons[k.reason] || 0) + 1;
  }

  const summary = {
    mode: llm ? "llm" : "no-llm",
    hyphen_candidates_total: hyphenCands.length,
    applied_keep_rules: localKeep.length,
    keep_rules_breakdown: keepReasons,
    applied_model_patches: appliedAll.length - localKeep.length,
    flagged_low_confidence: flagged.length,
    default_join_with_space_applied: finalText !== working,
    skipped_llm_candidates: llm ? 0 : llmCands.length,
  };

  let tokenUsage;
  if (llm && tokenStats.requests > 0) {
    const totalCost = calculateCost(
      model,
      tokenStats.prompt_tokens,
      tokenStats.completion_tokens,
    );
    tokenUsage = {
      ...tokenStats,
      model,
      estimated_cost_usd: parseFloat(totalCost.toFixed(6)),
    };
    summary.token_usage = tokenUsage;
  }

  // Add warnings summary
  if (allWarnings.length > 0) {
    const warningsByType = {};
    for (const w of allWarnings) {
      warningsByType[w.type] = (warningsByType[w.type] || 0) + 1;
    }
    summary.warnings = warningsByType;
  }

  return {
    text: finalText,
    summary,
    flagged,
    warnings: allWarnings,
    tokenUsage,
  };
}
