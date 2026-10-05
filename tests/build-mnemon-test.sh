#!/bin/sh
# Rebuild a test copy of the mnemon plugin with the internals exported, so the
# production file stays in its clean { id, setup, server } shape.
#
# Usage:
#   ./build-mnemon-test.sh                     # test the live deployment (default)
#   ./build-mnemon-test.sh ../mnemon.js        # test the repo copy
#   MNEMON_PLUGIN_PATH=... ./build-mnemon-test.sh
#
# The test suites import /tmp/mnemon-test-plugin.mjs, so rebuild after every edit
# to whichever file you intend to verify.
set -e

SRC="${MNEMON_PLUGIN_PATH:-${1:-$HOME/.config/opencode/plugins/mnemon.js}}"
DST="${MNEMON_TEST_DST:-/tmp/mnemon-test-plugin.mjs}"

if [ ! -f "$SRC" ]; then
  echo "source not found: $SRC" >&2
  exit 1
fi

cp "$SRC" "$DST"
cat >> "$DST" <<'EOF'
export { claimRememberable, classifyMemory, clipText, extractEntities, extractMemory, fenceRatio, headlineOf, LLM_ENABLE_FLAG, LLM_MODEL_CHAIN, llmExtractMemory, llmWorthyEntry, buildLlmPrompt, parseLlmReply, llmExtractConfig, hooksDisabled, mnemonCommand, modelRefFromName, pickModelRef, markRemembered, sweepAndRemember, setLlmGenerate, setLlmCatalog, withTimeoutMs }
EOF
echo "test copy rebuilt: $DST <- $SRC ($(wc -l < "$DST") lines)"
