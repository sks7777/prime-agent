#!/bin/bash
# Запуск Rust-демона v0.10.0 для ручной отладки.
# Останавливает старый daemon, поднимает новый с изолированным config dir.

set -euo pipefail

WORKTREE=~/Development/prime-agent-v0.10
CONFIG_DIR=~/.prime-v0.10/agent
TMP_DIR=/tmp/pa-test-tmp

echo "=== Остановка старого daemon ==="
pkill -f 'target/.*/prime-agent' 2>/dev/null && echo "killed daemon" || echo "no daemon running"

echo ""
echo "=== Подготовка окружения ==="
mkdir -p "$TMP_DIR"
export PRIME_AGENT_CODING_AGENT_DIR="$CONFIG_DIR"
export TMPDIR="$TMP_DIR"
cd "$WORKTREE"

# fast-release: инкрементальный профиль (10s вместо 2.5min)
PROFILE="${PROFILE:-fast-release}"

if [ "$PROFILE" = "fast-release" ]; then
  BIN="./target/fast-release/prime-agent"
  BUILD_CMD="cargo build --profile fast-release -p pa-cli --bin prime-agent"
else
  BIN="./target/release/prime-agent"
  BUILD_CMD="RUSTC_WRAPPER=sccache cargo build --release --workspace"
fi

if [ ! -f "$BIN" ]; then
  echo "$PROFILE binary не найден. Запускаю сборку..."
  $BUILD_CMD
fi

echo ""
echo "=== Запуск prime-agent v0.10.0 ==="
echo "  Worktree:   $WORKTREE"
echo "  Config dir: $CONFIG_DIR"
echo "  TMPDIR:     $TMP_DIR"
echo "  Profile:    $PROFILE"
echo "  Binary:     $BIN"
echo ""
echo "  Для release профиля: PROFILE=release scripts/run-rust-daemon.sh"
echo ""
exec "$BIN"
