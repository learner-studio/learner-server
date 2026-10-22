# Deploying Learner on the dev box (dev.biztoolz.app)

Runs under systemd from this checkout. Pikku is the runtime
(`LEARNER_RUNTIME=pikku`); `standalone` is one `Environment=` edit away.

| Unit | What | Log |
|---|---|---|
| `learner-api.service` | RPC, REST, Better Auth, the built web app; 127.0.0.1:3010 | `/var/log/learner/api.log` |
| `learner-worker.service` | queues, workflows, schedules (off unless `LEARNER_SCHEDULES_ENABLED=true`) | `/var/log/learner/worker.log` |

Both read `/etc/learner/{db,learner,langfuse,typesafe}.env` (mode 600; never
print them). `/etc/learner/agent-key.env` is the CLIENT key, read by the hook
and the smokes, not by the services. Both units share `/run/learner`: the
runtime role files and the admission pause file
`/run/learner/learning-admission-paused` (present = no new learning work is
admitted).

## Install

```bash
cd /root/learner
bun run build:web:proxied                       # apps/web/dist-proxied, assets under /learner/
install -m 644 deploy/systemd/learner-api.service deploy/systemd/learner-worker.service /etc/systemd/system/
systemctl daemon-reload

# nginx: back up, add the snippet, include it before the server block's `location /`
F=/etc/nginx/sites-available/dev-biztoolz
cp -p $F $F.bak-learner-$(date +%Y%m%d%H%M%S)
install -m 644 deploy/nginx/learner.conf /etc/nginx/snippets/learner.conf
sed -i 's|^    location / {$|    # Learner app (/learner/, /learner-api/) -> 127.0.0.1:3010\n    include /etc/nginx/snippets/learner.conf;\n\n    location / {|' $F
nginx -t && systemctl reload nginx

# no copied run may be left non-terminal: the pikku runtime does not resume
# runs it did not start (graph_hash is null on every copied run)
cd /var/tmp && runuser -u postgres -- psql -d learner -c "update learner_workflow_runs set status='cancelled', updated_at=now() where status not in ('completed','failed','cancelled') and graph_hash is null"

systemctl enable --now learner-api learner-worker
```

`sed` must report exactly one `location / {` at four-space indent in that
file (`rg -c '^    location / \{$' $F` prints 1), or the include lands twice.

## URLs

| URL | Who | Auth |
|---|---|---|
| `https://dev.biztoolz.app/learner/` | humans | the `/console` gate (`auth_request /auth/verify/pikku`); the Learner itself then needs its own credential, see below |
| `https://dev.biztoolz.app/learner-api/rpc/<name>` | machines | `x-api-key` (a Learner key), no gate |
| `https://dev.biztoolz.app/learner-api/api/health` | anyone | none |

`/learner/` shadows the biztools frontend's own `/learner/*` pages on this
host, deliberately: after the cutover those read a database the Learning
worker no longer writes.

The gate's credential never reaches the Learner (nginx replaces `x-api-key`
on the gated paths with the client's `x-learner-key`). So a browser that
passes the gate is still SIGNED OUT of the Learner until one of:

1. Google sign-in for the Learner (`LEARNER_GOOGLE_CLIENT_ID/SECRET`,
   `LEARNER_BASE_URL=https://dev.biztoolz.app/learner`, and the redirect URI
   `https://dev.biztoolz.app/learner/api/auth/callback/google` on the OAuth
   client), or
2. nginx injecting a dedicated Learner key on the gated paths, from a
   root-only include — the gate then IS the Learner's authentication, and
   everyone the gate admits (today the operator alone) acts as that key's
   owner.

## Smoke

```bash
curl -s https://dev.biztoolz.app/learner-api/api/health
curl -s -X POST https://dev.biztoolz.app/learner-api/rpc/getLearningFeedbackCatalog \
  -H 'content-type: application/json' \
  -H @<(sed -n 's/^LEARNER_API_KEY=/x-api-key: /p' /etc/learner/agent-key.env) -d '{"data":{}}'
```

## Moving the live work over (phase 2)

There is no delta copy: `copy-learning-data.ts --reset` TRUNCATES every
Learning table in `learner` and copies the source again in one snapshot
(~40 minutes for 52M rows). Rows written only in `learner` since the last
copy are lost.

```bash
systemctl stop pikku-learning-worker && systemctl disable pikku-learning-worker
systemctl stop learner-worker learner-api
bun build /root/learner/scripts/copy-learning-data.ts --target=bun --outfile=/var/tmp/learner-copy/copy.js
chown postgres /var/tmp/learner-copy/copy.js
cd /var/tmp/learner-copy && runuser -u postgres -- env COPY_SOURCE_DB=biztools_pikku bun copy.js --reset > copy.log 2>&1
cd /root/learner && bun --env-file=/etc/learner/db.env scripts/verify-copy.ts   # exits 1 on any mismatch
cd /var/tmp && runuser -u postgres -- psql -d learner -c "update learner_workflow_runs set status='cancelled', updated_at=now() where status not in ('completed','failed','cancelled') and graph_hash is null"
systemctl start learner-api learner-worker
```

The biztools worker ran the Learning schedules; the Learner runs none until
`LEARNER_SCHEDULES_ENABLED=true` is in `/etc/learner/learner.env`, and admits
no new work while `/run/learner/learning-admission-paused` exists.

Then the hooks (the new hook's defaults are already `http://127.0.0.1:3010`
and `/etc/learner/agent-key.env`, so `~/.claude/learning-hook.json` needs no
`serverUrl`/`keyFile` on this box):

```bash
# per-session "learner off" markers move to the new trace directory
install -d -m 700 /root/.claude/learner-hook-traces
cp -p /root/.claude/learning-hook-traces/*.off /root/.claude/learner-hook-traces/
# every hook command: /root/biztools-dev/scripts/learning-claude-hook.ts -> /root/learner/clients/hook/src/index.ts
for f in /root/.claude/settings.local.json /root/.codex/hooks.json; do
  cp -p $f $f.bak-learner-$(date +%Y%m%d%H%M%S)
  sed -i 's|/root/biztools-dev/scripts/learning-claude-hook\.ts|/root/learner/clients/hook/src/index.ts|g' $f
done
```
