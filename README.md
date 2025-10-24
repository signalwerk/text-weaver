# Text-Weaver

Rejoins wrapped lines and fixes hyphen-splits with a LLM.

## What it does

- **Unwraps line breaks** while **preserving paragraphs** (`\n\n` stay intact).
- **Automatically joins single line breaks** (not paragraphs) with a single space **when the line doesn’t end with a hyphen**.
- **Asks the LLM only about hyphen-at-line-end splits** (e.g., `compe-\n tence`), never about normal line breaks.
- **Leaves uncertain hyphen cases untouched** if confidence is low and **flags them for review**.
- **Respects a configurable “keep-hyphen” list** for true compounds (e.g., `peer-to-peer`, `e-mail`).

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
How do we ensure
that the chosen
methods align with compe-
tence and the
expertise of co-
workers?
```

**Output**

```
How do we ensure that the chosen methods align with competence and the expertise of co-workers?
```

- `compe-\n tence` → **UNHYPHENATE** → `competence`
- `co-\n workers` → **UNHYPHENATE** → `coworkers` (if the model deems it a single word)
- If the model instead detects a true compound, it would return **KEEP_HYPHEN_JOIN** (e.g., `peer-to-\n peer` → `peer-to-peer`).
- All other single line breaks were joined with a space.

## Why it’s safe

- **Minimal scope:** the model only labels hyphen splits; everything else is rule-based.
- **Deterministic edits:** changes are applied as small, position-based patches.
- **Auditable:** includes a concise JSON audit and low-confidence flags.
- **Structure preserved:** paragraph breaks remain untouched.

## You can configure

- **Confidence threshold** (default **0.7**).
- **Keep-hyphen list** of known compounds.
- **Languages:** optimized for English and German.
