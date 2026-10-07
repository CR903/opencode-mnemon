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
#
# Precedence: MNEMON_PLUGIN_PATH, then $1, then the live deployment slot. With no
# deployment present (fresh clone, CI) fall back to the repo copy rather than
# failing -- "nothing to test" should not be a hard error when there is a file
# right here. Set MNEMON_REQUIRE_DEPLOYMENT=1 to opt out of the fallback.
set -e

DEPLOY="${HOME}/.config/opencode/plugins/mnemon.js"
REPO="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/mnemon.js"

SRC="${MNEMON_PLUGIN_PATH:-${1:-}}"
if [ -z "$SRC" ]; then
	if [ -f "$DEPLOY" ]; then
		SRC="$DEPLOY"
	elif [ "${MNEMON_REQUIRE_DEPLOYMENT:-0}" = "1" ]; then
		echo "no deployment at $DEPLOY and MNEMON_REQUIRE_DEPLOYMENT=1" >&2
		exit 1
	else
		SRC="$REPO"
	fi
fi

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
