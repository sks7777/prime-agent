#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$LINK_DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
export PRIME_AGENT_LAUNCHER_PATH="$SCRIPT_DIR/prime-agent.sh"
if BUILD_ID="$(git -C "$SCRIPT_DIR" describe --tags --always --dirty 2>/dev/null)"; then
  export PRIME_AGENT_BUILD_ID="$BUILD_ID"
fi
# Content-addressed source tree identity for the worker-bundle freshness gate:
# commit sha when clean, else the `git stash create` sha of the dirty tree.
if TREE_ID="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null)"; then
  if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null)" ]; then
    if STASH_SHA="$(git -C "$SCRIPT_DIR" stash create 2>/dev/null)" && [ -n "$STASH_SHA" ]; then
      TREE_ID="$STASH_SHA"
    fi
  fi
  export PRIME_AGENT_SOURCE_TREE_ID="$TREE_ID"
fi
# pi-ecosystem extensions (e.g. pi-web-access) read PI_CODING_AGENT_DIR for
# their config dir; point them at the prime-agent config directory.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.prime/agent}"

# Check for --no-env / --dist / --source flags
NO_ENV=false
# Dist bundle is the default; --source (or PRIME_AGENT_USE_DIST=false|0|no) runs tsx.
USE_DIST=true
USE_SOURCE=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  elif [[ "$arg" == "--dist" ]]; then
    USE_DIST=true
  elif [[ "$arg" == "--source" ]]; then
    USE_SOURCE=true
  else
    ARGS+=("$arg")
  fi
done
case "${PRIME_AGENT_USE_DIST:-}" in
  false|0|no) USE_DIST=false ;;
esac
if [[ "$USE_SOURCE" == "true" ]]; then
  USE_DIST=false
fi

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset PRIME_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  echo "Running Prime Agent without API keys..."
fi

# Dist bundle (default): the shipped build; ~3x faster startup than tsx.
if [[ "$USE_DIST" == "true" ]]; then
  BUNDLE="$SCRIPT_DIR/packages/coding-agent/dist/bundle/cli.js"
  if [[ ! -f "$BUNDLE" ]]; then
    echo "Bundle not found at $BUNDLE. Run npm run build first." >&2
    exit 1
  fi
  exec node "$BUNDLE" ${ARGS[@]+"${ARGS[@]}"}
fi

TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "tsx not found at $TSX_BIN. Run npm install from the repo root first." >&2
  exit 1
fi

"$TSX_BIN" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
