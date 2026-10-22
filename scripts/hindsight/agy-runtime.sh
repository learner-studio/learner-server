#!/usr/bin/env bash
set -euo pipefail

action="${1:-status}"
run_id="${2:-}"
port="${3:-18922}"
call_budget="${4:-6}"

# Lifetime + memory bounds (reaper timer, MemoryMax, dry-run) shared with the seed-v1 launcher.
# shellcheck source=scripts/runtime-lifetime.sh
source "$(dirname "${BASH_SOURCE[0]}")/runtime-lifetime.sh"

if [[ ! "$run_id" =~ ^[a-zA-Z0-9-]+$ ]]; then
  echo "run_id must be nonempty alphanumeric/hyphen" >&2
  exit 2
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "port must be an integer from 1 through 65535" >&2
  exit 2
fi
if [[ "$port" =~ ^1892[345]$ ]]; then
  echo "refusing reserved Hindsight port $port" >&2
  exit 2
fi
if [[ ! "$call_budget" =~ ^[1-9][0-9]*$ ]]; then
  echo "call_budget must be a positive integer" >&2
  exit 2
fi

runtime_key="hindsight-agy-$run_id"
runtime_schema="hindsight_agy_${run_id//-/_}"
runtime_root="$hindsight_state_root/$runtime_key"
log_file="$runtime_root/server.log"
base_url="http://127.0.0.1:$port"
unit="learner-hindsight-${runtime_key}.service"
learner_url="${LEARNER_URL:-http://127.0.0.1:3010}"
learner_agent_key_file="${LEARNER_AGENT_KEY_FILE:-/etc/learner/agent-key.env}"

healthy() { curl -sf --max-time 2 "$base_url/health" >/dev/null; }
owned_healthy() {
  healthy || return 1
  local pid
  pid=$(systemctl show "$unit" -p MainPID --value 2>/dev/null) || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fxq "HINDSIGHT_API_PORT=$port" || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fxq 'HINDSIGHT_API_LLM_MODEL=gemini-3.7-flash' || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fxq "BT_EXPERIMENT_ID=$run_id"
}

case "$action" in
  status)
    owned_healthy && { echo "ready $base_url"; exit 0; }
    echo "not-ready $base_url" >&2; exit 1 ;;
  stop) hindsight_runtime_reaper_stop "$unit"; hr_run systemctl stop "$unit" 2>/dev/null || true; exit 0 ;;
  start) ;;
  *) echo "usage: $0 start|status|stop RUN_ID [PORT] [CALL_BUDGET]" >&2; exit 2 ;;
esac

if ! hindsight_runtime_is_dry_run; then
  if healthy && ! owned_healthy; then
    echo "port $port is occupied by a runtime that does not match $unit/$run_id; refusing adoption" >&2
    exit 1
  fi
  # A re-invoked start is a heartbeat: the lifetime counts from the most recent start.
  if owned_healthy; then hindsight_runtime_reaper_start "$unit"; echo "ready $base_url"; exit 0; fi
  install -d -m 700 -o hindsight -g hindsight "$hindsight_state_root" "$runtime_root"
fi

# systemd reads the existing root-only key file before dropping privileges; the
# secret is never copied into this script, the unit command line, or its log.
# Hindsight's OpenAI-compatible client sends the same secret as
# Bearer and x-api-key; the other static headers scope bridge idempotency and
# its atomic novel-request budget to this isolated experiment runtime.
mapfile -t bound_properties < <(hindsight_runtime_bound_properties)
hr_run systemctl reset-failed "$unit" 2>/dev/null || true
hr_run systemd-run --quiet --unit="$unit" --collect "${bound_properties[@]}" \
  --property=User=hindsight --property=Group=hindsight \
  --property="EnvironmentFile=$hindsight_env_file" \
  "--property=EnvironmentFile=$learner_agent_key_file" \
  --property="WorkingDirectory=$runtime_root" \
  --property="StandardOutput=append:$log_file" --property="StandardError=append:$log_file" \
  --property=Restart=on-failure --property=RestartSec=2 \
  --setenv="BT_RUNTIME_KEY=$runtime_key" --setenv="BT_EXPERIMENT_ID=$run_id" \
  --setenv="BT_OPERATION_ID=$run_id" --setenv="BT_CALL_BUDGET=$call_budget" --setenv="BT_PORT=$port" \
  --setenv="BT_DATABASE_SCHEMA=$runtime_schema" --setenv="BT_INSTALL_ROOT=$hindsight_install_root" \
  --setenv="BT_BRIDGE_URL=$learner_url/api/internal/hindsight/v1" \
  /bin/bash -c '
    set -euo pipefail
    test -n "${LEARNER_API_KEY:-}"
    # The x-biztools-* header names are kept on purpose: the bridge
    # (hindsight-agy-openai-bridge*.ts) reads exactly these names, so a rename
    # must change this launcher and the bridge in one commit.
    default_headers=$(python3 -c '\''import json,os; print(json.dumps({"x-api-key":os.environ["LEARNER_API_KEY"],"x-biztools-experiment-id":os.environ["BT_EXPERIMENT_ID"],"x-biztools-operation-id":os.environ["BT_OPERATION_ID"],"x-biztools-call-budget":os.environ["BT_CALL_BUDGET"]}))'\'')
    export PYTHONPATH="$BT_INSTALL_ROOT"/src
    test "${HINDSIGHT_API_DATABASE_BACKEND:-}" = postgresql
    test -n "${HINDSIGHT_API_DATABASE_URL:-}"
    export HINDSIGHT_API_DATABASE_SCHEMA="$BT_DATABASE_SCHEMA"
    export HINDSIGHT_API_LLM_PROVIDER=openai HINDSIGHT_API_LLM_API_KEY="$LEARNER_API_KEY"
    export HINDSIGHT_API_LLM_BASE_URL="$BT_BRIDGE_URL"
    export HINDSIGHT_API_LLM_MODEL=gemini-3.7-flash HINDSIGHT_API_LLM_REASONING_EFFORT=high
    export HINDSIGHT_API_LLM_DEFAULT_HEADERS="$default_headers" HINDSIGHT_API_LLM_MAX_RETRIES=0 HINDSIGHT_API_LLM_TIMEOUT=420
    export HINDSIGHT_API_LLM_MAX_CONCURRENT=3 HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=3
    export HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT=3 HINDSIGHT_API_REFLECT_LLM_MAX_CONCURRENT=3
    export HINDSIGHT_API_RETAIN_LLM_PROVIDER=openai HINDSIGHT_API_RETAIN_LLM_MODEL=gemini-3.7-flash
    export HINDSIGHT_API_RETAIN_LLM_BASE_URL="$BT_BRIDGE_URL"
    export HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=high HINDSIGHT_API_RETAIN_LLM_MAX_RETRIES=0 HINDSIGHT_API_RETAIN_LLM_TIMEOUT=420
    export HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER=openai HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=gemini-3.7-flash
    export HINDSIGHT_API_CONSOLIDATION_LLM_BASE_URL="$BT_BRIDGE_URL"
    export HINDSIGHT_API_CONSOLIDATION_LLM_REASONING_EFFORT=high HINDSIGHT_API_CONSOLIDATION_LLM_MAX_RETRIES=0 HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT=420
    export HINDSIGHT_API_REFLECT_LLM_PROVIDER=openai HINDSIGHT_API_REFLECT_LLM_MODEL=gemini-3.7-flash
    export HINDSIGHT_API_REFLECT_LLM_BASE_URL="$BT_BRIDGE_URL"
    export HINDSIGHT_API_REFLECT_LLM_REASONING_EFFORT=high HINDSIGHT_API_REFLECT_LLM_MAX_RETRIES=0 HINDSIGHT_API_REFLECT_LLM_TIMEOUT=420
    export HINDSIGHT_API_RETAIN_BATCH_ENABLED=false HINDSIGHT_API_RETAIN_BATCH_TOKENS=400000
    export HINDSIGHT_API_RETAIN_CHUNK_SIZE=60000 HINDSIGHT_API_RETAIN_STRUCTURED_CHUNK_SIZE=60000
    export HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=64000 HINDSIGHT_API_RETAIN_EXTRACT_CAUSAL_LINKS=false
    export HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=3 HINDSIGHT_API_CONSOLIDATION_MAX_ATTEMPTS=1
    export HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS=64000 HINDSIGHT_API_REFLECT_MAX_ITERATIONS=3
    export HINDSIGHT_API_LLM_TRACE_ENABLED=true HINDSIGHT_API_SKIP_LLM_VERIFICATION=true
    export HINDSIGHT_API_ENABLE_OBSERVATIONS=true HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false
    export HINDSIGHT_API_ENABLE_BANK_CONFIG_API=true HINDSIGHT_API_STORE_DOCUMENT_TEXT=true
    export HINDSIGHT_API_HOST=127.0.0.1 HINDSIGHT_API_PORT="$BT_PORT"
    exec "$BT_INSTALL_ROOT"/venv/bin/python -m hindsight_api.main --host 127.0.0.1 --port "$BT_PORT" --workers 1 --no-access-log
  '
hindsight_runtime_reaper_start "$unit"
hindsight_runtime_is_dry_run && exit 0

for _attempt in $(seq 1 120); do
  if owned_healthy; then
    echo "ready $base_url pid=$(systemctl show "$unit" -p MainPID --value)"
    exit 0
  fi
  if ! systemctl is-active --quiet "$unit"; then
    tail -n 80 "$log_file" >&2
    exit 1
  fi
  sleep 1
done
echo "isolated Hindsight runtime did not become healthy within 120s" >&2
tail -n 80 "$log_file" >&2
exit 1
