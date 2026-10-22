#!/usr/bin/env bash
# Learner cutover, operator-run part: systemd units, nginx, schedules flag,
# stop the old worker, repoint hooks. Does NOT start learner (the data copy runs first).
set -euo pipefail
TS=$(date +%Y%m%d%H%M%S)
cd /root/learner

bun run build:web:proxied
install -m 644 deploy/systemd/learner-api.service deploy/systemd/learner-worker.service /etc/systemd/system/
systemctl daemon-reload

F=/etc/nginx/sites-available/dev-biztoolz
[ "$(rg -c '^    location / \{$' $F)" = 1 ] || { echo "expected exactly one 'location /' in $F"; exit 1; }
cp -p $F $F.bak-learner-$TS
install -m 644 deploy/nginx/learner.conf /etc/nginx/snippets/learner.conf
# the gate is the Learner's human auth: nginx injects the operator's Learner key (root-only file, never printed)
( umask 077; sed -n 's/^LEARNER_API_KEY=\(.*\)$/proxy_set_header x-api-key "\1";/p' /etc/learner/agent-key.env > /etc/nginx/learner-gate-key.conf )
[ "$(wc -l < /etc/nginx/learner-gate-key.conf)" = 1 ] || { echo "learner-gate-key.conf: expected one line"; exit 1; }
sed -i 's|^    location / {$|    # Learner app (/learner/, /learner-api/) -> 127.0.0.1:3010\n    include /etc/nginx/snippets/learner.conf;\n\n    location / {|' $F
nginx -t && systemctl reload nginx

# schedules take over from the biztools crons
E=/etc/learner/learner.env
cp -p $E $E.bak-$TS
rg -q '^LEARNER_SCHEDULES_ENABLED=' $E && sed -i 's/^LEARNER_SCHEDULES_ENABLED=.*/LEARNER_SCHEDULES_ENABLED=true/' $E || echo 'LEARNER_SCHEDULES_ENABLED=true' >> $E

systemctl stop pikku-learning-worker
systemctl disable pikku-learning-worker

# hooks -> learner client (it defaults to 127.0.0.1:3010 + /etc/learner/agent-key.env; pending files replay once learner is up)
for H in /root/.claude/settings.local.json /root/.codex/hooks.json; do
  cp -p $H $H.bak-learner-$TS
  sed -i 's|/root/biztools-dev/scripts/learning-claude-hook\.ts|/root/learner/clients/hook/src/index.ts|g' $H
  echo "$H: $(rg -c 'learner/clients/hook' $H) learner refs, $(rg -c 'learning-claude-hook' $H || echo 0) old refs"
done
install -d -m 700 /root/.claude/learner-hook-traces
cp -p /root/.claude/learning-hook-traces/*.off /root/.claude/learner-hook-traces/ 2>/dev/null || true

echo "OK: installed; learner not started yet (data copy next)"
