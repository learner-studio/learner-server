#!/usr/bin/env bash
# Learner cutover, second operator-run part: after deploy/install.sh (units, nginx, schedules flag,
# old worker stopped, hooks repointed). Re-copies the Learning data, verifies it, starts Learner
# PAUSED and smokes it through the public URL. Prints no secret; stops at the first failure.
#   bash /root/learner/deploy/cutover.sh
set -euo pipefail
cd /root/learner
ts=$(date +%Y%m%d%H%M%S)

running=$(cd /var/tmp && runuser -u postgres -- psql -d biztools_pikku -Atc "select count(*) from workflow_runs where status='running' and workflow ilike 'learning%'")
[ "$running" = 0 ] || { echo "biztools has $running running Learning runs; not copying"; exit 1; }
[ "$(systemctl is-active pikku-learning-worker || true)" != active ] || { echo "pikku-learning-worker is still running"; exit 1; }
systemctl stop learner-worker learner-api 2>/dev/null || true

# --reset TRUNCATEs every Learning table in `learner` and copies the source in one snapshot (~40 min)
bun build scripts/copy-learning-data.ts --target=bun --outfile=/var/tmp/learner-copy/copy.js >/dev/null
chown postgres /var/tmp/learner-copy/copy.js
(cd /var/tmp/learner-copy && runuser -u postgres -- env COPY_SOURCE_DB=biztools_pikku bun copy.js --reset > copy-$ts.log 2>&1)
bun --env-file=/etc/learner/db.env scripts/verify-copy.ts > /var/tmp/learner-copy/verify-$ts.md
head -1 /var/tmp/learner-copy/verify-$ts.md

# copied runs the pikku runtime will never resume (it did not start them)
(cd /var/tmp && runuser -u postgres -- psql -d learner -Atc "update learner_workflow_runs set status='cancelled', updated_at=now() where status not in ('completed','failed','cancelled') and graph_hash is null returning workflow_run_id" | wc -l | sed 's/^/cancelled copied non-terminal runs: /')

# start paused: the worker unit recreates /run/learner/learning-admission-paused while this flag exists
touch /etc/learner/admission-paused
systemctl enable --now learner-api learner-worker
for i in $(seq 1 120); do curl -sf https://dev.biztoolz.app/learner-api/api/health >/dev/null && break; sleep 1; done
curl -s https://dev.biztoolz.app/learner-api/api/health; echo
curl -s -o /dev/null -w 'public keyed RPC: %{http_code}\n' -X POST https://dev.biztoolz.app/learner-api/rpc/getLearningFeedbackCatalog \
  -H 'content-type: application/json' -H @<(sed -n 's/^LEARNER_API_KEY=/x-api-key: /p' /etc/learner/agent-key.env) -d '{"data":{}}'
systemctl is-active learner-api learner-worker
echo "OK: learner up and PAUSED. Unpause: rm /etc/learner/admission-paused /run/learner/learning-admission-paused"
