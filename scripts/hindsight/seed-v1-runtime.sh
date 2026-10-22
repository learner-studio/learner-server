#!/usr/bin/env bash
set -euo pipefail

action="${1:-status}"
run_id="${2:-}"
port="${3:-18924}"
profile="${4:-extractor}"

# Lifetime + memory bounds (reaper timer, MemoryMax, dry-run) shared with the agy launcher.
# shellcheck source=scripts/runtime-lifetime.sh
source "$(dirname "${BASH_SOURCE[0]}")/runtime-lifetime.sh"

if [[ ! "$run_id" =~ ^[a-zA-Z0-9-]+$ ]]; then
  echo "run_id must be nonempty alphanumeric/hyphen" >&2
  exit 2
fi
if [[ "$port" == "18925" ]]; then
  echo "refusing canonical Hindsight archive port 18925" >&2
  exit 2
fi
if [[ "$profile" != "extractor" && "$profile" != "consolidation" ]]; then
  echo "profile must be extractor or consolidation" >&2
  exit 2
fi

runtime_key="$run_id"
if [[ "$profile" == "consolidation" ]]; then
  runtime_key="$run_id-consolidation"
fi
runtime_root="$hindsight_state_root/$runtime_key"
log_file="$runtime_root/server.log"
base_url="http://127.0.0.1:$port"
unit="learner-hindsight-${runtime_key}.service"

healthy() {
  curl -sf --max-time 2 "$base_url/health" >/dev/null
}

case "$action" in
  status)
    if healthy; then
      echo "ready $base_url"
      exit 0
    fi
    echo "not-ready $base_url" >&2
    exit 1
    ;;
  stop)
    hindsight_runtime_reaper_stop "$unit"
    hr_run systemctl stop "$unit" 2>/dev/null || true
    exit 0
    ;;
  start) ;;
  *)
    echo "usage: $0 start|status|stop RUN_ID [PORT] [extractor|consolidation]" >&2
    exit 2
    ;;
esac

if ! hindsight_runtime_is_dry_run && healthy; then
  # A re-invoked start is a heartbeat: the lifetime counts from the most recent start.
  hindsight_runtime_reaper_start "$unit"
  echo "ready $base_url"
  exit 0
fi

hindsight_runtime_is_dry_run || install -d -m 700 -o hindsight -g hindsight \
  "$hindsight_state_root" "$runtime_root" "$runtime_root/codex"
hindsight_runtime_is_dry_run || install -m 600 -o hindsight -g hindsight /root/.codex/auth.json "$runtime_root/codex/auth.json"

consolidation_provider="none"
consolidation_model=""
consolidation_effort=""
if [[ "$profile" == "consolidation" ]]; then
  consolidation_provider="openai-codex"
  consolidation_model="gpt-5.6-luna"
  consolidation_effort="high"
fi

# A transient systemd unit gives Learner workflow retries a stable process to
# rediscover. EnvironmentFile supplies only the installed local-model/cache
# paths; every database and billable-LLM setting is explicitly replaced.
mapfile -t bound_properties < <(hindsight_runtime_bound_properties)
hr_run systemctl reset-failed "$unit" 2>/dev/null || true
hr_run systemd-run --quiet --unit="$unit" --collect "${bound_properties[@]}" \
  --property=User=hindsight --property=Group=hindsight \
  --property="WorkingDirectory=$runtime_root" \
  --property="EnvironmentFile=$hindsight_env_file" \
  --property="StandardOutput=append:$log_file" --property="StandardError=append:$log_file" \
  --property=Restart=on-failure --property=RestartSec=2 \
  /usr/bin/env \
    "HOME=$runtime_root" "CODEX_HOME=$runtime_root/codex" "PYTHONPATH=$hindsight_install_root/src" \
    HINDSIGHT_API_DATABASE_BACKEND=postgresql "HINDSIGHT_API_DATABASE_URL=pg0://$runtime_key" HINDSIGHT_API_DATABASE_SCHEMA=public \
    HINDSIGHT_API_LLM_PROVIDER=openai-codex HINDSIGHT_API_LLM_MODEL=gpt-5.6-luna HINDSIGHT_API_LLM_REASONING_EFFORT=high HINDSIGHT_API_LLM_MAX_RETRIES=0 \
    HINDSIGHT_API_LLM_TIMEOUT=420 HINDSIGHT_API_RETAIN_LLM_TIMEOUT=420 \
    HINDSIGHT_API_RETAIN_LLM_PROVIDER=openai-codex HINDSIGHT_API_RETAIN_LLM_MODEL=gpt-5.6-luna HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=high HINDSIGHT_API_RETAIN_LLM_MAX_RETRIES=0 \
    HINDSIGHT_API_REFLECT_LLM_PROVIDER=none "HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER=$consolidation_provider" \
    "HINDSIGHT_API_CONSOLIDATION_LLM_MODEL=$consolidation_model" "HINDSIGHT_API_CONSOLIDATION_LLM_REASONING_EFFORT=$consolidation_effort" \
    HINDSIGHT_API_CONSOLIDATION_LLM_MAX_RETRIES=0 HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT=420 \
    HINDSIGHT_API_CONSOLIDATION_MAX_ATTEMPTS=1 HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS=64000 \
    HINDSIGHT_API_LLM_TRACE_ENABLED=true \
    HINDSIGHT_API_SKIP_LLM_VERIFICATION=true \
    HINDSIGHT_API_RETAIN_EXTRACT_CAUSAL_LINKS=false HINDSIGHT_API_ENABLE_OBSERVATIONS=false HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false \
    HINDSIGHT_API_ENABLE_BANK_CONFIG_API=true HINDSIGHT_API_STORE_DOCUMENT_TEXT=true \
    HINDSIGHT_API_HOST=127.0.0.1 "HINDSIGHT_API_PORT=$port" \
    "$hindsight_install_root/venv/bin/python" -m hindsight_api.main \
    --host 127.0.0.1 --port "$port" --workers 1 --no-access-log
hindsight_runtime_reaper_start "$unit"
hindsight_runtime_is_dry_run && exit 0

for _attempt in $(seq 1 120); do
  if healthy; then
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
