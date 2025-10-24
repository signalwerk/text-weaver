#!/bin/bash


rm -rf .debug

# Run without LLM (fast, rule-based only)
node src/index.js --debug --no-llm ./tests/test.md --output ./tests/output_llm_false.txt

# Run with LLM (requires OPENAI_API_KEY)
# node src/index.js --debug  ./tests/test.md --output ./tests/output_llm_true.txt

# Run with debug mode (writes request/response to .debug/)
# node src/index.js --debug ./tests/test.md --output ./tests/output_llm_true.txt

# Run with debug in no-llm mode (shows what would be sent to LLM)
# node src/index.js --no-llm --debug ./tests/test.md --output ./tests/output_llm_false.txt