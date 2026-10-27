# learner-upload

Captures a client machine's Claude Code and Codex CLI sessions on a remote
Learner server. It tails the native transcripts and appends their raw bytes
to the server spool (`uploadTranscript`). The server's archive sweep then
reads the spool like its own `~/.claude/projects`, so parsing, dedupe and
grading all stay on the server. A session copied between two machines still
counts once, because the grading keys are the native ids.

| Provider | Root (override) | Files |
|---|---|---|
| claude | `~/.claude/projects` (`LEARNER_CLAUDE_ROOT`) | `**/*.jsonl`, subagent transcripts included |
| codex | `~/.codex/sessions` (`LEARNER_CODEX_ROOT`) | `YYYY/MM/DD/rollout-*.jsonl` |

## Setup

1. On the server, mint a device key: `bun --env-file=/etc/learner/db.env packages/server/scripts/mint-api-key.ts --device <clientId>`. A key that the desktop app already uses works too, because it is bound to the same clientId.
2. On the client, create `~/.learner/uploader.json`:
   `{"serverUrl": "https://dev.biztoolz.app/learner-api", "clientId": "<clientId>", "keyFile": "~/.learner/device-key.env"}`.
   The key file holds one line, `LEARNER_API_KEY=…`, and should be mode 600.
3. Run it under a supervisor: `deploy/app.learner.uploader.plist` (launchd) or `deploy/learner-uploader.service` (systemd --user). To run one pass by hand, use `bun clients/uploader/src/index.ts --once`.

## Durability and self-healing

- **Offsets** live in `~/.learner/uploader/state.json`. The file is rewritten atomically (tmp, fsync, rename) after every acknowledged chunk.
  - A crash or `kill -9` loses at most the chunk in flight.
  - Resending that chunk is a server no-op (offset-addressed replay).
- **The server is the source of truth.** All of these cases resolve the same way: `getTranscriptUploadState` returns the server's size and sha256, the uploader checks its local prefix against them, and it resumes at the server's size.
  - The state file is missing or corrupt. A corrupt file is kept as `state.json.corrupt-<ms>`.
  - A file has no entry.
  - The server returns a 409 (a lost answer, a wiped spool, a second uploader).
  - A local file shrank.
- **Diverged**: the local file no longer matches what the server holds, for example because it was rewritten. It is reported and skipped, and never overwritten. It is checked again only when the file changes, so a restored original heals on its own.
- **Failed**: something about the file is refused (invalid UTF-8, or a 4xx). It is reported and skipped until the file changes. Every other file keeps flowing.
- **Pass failures never kill the loop.**
  - A transient failure (network, 408/429/5xx) backs off with doubling waits: 5 s, 10 s, 20 s, up to 5 min.
  - A 401/403 is `auth-error` and waits 5 min.
  - A pass that leaves a backlog runs again immediately.
- **Process failures** are handled by the supervisor (KeepAlive / Restart=always).
- **Single instance**: `uploader.lock` holds the pid. A lock left by a dead process is taken over.
- **Partial lines**: an unterminated last line is held until it is finished. If the file has not changed for 10 minutes, the line is sent as it is. A line longer than a chunk (4 MiB) is cut on a UTF-8 character boundary.

## status.json (for a tray or menu-bar helper)

`~/.learner/uploader/status.json` is rewritten atomically at the start and end of every pass. The schema is `UploaderStatus` in `src/uploader.ts`:

```json
{
  "version": 1, "clientId": "ben-mbp", "pid": 4242,
  "state": "ok | syncing | backoff | auth-error | error",
  "lastRunAt": "ISO", "lastSuccessAt": "ISO | null", "nextRunAt": "ISO | null",
  "files": 812, "pendingFiles": 0, "pendingBytes": 0,
  "uploadedBytes": 1048576, "healed": 0,
  "diverged": [{ "provider": "claude", "path": "...", "reason": "..." }],
  "failed": [{ "provider": "codex", "path": "...", "reason": "..." }],
  "skippedPaths": 0, "lastError": "string | null"
}
```

`uploadedBytes` and `healed` count from the start of the current process. A `pid` that is no longer alive, or a `nextRunAt` well in the past, means the uploader is not running. `--status` prints the file.
