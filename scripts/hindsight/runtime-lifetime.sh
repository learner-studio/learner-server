#!/usr/bin/env bash
# Lifetime and memory bounds for transient Hindsight experiment runtimes.
# Sourced by scripts/hindsight/*-runtime.sh; not run directly.
#
# Why this exists: on 2026-09-21 three experiment servers from 2026-09-05 were
# still running (each with its embedded Postgres), holding ~0.6 GB of RAM and
# 1.3 GB of swap, because `systemd-run --collect` only collects a unit that
# EXITS and a server never does. Every start now schedules its own reaper.
#
# The reaper is a one-shot timer rather than RuntimeMaxSec= on the server unit:
# RuntimeMaxSec expiry is a "timeout" result, which Restart=on-failure treats as
# a failure and restarts — the lifetime would renew forever. A `systemctl stop`
# from a timer is a clean stop that Restart= ignores.
#
# HINDSIGHT_RUNTIME_MAX_SEC   lifetime in seconds (default 12h, must be > 0)
# HINDSIGHT_RUNTIME_MEMORY_MAX cgroup cap (default 4G; uncapped peaks measured 0.8–1.1G)
# HINDSIGHT_RUNTIME_DRY_RUN=1 print the systemd commands instead of running them
#
# Install and state locations (the Hindsight install is external to Learner):
# HINDSIGHT_INSTALL_ROOT       venv + src of the Hindsight install (default /opt/learner-hindsight; on the
#                              dev box a symlink to the install the previous host built, /opt/biztools-hindsight,
#                              because a venv is not relocatable)
# HINDSIGHT_ENV_FILE           its local-model/cache settings (default /etc/learner/hindsight.env)
# LEARNER_HINDSIGHT_STATE_ROOT per-run state + logs (default /var/lib/learner-hindsight/experiments)

hindsight_runtime_max_sec="${HINDSIGHT_RUNTIME_MAX_SEC:-43200}"
hindsight_runtime_memory_max="${HINDSIGHT_RUNTIME_MEMORY_MAX:-4G}"
hindsight_runtime_dry_run="${HINDSIGHT_RUNTIME_DRY_RUN:-0}"
hindsight_install_root="${HINDSIGHT_INSTALL_ROOT:-/opt/learner-hindsight}"
hindsight_env_file="${HINDSIGHT_ENV_FILE:-/etc/learner/hindsight.env}"
hindsight_state_root="${LEARNER_HINDSIGHT_STATE_ROOT:-/var/lib/learner-hindsight/experiments}"

if [[ ! "$hindsight_runtime_max_sec" =~ ^[1-9][0-9]*$ ]]; then
  echo "HINDSIGHT_RUNTIME_MAX_SEC must be a positive integer" >&2
  exit 2
fi

# Runs a systemd command, or prints it verbatim (one line, shell-quoted) in dry-run.
hr_run() {
  if [[ "$hindsight_runtime_dry_run" == 1 ]]; then
    local word first=1
    for word in "$@"; do
      (( first )) || printf ' '
      printf '%q' "$word"; first=0
    done
    printf '\n'
    return 0
  fi
  "$@"
}

hindsight_runtime_is_dry_run() { [[ "$hindsight_runtime_dry_run" == 1 ]]; }

# --property flags that bound the server: a cap that cannot page (MemorySwapMax=0)
# and enough tasks for the ~250 threads hindsight_api creates at boot.
hindsight_runtime_bound_properties() {
  printf '%s\n' \
    "--property=MemoryMax=$hindsight_runtime_memory_max" \
    "--property=MemorySwapMax=0" \
    "--property=TasksMax=512"
}

hindsight_runtime_reaper_unit() { printf '%s-reaper' "${1%.service}"; }

# Schedules `systemctl stop UNIT` after the lifetime. Idempotent per unit: a
# reaper left by an earlier start of the same run is replaced, so the lifetime
# always counts from the most recent start.
hindsight_runtime_reaper_start() {
  local unit="$1" reaper
  reaper=$(hindsight_runtime_reaper_unit "$unit")
  hr_run systemctl stop "$reaper.timer" 2>/dev/null || true
  hr_run systemctl reset-failed "$reaper.service" 2>/dev/null || true
  hr_run systemd-run --quiet --unit="$reaper" --collect \
    --on-active="$hindsight_runtime_max_sec" --timer-property=AccuracySec=1s \
    --description="stop $unit after ${hindsight_runtime_max_sec}s" \
    systemctl stop "$unit"
}

hindsight_runtime_reaper_stop() {
  local reaper
  reaper=$(hindsight_runtime_reaper_unit "$1")
  hr_run systemctl stop "$reaper.timer" 2>/dev/null || true
}
