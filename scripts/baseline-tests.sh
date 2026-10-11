#!/bin/bash
# Baseline test suite for PA v0.10.0 (macOS).
# Run after every code change: `scripts/baseline-tests.sh`
#
# Prerequisites:
#   - sccache server running: `sccache --start-server`
#   - Short TMPDIR for AF_UNIX socket paths: export TMPDIR=/tmp/pa-test-tmp/
#   - Build first: `RUSTC_WRAPPER=sccache cargo build --release --workspace`

set -euo pipefail
cd "$(dirname "$0")/.."

export TMPDIR=/tmp/pa-test-tmp/
export LC_ALL=en_US.UTF-8
export RUSTC_WRAPPER=sccache

mkdir -p "$TMPDIR"

PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=""
SKIPPED_TESTS=""

# --- Unit tests (always run, no daemon needed) ---
echo "=== Unit tests ==="
for crate in pa-agent pa-ai pa-cli pa-core pa-daemon pa-tui pa-types pa-telemetry pa-models; do
  RESULT=$(cargo test --release -p "$crate" --lib 2>&1 | grep 'test result:' | tail -1)
  if echo "$RESULT" | grep -q '0 failed'; then
    echo "  PASS  $crate (lib)"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $crate (lib) — $RESULT"
    FAIL=$((FAIL+1))
    FAILED_TESTS="$FAILED_TESTS $crate:lib"
  fi
done

# --- Mock-supervisor headless tests (no real daemon) ---
echo ""
echo "=== Mock-supervisor headless tests ==="
HEADLESS_TESTS=(
  bash_bang_headless
  daemon_rejection_headless
  daemon_shutdown_reconnect_headless
  daemon_shutdown_turn_end_headless
  dock_arrows_headless
  loader_anchor_headless
  loader_quiet_turn_headless
  tray_prompt_down_headless
  wake_inventory_headless
  chat_open_first_frame_headless
  chat_detail_persist_headless
  close_listener_cleanup_e2e
  command_breadth
  cursor_visibility_e2e
  daemon_boot_reap_e2e
  daemon_discovery_e2e
  daemon_wire_roundtrip
  dock_click_headless
  dock_panel_exit_focus_headless
  drag_select_perf
  editor_keybinds_parity_headless
  effort_tray_label_headless
  esc_repeat_ladder_headless
  info_panel_headless
  input_live_open_pty_e2e
  installer_platform_map
  kernel_capture_freshness
  kernel_lifecycle
  kernel_protocol_frame_caps
  kernel_python_skills_unavailable
  kernel_restore_guards
  kernel_snapshot_resume
  kernel_startup_join
  kernel_startup_memo
  kernel_stop_revive
  kernel_teardown
  kitty_early_typing_e2e
  kitty_release_handoff_e2e
  live_catalog_chain
  lock_compat
  lock_compat_e2e
  login_panel_pty_e2e
  mouse_click_open_headless
  mouse_scroll_headless
  mouse_selection_headless
  session_jsonl_roundtrip
  settings_menu_headless
  skills_menu_headless
  slash_menu_panel_headless
  speed_footer_headless
  stash_restore_before_typed_ahead_headless
  telemetry_command_headless
  touch_click_headless
  update_flow_artifacts
  release_channel_manifest
  release_workflow
  refresh_compat
  prompt_guards
  factory_command_headless
  nightly_command_headless
  plugins_command_headless
  prompt_history_nav_headless
  quiet_tick_busy_stream_headless
  service_tier_headless
  analytics_wire
  anthropic_warning_lifecycle_headless
  fetch_layer
  git_context
  golden_system_prompt
  agents_view_heartbeat_badge_headless
  agents_view_incident_notice_e2e
  agents_view_saved_catalog_failure
  agents_view_search_e2e
  agents_view_wait_render_barrier
  agents_view_anchor_e2e
  compaction_completion_stall_e2e
  compaction_mega_trace_e2e
  eval_composition_e2e
)

for test in "${HEADLESS_TESTS[@]}"; do
  RESULT=$(timeout 30 cargo test --release --test "$test" 2>&1 | grep 'test result:' | tail -1)
  if echo "$RESULT" | grep -q '0 failed'; then
    echo "  PASS  $test"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $test — $RESULT"
    FAIL=$((FAIL+1))
    FAILED_TESTS="$FAILED_TESTS $test"
  fi
done

# --- Daemon e2e tests (need short TMPDIR) ---
echo ""
echo "=== Daemon e2e tests ==="
DAEMON_TESTS=(
  abort_kernel_cell
  abort_kernel_e2e
  acp_config_option_e2e
  agent_family_e2e
  agents_view_catalog_settle_carry
  agents_view_reply_e2e
  agents_view_subagents_e2e
  autonomous_e2e
  chat_agents_chat_roundtrip_e2e
  command_dispatch_e2e
  compaction_abort_e2e
  compaction_outcome_e2e
  compaction_summary_stream_e2e
  context_latency_e2e
  continue_guard_e2e
  create_join_e2e
  daemon_commands_e2e
  direct_attach_e2e
  dock_scope_exit_focus_e2e
  fork_isolation_e2e
  goal_branch_reload_e2e
  goal_recovery_e2e
  herdr_pane_e2e
  hold_refusal_e2e
  import_compaction_e2e
  mcp_catalog_e2e
  mcp_product_path_e2e
  model_catalog_e2e
  rlm_children_e2e
  rlm_quiescence_barrier_e2e
  rlm_roster_walk_e2e
  rlm_spawn_replacement_e2e
  rlm_children_parent_death_e2e
  rlm_children_replacement_e2e
  rpc_mode_e2e
  saved_catalog_stream_e2e
  saved_session_wake_e2e
  session_archive_e2e
  session_rebind_e2e
  session_stop_lifecycle_e2e
  session_tree_e2e
  socket_identity_guard_e2e
  stale_lease_release_e2e
  startup_no_auto_resume_e2e
  steer_boundary_batch_e2e
  stop_escalation_e2e
  subagent_panel_nav_e2e
  subagent_panel_nested_count_e2e
  supervisor_e2e
  thinking_level_e2e
  thinking_level_roster_e2e
  worker_orphan_exit_e2e
  worker_stderr_e2e
  provider_failover_e2e
  provider_failure_e2e
  queue_delivery_e2e
  readoption_wake_e2e
  recovery_control_plane_e2e
  registration_refusal_heal_e2e
  replacement_kernel_e2e
  protocol_breadth_b10_b11
  protocol_breadth_b6_b9
  peer_messaging_e2e
  package_e2e
  package_resources_e2e
  packaged_layout_e2e
  print_runtime_e2e
  telemetry_command_e2e
  view_switch_latency_e2e
)

for test in "${DAEMON_TESTS[@]}"; do
  RESULT=$(timeout 30 cargo test --release --test "$test" 2>&1 | grep 'test result:' | tail -1)
  if echo "$RESULT" | grep -q '0 failed'; then
    echo "  PASS  $test"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $test — $RESULT"
    FAIL=$((FAIL+1))
    FAILED_TESTS="$FAILED_TESTS $test"
  fi
done

# --- Linux-only tests (skipped on macOS) ---
echo ""
echo "=== Linux-only tests (skipped on macOS) ==="
LINUX_TESTS=(
  clipboard_auth_commands_e2e
  export_live_differential
  export_share_e2e
  interactive_daemon_e2e
  interactive_fork_e2e
  mcp_view_e2e
  tui_rss_stability
  termios_process_exit_e2e
  kitty_exit_routes_e2e
  terminal_state_differential_e2e
  idle_passivation_e2e
  windows_runtime_triage_e2e
  windows_runtime_triage_workflow
)

for test in "${LINUX_TESTS[@]}"; do
  echo "  SKIP  $test (Linux-only)"
  SKIP=$((SKIP+1))
  SKIPPED_TESTS="$SKIPPED_TESTS $test"
done

# --- Summary ---
echo ""
echo "=== SUMMARY ==="
echo "Pass:    $PASS"
echo "Fail:    $FAIL"
echo "Skip:    $SKIP (Linux-only, not run on macOS)"
if [ -n "$FAILED_TESTS" ]; then
  echo ""
  echo "FAILED:$FAILED_TESTS"
fi
echo ""
if [ $FAIL -gt 0 ]; then
  exit 1
fi
