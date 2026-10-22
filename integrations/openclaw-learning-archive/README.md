# OpenClaw Learning Archive adapter

This native observation plugin writes a private, durable local spool for the
BizTools Learning archive. It never dispatches messages, starts agents, or
modifies prompts/replies. Backend ingestion is intentionally separate.

Configure an absolute `spoolRoot` that does not overlap any
`approvedLocalRoots`, enable conversation access for the plugin, and link the
directory through OpenClaw's normal plugin install flow. Do not edit the live
configuration or restart the Gateway as part of repository validation.

The spool contains content-addressed original/staged media under `blobs/`,
immutable hook observations under `events/`, and durable OpenClaw
run-to-Discord-message links under `correlations/runs/`. A Discord user message
is canonical only when account, conversation, and original message IDs are all
present. Model and delivery observations remain occurrences linked by explicit
IDs; the adapter never merges them by text or by session alone.

When `message_received` omits a run ID, the Codex finalization hook can still
produce an exact handoff receipt. The adapter accepts only the single user
message whose native mirror identity is `<turnId>:prompt`, reads its preserved
transport message ID, and binds that provider ID to the hook's explicit run
and turn IDs. It never selects a message by matching text, timing, adjacency,
or latest-session state.

The bridge also writes a text-free `handoff_correlation` observation with the
same inbound logical message key and `user_to_model` direction. It is internal
and non-canonical (`stage=finalizing`, no parts), allowing the backend to merge
run and turn metadata onto the original received user message without creating
a second visible message.

Known fidelity limits are recorded as gaps rather than inferred away:

- OpenClaw `message_received.content` is normalized accepted-turn content, not
  raw Discord gateway bytes, and rejected/unmentioned messages are not emitted.
- Public Codex LLM hooks do not expose the native Codex thread ID. The finalize
  hook can expose a turn ID, but it is not guaranteed on every terminal path.
- `llm_input` exposes only an image count, not the exact image byte locators.
- Delivery hooks can omit run IDs, so concurrent outbound messages are never
  merged by session key alone.
- Observation hooks are not a durable OpenClaw outbox. A process crash before
  the plugin's atomic write can lose an event.

Remote retrieval is allowed only for exact HTTPS `cdn.discordapp.com` or
`media.discordapp.net` URLs already present in typed media facts. Retrieval
uses OpenClaw's `saveMediaSource`, retaining its SSRF, redirect, timeout, MIME,
and byte-limit enforcement. No arbitrary URL fetch is implemented.

Delivery capture follows OpenClaw's typed `ReplyPayload`: `mediaUrl` or
`mediaUrls` are transport locators, while aligned `attachments` contribute
media kind and MIME metadata. Attachment-only locators are retained with an
explicit not-routed gap. Local files, bounded base64 content parts, and base64
`data:` URLs become verified blobs; malformed or unsupported embedded shapes
become gaps. `audioAsVoice` and `videoAsNote` are presentation modes rather
than additional byte sources. `sensitiveMedia` is recorded as upstream
non-durable even when this explicitly configured archive can capture the
observed bytes.

With no plugin config, the spool defaults to
`~/.openclaw/learning-archive`, local reads are limited to OpenClaw's inbound
and outbound media directories, media capture is capped at 64 MiB, and each
JSON observation is capped at 16 MiB. Exceeding a bound writes an explicit gap;
it never silently claims complete fidelity.

`humanSenderIds` is an optional operator-confirmed allowlist of Discord sender
IDs. It is the only fallback human-authorship proof when the typed hook omits
bot/webhook flags; the plugin never derives this allowlist from broader channel
authorization settings. A successful `message_sent` is marked agent-authored
and delivered only when the same explicit run ID has a durable preceding
`reply_payload_sending(kind="final")` receipt. Its logical output identity still
uses the provider's delivered message ID, never the run or text hash.
