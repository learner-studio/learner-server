#!/usr/bin/env bash
# Learner cutover on the dev box, as one operator-run script (see README.md).
#   bash /root/learner/deploy/cutover.sh phase1   install units + nginx, start Learner (paused)
#   bash /root/learner/deploy/cutover.sh phase2   stop the biztools Learning worker, re-copy, verify, restart, repoint Codex hooks
# Prints no secret. Stops at the first failure.
set -euo pipefail
cd /root/learner
ts=$(date +%Y%m%d%H%M%S)

phase1() {
  bun run build:web:proxied >/dev/null
  install -m 644 deploy/systemd/learner-api.service deploy/systemd/learner-worker.service /etc/systemd/system/
  systemctl daemon-reload
  F=/etc/nginx/sites-available/dev-biztoolz
  [ "$(rg -c '^    location / \{$' $F)" = 1 ] || { echo "expected exactly one 'location /' in $F"; exit 1; }
  install -m 644 deploy/nginx/learner.conf /etc/nginx/snippets/learner.conf
  if ! rg -q 'snippets/learner.conf' $F; then
    cp -p $F $F.bak-learner-$ts
    sed -i 's|^    location / {$|    # Learner app (/learner/, /learner-api/) -> 127.0.0.1:3010\n    include /etc/nginx/snippets/learner.conf;\n\n    location / {|' $F
  fi
  nginx -t && systemctl reload nginx
  # the worker boots paused: the unit recreates the pause file while this flag exists
  touch /etc/learner/admission-paused
  systemctl enable --now learner-api learner-worker
  for i in $(seq 1 90); do curl -sf https://dev.biztoolz.app/learner-api/api/health >/dev/null && break; sleep 1; done
  curl -s https://dev.biztoolz.app/learner-api/api/health; echo
  systemctl is-active learner-api learner-worker
}

phase2() {
  running=$(cd /var/tmp && runuser -u postgres -- psql -d biztools_pikku -Atc "select count(*) from workflow_runs where status='running' and workflow ilike 'learning%'")
  [ "$running" = 0 ] || { echo "biztools has $running running Learning runs; not cutting over"; exit 1; }
  systemctl stop pikku-learning-worker && systemctl disable pikku-learning-worker   # unit file kept
  systemctl stop learner-worker learner-api
  bun build scripts/copy-learning-data.ts --target=bun --outfile=/var/tmp/learner-copy/copy.js >/dev/null
  chown postgres /var/tmp/learner-copy/copy.js
  (cd /var/tmp/learner-copy && runuser -u postgres -- env COPY_SOURCE_DB=biztools_pikku bun copy.js --reset > copy-$ts.log 2>&1)
  bun --env-file=/etc/learner/db.env scripts/verify-copy.ts | tee /var/tmp/learner-copy/verify-$ts.md | head -3
  (cd /var/tmp && runuser -u postgres -- psql -d learner -c "update learner_workflow_runs set status='cancelled', updated_at=now() where status not in ('completed','failed','cancelled') and graph_hash is null")
  systemctl start learner-api learner-worker
  # hooks: per-session "learner off" markers, then the Codex hook commands. The Claude hook commands live in
  # /root/.claude/settings.local.json and are changed separately (same sed, by the operator).
  install -d -m 700 /root/.claude/learner-hook-traces
  cp -p /root/.claude/learning-hook-traces/*.off /root/.claude/learner-hook-traces/ 2>/dev/null || true
  cp -p /root/.codex/hooks.json /root/.codex/hooks.json.bak-learner-$ts
  sed -i 's|/root/biztools-dev/scripts/learning-claude-hook\.ts|/root/learner/clients/hook/src/index.ts|g' /root/.codex/hooks.json
  systemctl is-active learner-api learner-worker
}

"${1:?phase1|phase2}"
