# Text-Weaver

Rejoins wrapped lines and fixes hyphen-splits with a LLM (or without it).

## What it does

- **Unwraps line breaks** while **preserving paragraphs** (`\n\n` stay intact).
- **Automatically joins single line breaks** (not paragraphs) with a single space **when the line doesn't end with a hyphen**.
- **Asks the LLM only about hyphen-at-line-end splits** (e.g., `compe-\n tence`), never about normal line breaks.
- **Leaves uncertain hyphen cases untouched** if confidence is low and **flags them for review**.
- **Respects a configurable "keep-hyphen" list** for true compounds (e.g., `peer-to-peer`, `e-mail`).
- **Can run without LLM** using the `--no-llm` flag to apply only rule-based fixes.

## How decisions are made (LLM policy)

Only candidates where a line ends with a hyphen and the next line continues the word are sent to the model.
For each such candidate, the model chooses exactly one:

1. **UNHYPHENATE**
   Remove the hyphen + newline and merge fragments into a single word.
   _Example:_ `compe-\n tence` → `competence`

2. **KEEP_HYPHEN_JOIN**
   Keep the real hyphen compound and remove only the newline.
   _Example:_ `peer-to-\n peer` → `peer-to-peer`

If the model’s **confidence < 0.7**, no change is applied to that spot and it’s **flagged for review**.

## Example

**Input**

```
This document tests vari-
ous hyphenation scenar-
ios.

The system uses state-of-the-
art Machine-Learning.
```

**Output**

```
This document tests various hyphenation scenarios.

The system uses state-of-the-art Machine-Learning.
```

**What happened:**

- `vari-\nous` → **UNHYPHENATE** (LLM decision) → `various`
- `scenar-\nios` → **UNHYPHENATE** (LLM decision) → `scenarios`
- `state-of-the-\nart` → **KEEP_HYPHEN_JOIN** (from the keep-hyphen list) → `state-of-the-art`
- All other single line breaks were joined with a space.

## Principles

- **Minimal scope:** the model only labels hyphen splits; everything else is rule-based.
- **Deterministic edits:** changes are applied as small, position-based patches.
- **Structure preserved:** paragraph breaks remain untouched.

## Installation

The package is not published to npm. Install it directly from GitHub:

```bash
npm install github:signalwerk/text-weaver
# or pin a tag / commit
npm install github:signalwerk/text-weaver#v1.4.0
```

## Library usage

`src/index.js` has no Node.js dependencies and runs in the browser (e.g. bundled with Vite) as well as in Node 18+.

```js
import { unwrapText } from "text-weaver";

// With LLM
const { text, summary, flagged, warnings, tokenUsage } = await unwrapText(input, {
  apiKey: "sk-...",
});

// Without LLM (rule-based only)
const { text } = await unwrapText(input, { llm: false });
```

Options (all optional except `apiKey` when `llm` is true):

| Option                 | Default                | Description                                        |
| ---------------------- | ---------------------- | -------------------------------------------------- |
| `llm`                  | `true`                 | `false` applies only the rules, no API key needed  |
| `apiKey`               |                        | OpenAI API key                                     |
| `model`                | `gpt-4o-mini`          | Chat-completions model                             |
| `temperature`          | not sent               | Sent to the model only when set                    |
| `reasoningEffort`      | not sent               | Sent as `reasoning_effort` only when set           |
| `confidenceThreshold`  | `0.7`                  | Minimum confidence for applying changes            |
| `maxCandidatesPerCall` | `20`                   | Batch size for API calls                           |
| `wordContextBefore`    | `6`                    | Context words before hyphen                        |
| `wordContextAfter`     | `6`                    | Context words after hyphen                         |
| `keepHyphens`          | `defaultKeepHyphens`   | Compounds to always keep (case-insensitive)        |
| `fetch`                | `globalThis.fetch`     | Custom fetch implementation                        |
| `onRequest`            |                        | Called with each batch request payload             |
| `onResponse`           |                        | Called with each raw OpenAI response               |
| `onDecisions`          |                        | Called with the decisions of each batch            |
| `onLog`                |                        | Called with diagnostic messages                    |

Also exported: `defaultOptions`, `defaultKeepHyphens`, `parseKeepHyphenList`, `buildHyphenCandidates`, `joinSoftLinebreaksDefault`, `sanitizeAndParseLLMResponse`, `calculateCost`.

## CLI usage

```bash
# when installed: npx textweaver ... (same flags)

# With LLM (requires OPENAI_API_KEY)
node src/cli.js input.txt --output output.txt
node src/cli.js input.txt -o output.txt

# Without LLM (only applies keep-hyphen rules and joins line breaks)
node src/cli.js --no-llm input.txt -o output.txt

# With a fixed temperature (default: not sent)
node src/cli.js --temperature 0 input.txt -o output.txt

# With debug mode (writes LLM requests/responses to .debug/ folder)
node src/cli.js --debug input.txt -o output.txt
node src/cli.js --no-llm --debug input.txt -o output.txt

# Pipe to stdout (legacy, may include library debug messages)
node src/cli.js input.txt > output.txt
cat input.txt | node src/cli.js > output.txt
```

## Configuration

### Command-line Flags

- **`--no-llm`:** Skip LLM processing entirely (no API key required)
- **`--output FILE` or `-o FILE`:** Write to file directly (avoids library debug output in stdout)
- **`--debug`:** Write LLM requests/responses to `.debug/` folder for inspection
- **`--reasoning-effort LEVEL`:** Send this reasoning effort (e.g. `low`, `high`) to the model. Not sent by default; only reasoning models accept it
- **`--temperature N`:** Send this temperature to the model. By default no temperature is sent, so the model's default applies (some models, e.g. reasoning models, only accept their default)

### Environment Variables

- **`OPENAI_API_KEY`:** Your OpenAI API key (required unless `--no-llm` is used)
- **`OPENAI_MODEL`:** Model to use (default: `gpt-4o-mini`)
- **`CONFIDENCE_THRESHOLD`:** Minimum confidence for applying changes (default: `0.7`)
- **`MAX_CANDIDATES_PER_CALL`:** Batch size for API calls (default: `20`)
- **`WORD_CONTEXT_BEFORE`:** Context words before hyphen (default: `6`)
- **`WORD_CONTEXT_AFTER`:** Context words after hyphen (default: `6`)

### Files

- **`src/keep-hyphens.js`:** Built-in list of compound words to always preserve (case-insensitive)
- **`keep-hyphens.txt`** (optional, in the working directory): replaces the built-in list for the CLI (one per line, `#` for comments)

### Token Tracking & Cost

When using LLM mode, the tool automatically tracks:

- Prompt tokens
- Completion tokens
- Total tokens
- Number of API requests
- **Estimated cost in USD** based on current OpenAI pricing

The cost summary is displayed at the end of processing.
