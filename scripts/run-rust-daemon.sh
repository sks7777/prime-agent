#!/bin/bash
# Rust-демон prime-agent v0.10 для bb (провайдер acp-prime-agent-rust).
#
# Что делает:
#   1. собирает бинарник (fast-release по умолчанию — его запускает bb-враппер);
#   2. останавливает старый демон на изолированном сокете;
#   3. по умолчанию открывает интерактивный TUI на дефолтном сокете
#      /tmp/prime-agent-<uid>/daemon.sock с конфиг-диром ~/.prime/agent
#      (те же пути, что у bb-клиентов); TUI сам поднимает демон, и демон
#      остаётся жить после выхода из TUI — bb-клиенты подключаются к нему же.
#
# bb ничего дополнительно не требует: клиент ~/bin/prime-agent-rust-bb
# подключается к этому же сокету.
#
# Режимы:
#   ./scripts/run-rust-daemon.sh [аргументы TUI]       # TUI поверх демона (по умолчанию)
#   TUI=0 ./scripts/run-rust-daemon.sh                 # только демон в фоне + проверка готовности
#   FOREGROUND=1 TUI=0 ./scripts/run-rust-daemon.sh    # демон в этом терминале (логи видны)
#   PROFILE=release ./scripts/run-rust-daemon.sh       # release-профиль (медленнее сборка, стабильнее)
#
# TMPDIR сознательно не переопределяется: дефолтный сокет-дир /tmp/prime-agent-<uid>
# совпадает с тем, что bb-клиенты используют через resolve_daemon_socket_path.
# После фикса длины имени воркер-сокета (6-символьный хеш) пути укладываются
# в лимит AF_UNIX на macOS, и окружение демона совпадает с окружением bb-клиентов.

set -euo pipefail

# Чистим внутренние переменные хост-агента: без этого процесс, запущенный из
# шелла работающего prime-agent, считает себя воркером чужого демона и падает
# с "Daemon socket already in use" на чужом worker-сокете.
while IFS='=' read -r name _; do
  case "$name" in
    PRIME_AGENT_INTERNAL_*) unset "$name" ;;
  esac
done < <(env)
unset PRIME_AGENT_KERNEL_OWNER_PID PRIME_AGENT_SESSION_DIR 2>/dev/null || true

WORKTREE="$HOME/Development/prime-agent-v0.10"
CONFIG_DIR="$HOME/.prime/agent"
SOCKET_DIR="/tmp/prime-agent-$(id -u)"
SOCKET="$SOCKET_DIR/daemon.sock"
PROFILE="${PROFILE:-fast-release}"
FOREGROUND="${FOREGROUND:-0}"
TUI="${TUI:-1}"

case "$PROFILE" in
  release)
    BIN="$WORKTREE/target/release/prime-agent"
    BUILD=(cargo build --release -p pa-cli --bin prime-agent)
    ;;
  fast-release)
    BIN="$WORKTREE/target/fast-release/prime-agent"
    BUILD=(cargo build --profile fast-release -p pa-cli --bin prime-agent)
    ;;
  *)
    echo "PROFILE должен быть release | fast-release (получено: $PROFILE)" >&2
    exit 2
    ;;
esac

cd "$WORKTREE"

echo "=== Сборка ($PROFILE) ==="
if command -v sccache >/dev/null 2>&1; then
  RUSTC_WRAPPER=sccache "${BUILD[@]}"
else
  "${BUILD[@]}"
fi
if [ "$PROFILE" != "fast-release" ]; then
  echo "ВНИМАНИЕ: bb-враппер ~/bin/prime-agent-rust-bb и ~/bin/prime-agent запускают target/fast-release/prime-agent."
fi

echo ""
echo "=== Остановка старого демона ==="
# Паттерн точный: argv демона содержит "--mode daemon", bb-клиенты (--mode acp)
# и TS-демон не задеваются. Активные треды в bb при этом оборвутся.
if pkill -f "prime-agent --mode daemon --daemon-socket $SOCKET_DIR"; then
  echo "старый демон остановлен"
else
  echo "демон не был запущен"
fi

export PRIME_AGENT_CODING_AGENT_DIR="$CONFIG_DIR"
mkdir -p "$SOCKET_DIR"

if [ "$TUI" = "1" ]; then
  echo "=== TUI поверх демона на $SOCKET (демон поднимется сам и переживёт выход) ==="
  exec "$BIN" --daemon-socket "$SOCKET" "$@"
fi

echo ""
echo "=== Запуск демона на $SOCKET ==="
if [ "$FOREGROUND" = "1" ]; then
  echo "(Ctrl+C останавливает демон; bb переподнимет его при следующем треде)"
  exec "$BIN" --mode daemon --daemon-socket "$SOCKET"
fi

nohup "$BIN" --mode daemon --daemon-socket "$SOCKET" \
  >"$SOCKET_DIR/daemon.stdout.log" 2>&1 &
disown

echo "=== Ожидание готовности (до 30с) ==="
# Готовность = клиентское подключение проходит: list сам подключается к
# демону на указанном сокете (и boot-ит его, если тот ещё не поднялся).
# status тут не годится: он сканирует только дефолтные каталоги сокетов
# и кастомный --daemon-socket не видит.
ready=0
for _ in $(seq 1 60); do
  if "$BIN" --daemon-socket "$SOCKET" list --json >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "Демон не поднялся за 30с. Логи:" >&2
  echo "  $SOCKET_DIR/daemon.stdout.log" >&2
  echo "  $CONFIG_DIR/logs/" >&2
  exit 1
fi
echo "Демон отвечает на клиентские подключения."
echo ""
echo "Готово. bb видит агента как провайдер acp-prime-agent-rust."
echo "Проверка:      bb provider models acp-prime-agent-rust"
echo "Тестовый тред: bb thread spawn --provider acp-prime-agent-rust --project <id> --prompt hi"
echo "Лог stdout:    $SOCKET_DIR/daemon.stdout.log"
echo "Логи агента:   $CONFIG_DIR/logs/"
