#!/usr/bin/env node
/**
 * CLI for text-weaver (the library lives in ./index.js).
 *
 * Usage:
 *   textweaver input.txt --output output.txt
 *   textweaver --no-llm input.txt -o output.txt  # Skip LLM, use rules only
 *   # or pipe (legacy, but may include debug output from libraries):
 *   textweaver input.txt > output.txt
 *   cat input.txt | textweaver > output.txt
 *
 * Flags:
 *   --no-llm           Skip LLM processing; only apply keep-hyphen rules
 *   --output, -o FILE  Write output to FILE instead of stdout
 *   --debug            Write LLM requests/responses to .debug/ folder
 *   --temperature N    Send this temperature to the model (default: not sent)
 *   --reasoning-effort LEVEL  Send this reasoning effort, e.g. low (default: not sent)
 *
 * Env (.env supported):
 *   OPENAI_API_KEY=sk-...   (required unless --no-llm is used)
 *   OPENAI_MODEL=gpt-4o-mini
 *   MAX_CANDIDATES_PER_CALL=20
 *   CONFIDENCE_THRESHOLD=0.7
 *   WORD_CONTEXT_BEFORE=6
 *   WORD_CONTEXT_AFTER=6
 *
 * A keep-hyphens.txt in the working directory replaces the built-in list.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  unwrapText,
  defaultOptions,
  defaultKeepHyphens,
  parseKeepHyphenList,
} from "./index.js";

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

// Find temperature (--temperature <number>), not sent to the model by default
let temperature;
const temperatureFlagIndex = args.indexOf("--temperature");
if (temperatureFlagIndex !== -1) {
  temperature = Number(args[temperatureFlagIndex + 1]);
  if (!Number.isFinite(temperature)) {
    console.error("ERROR: --temperature needs a number, e.g. --temperature 0");
    process.exit(1);
  }
}

// Find reasoning effort (--reasoning-effort <level>), not sent by default
const reasoningFlagIndex = args.indexOf("--reasoning-effort");
let reasoningEffort;
if (reasoningFlagIndex !== -1) {
  reasoningEffort = args[reasoningFlagIndex + 1];
  if (!reasoningEffort || reasoningEffort.startsWith("-")) {
    console.error("ERROR: --reasoning-effort needs a level, e.g. --reasoning-effort low");
    process.exit(1);
  }
}

// Find input file (non-flag argument that isn't the output path or a flag value)
const inputPath =
  args.find(
    (arg, idx) =>
      !arg.startsWith("--") &&
      !arg.startsWith("-") &&
      arg !== outputPath &&
      args[idx - 1] !== "--output" &&
      args[idx - 1] !== "-o" &&
      args[idx - 1] !== "--temperature" &&
      args[idx - 1] !== "--reasoning-effort",
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
const OPENAI_MODEL = process.env.OPENAI_MODEL || defaultOptions.model;
const KEEP_HYPHENS_PATH = path.resolve(process.cwd(), "keep-hyphens.txt");

const envNumber = (name, fallback) =>
  process.env[name] ? Number(process.env[name]) : fallback;

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

function loadKeepHyphenList() {
  try {
    if (!fs.existsSync(KEEP_HYPHENS_PATH)) return defaultKeepHyphens;
    return parseKeepHyphenList(fs.readFileSync(KEEP_HYPHENS_PATH, "utf8"));
  } catch {
    return defaultKeepHyphens;
  }
}

function printReport({ summary, flagged, warnings, tokenUsage }) {
  // Log warnings after all patches applied
  if (warnings.length > 0) {
    console.error(`\n⚠️  Patch Application Warnings:`);
    for (const w of warnings) {
      console.error(`  - [${w.type}] ${w.message}`);
    }
  }

  console.error(
    JSON.stringify(
      {
        summary,
        flagged,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      null,
      2,
    ),
  );

  // Display token summary in a friendly format
  if (tokenUsage) {
    console.error("\n" + "=".repeat(60));
    console.error("📊 TOKEN USAGE & COST SUMMARY");
    console.error("=".repeat(60));
    console.error(`Model:              ${tokenUsage.model}`);
    console.error(`API Requests:       ${tokenUsage.requests}`);
    console.error(
      `Prompt Tokens:      ${tokenUsage.prompt_tokens.toLocaleString()}`,
    );
    console.error(
      `Completion Tokens:  ${tokenUsage.completion_tokens.toLocaleString()}`,
    );
    console.error(
      `Total Tokens:       ${tokenUsage.total_tokens.toLocaleString()}`,
    );
    console.error(
      `Estimated Cost:     $${tokenUsage.estimated_cost_usd.toFixed(6)} USD`,
    );
    console.error("=".repeat(60) + "\n");
  }

  // Display warnings summary if any
  if (warnings.length > 0) {
    console.error("\n" + "=".repeat(60));
    console.error("⚠️  WARNINGS SUMMARY");
    console.error("=".repeat(60));
    const warningsByType = {};
    for (const w of warnings) {
      warningsByType[w.type] = warningsByType[w.type] || [];
      warningsByType[w.type].push(w);
    }
    for (const [type, list] of Object.entries(warningsByType)) {
      console.error(`\n${type.toUpperCase().replace(/_/g, " ")} (${list.length}):`);
      for (const w of list.slice(0, 5)) { // Show first 5 of each type
        console.error(`  • ${w.id}: ${w.message}`);
      }
      if (list.length > 5) {
        console.error(`  ... and ${list.length - 5} more`);
      }
    }
    console.error("=".repeat(60) + "\n");
  }
}

// ---------- Main ----------
(async function main() {
  try {
    const original = await readAllText(inputPath);

    let requestFiles = 0;
    const result = await unwrapText(original, {
      llm: !NO_LLM,
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
      temperature,
      reasoningEffort,
      maxCandidatesPerCall: envNumber(
        "MAX_CANDIDATES_PER_CALL",
        defaultOptions.maxCandidatesPerCall,
      ),
      confidenceThreshold: envNumber(
        "CONFIDENCE_THRESHOLD",
        defaultOptions.confidenceThreshold,
      ),
      wordContextBefore: envNumber(
        "WORD_CONTEXT_BEFORE",
        defaultOptions.wordContextBefore,
      ),
      wordContextAfter: envNumber(
        "WORD_CONTEXT_AFTER",
        defaultOptions.wordContextAfter,
      ),
      keepHyphens: loadKeepHyphenList(),
      onLog: (message) => console.error(message),
      // Write debug request files (in both LLM and no-LLM modes)
      onRequest: DEBUG
        ? ({ batchNumber, payload, sent }) => {
            const suffix = sent ? "" : "_noLLM";
            const requestFile = path.join(
              DEBUG_DIR,
              `request_batch_${batchNumber}${suffix}.json`,
            );
            fs.writeFileSync(
              requestFile,
              JSON.stringify(payload, null, 2),
              "utf8",
            );
            requestFiles++;
          }
        : undefined,
      onResponse: DEBUG
        ? ({ batchNumber, data }) => {
            const responseFile = path.join(
              DEBUG_DIR,
              `response_batch_${batchNumber}.json`,
            );
            fs.writeFileSync(responseFile, JSON.stringify(data, null, 2), "utf8");
          }
        : undefined,
      onDecisions: ({ batchNumber, totalBatches, decisions }) =>
        console.error(
          JSON.stringify(
            { batch: batchNumber, totalBatches, decisions },
            null,
            2,
          ),
        ),
    });

    // Log debug file creation in NO_LLM mode
    if (NO_LLM && DEBUG && requestFiles) {
      console.error(
        `✓ Debug: Wrote ${requestFiles} request file(s) to ${DEBUG_DIR}/`,
      );
    }

    printReport(result);

    // Write output to file or stdout
    if (outputPath) {
      fs.writeFileSync(outputPath, result.text, "utf8");
      console.error(`✓ Output written to: ${outputPath}`);
    } else {
      process.stdout.write(result.text);
    }
  } catch (err) {
    console.error("ERROR:", err?.message || String(err));
    process.exit(1);
  }
})();
