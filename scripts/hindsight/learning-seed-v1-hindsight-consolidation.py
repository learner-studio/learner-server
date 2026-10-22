#!/usr/bin/env python3
"""Feed frozen BizTools classifications to native Hindsight consolidation.

The adapter uses Hindsight chunks retention (zero extraction calls), explicit
run/concept observation scopes, and the native asynchronous consolidator. Raw
inputs and native outputs are private. It never assesses or mutates Learning
nodes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CANONICAL_PORT = 18_925
MODEL = "gpt-5.6-luna"
PROVIDER = "openai-codex"
EFFORT = "high"
DEFAULT_MAX_BATCH_TOKENS = 400_000
MODEL_CACHE = Path("/root/.codex/models_cache.json")
TERMINAL = {"completed", "failed", "cancelled"}
RELATIONSHIPS = {"mention", "task_context", "learner_evidence", "misconception"}
# The Hindsight install (see scripts/hindsight/runtime-lifetime.sh for the default and why it is a symlink).
HINDSIGHT_SRC = Path(os.environ.get("HINDSIGHT_INSTALL_ROOT", "/opt/learner-hindsight")) / "src"


class ContractError(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_native_retain_request(items: list[dict[str, Any]]) -> dict[str, str]:
    """Validate against the exact installed HTTP request model without an API call."""
    try:
        from hindsight_api.api.http import RetainRequest
        from pydantic import ValidationError
    except ImportError as error:
        raise ContractError("Installed Hindsight RetainRequest model is unavailable") from error
    payload = {"items": items, "async": False}
    try:
        RetainRequest.model_validate(payload)
    except ValidationError as error:
        raise ContractError(f"Installed Hindsight RetainRequest rejected feed: {error}") from error
    return {
        "model": f"{RetainRequest.__module__}.{RetainRequest.__name__}",
        "jsonSchemaSha256": hashlib.sha256(canonical(RetainRequest.model_json_schema()).encode()).hexdigest(),
        "payloadSha256": digest(payload),
    }


def private_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)


def validate_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise ContractError("Hindsight URL must be loopback HTTP")
    if parsed.port in {None, CANONICAL_PORT}:
        raise ContractError("Refusing missing or canonical archive port 18925")
    return value.rstrip("/")


def request(base: str, method: str, path: str, body: Any | None = None, timeout: float = 60) -> dict[str, Any]:
    data = None if body is None else canonical(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    started = time.monotonic_ns()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return {"status": response.status, "body": json.loads(raw) if raw else None,
                    "durationMs": round((time.monotonic_ns() - started) / 1e6, 3)}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise ContractError(f"Hindsight {method} {path} failed HTTP {error.code}: {detail[:1000]}") from error


def request_text(base: str, path: str) -> str:
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return response.read().decode(errors="replace")


def metric_value(text: str, metric: str, labels: dict[str, str]) -> float:
    pattern = re.compile(rf"^{re.escape(metric)}(?:_total)?(?:\{{([^}}]*)\}})?\s+([0-9.eE+-]+)$")
    total = 0.0
    for line in text.splitlines():
        match = pattern.match(line.strip())
        if not match:
            continue
        actual = dict(re.findall(r'(\w+)="([^"]*)"', match.group(1) or ""))
        if all(actual.get(key) == value for key, value in labels.items()):
            total += float(match.group(2))
    return total


def metric_snapshot(text: str, scope: str) -> dict[str, float]:
    labels = {"provider": PROVIDER, "model": MODEL, "scope": scope}
    return {
        "calls": metric_value(text, "hindsight_llm_calls_total", labels),
        "inputTokens": metric_value(text, "hindsight_llm_tokens_input", labels),
        "outputTokens": metric_value(text, "hindsight_llm_tokens_output", labels),
        "cachedInputTokens": metric_value(text, "hindsight_llm_tokens_cached_input", labels),
        "thoughtTokens": metric_value(text, "hindsight_llm_tokens_thoughts", labels),
        "durationSeconds": metric_value(text, "hindsight_llm_duration_seconds_sum", labels),
        "durationSamples": metric_value(text, "hindsight_llm_duration_seconds_count", labels),
    }


def runtime_contract(port: int) -> dict[str, Any]:
    matches = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            environ = {part.partition(b"=")[0].decode(): part.partition(b"=")[2].decode()
                       for part in (proc / "environ").read_bytes().split(b"\0") if b"=" in part}
            command = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if environ.get("HINDSIGHT_API_PORT") == str(port) and "hindsight_api.main" in command:
            matches.append((int(proc.name), environ))
    if len(matches) != 1:
        raise ContractError(f"Expected one isolated Hindsight process on port {port}; found {len(matches)}")
    pid, env = matches[0]
    expected = {
        "HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER": PROVIDER,
        "HINDSIGHT_API_CONSOLIDATION_LLM_MODEL": MODEL,
        "HINDSIGHT_API_CONSOLIDATION_LLM_REASONING_EFFORT": EFFORT,
        "HINDSIGHT_API_CONSOLIDATION_LLM_MAX_RETRIES": "0",
        "HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT": "420",
        "HINDSIGHT_API_CONSOLIDATION_MAX_ATTEMPTS": "1",
        "HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS": "64000",
        "HINDSIGHT_API_LLM_TIMEOUT": "420",
        "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true",
        "HINDSIGHT_API_LLM_TRACE_ENABLED": "true",
        "HINDSIGHT_API_REFLECT_LLM_PROVIDER": "none",
    }
    mismatch = {key: {"expected": value, "actual": env.get(key)} for key, value in expected.items()
                if env.get(key) != value}
    if mismatch:
        raise ContractError(f"Isolated consolidation runtime mismatch: {canonical(mismatch)}")
    return {"pid": pid, "source": "isolated-process-environment", "verified": expected}


def native_budget(prepared: "Prepared", max_batch_tokens: int) -> dict[str, Any]:
    if len(prepared.items) != 1 or len(prepared.scopes) != 1:
        raise ContractError("Paid proof requires exactly one native feed item and one observation scope")
    try:
        from hindsight_api.engine.consolidation.consolidator import (
            _build_response_model,
            build_consolidation_input,
            build_consolidation_system_prompt,
        )
        from hindsight_api.engine.token_encoding import count_tokens
    except ImportError as error:
        raise ContractError("Installed native Hindsight prompt/schema builders unavailable") from error
    cache = json.loads(MODEL_CACHE.read_text())
    model = next((item for item in cache.get("models", []) if item.get("slug") == MODEL), None)
    if not isinstance(model, dict) or not isinstance(model.get("context_window"), int):
        raise ContractError(f"No local context metadata for {MODEL}")
    if EFFORT not in {item.get("effort") for item in model.get("supported_reasoning_levels", [])}:
        raise ContractError(f"Local model metadata does not support effort={EFFORT}")
    # Native first-pass prompt with a fixed-width UUID standing in for the
    # source memory ID assigned at feed time. The exact content and mission are
    # otherwise identical to the call Hindsight builds for the fresh bank.
    facts_text = f"[00000000-0000-0000-0000-000000000000] {prepared.items[0]['content']}"
    system_prompt = build_consolidation_system_prompt(llm_output_language=None)
    user_prompt = build_consolidation_input(
        facts_text=facts_text, observations_text="[]", observations_mission=MISSION,
        observation_capacity_note=None,
    )
    schema = _build_response_model(max_creates=5, supports_max_items=True).model_json_schema()
    schema_json = canonical(schema)
    framing = 1_024
    estimated = count_tokens(system_prompt) + count_tokens(user_prompt) + count_tokens(schema_json) + framing
    context = model["context_window"]
    effective_context = math.floor(context * 0.95)
    output_reserve = 64_000
    effective_input = min(max_batch_tokens, effective_context - output_reserve)
    if estimated > effective_input:
        raise ContractError(f"Native consolidation estimate {estimated} exceeds effective input ceiling {effective_input}")
    return {
        "plannedNativeBatches": 1,
        "plannedNativeCalls": 1,
        "adaptiveBisectionPossible": False,
        "reason": "one source memory cannot be bisected",
        "contentCharacters": len(prepared.items[0]["content"]),
        "systemPromptTokens": count_tokens(system_prompt),
        "userPromptTokens": count_tokens(user_prompt),
        "nativeSchemaTokens": count_tokens(schema_json),
        "providerFramingAllowanceTokens": framing,
        "estimatedInputTokens": estimated,
        "requestedInputCeilingTokens": max_batch_tokens,
        "contextWindowTokens": context,
        "effectiveContextTokens": effective_context,
        "reservedOutputReasoningTokens": output_reserve,
        "effectiveInputCeilingTokens": effective_input,
        "nativeHashes": {
            "systemPromptSha256": hashlib.sha256(system_prompt.encode()).hexdigest(),
            "userPromptWithPlaceholderIdSha256": hashlib.sha256(user_prompt.encode()).hexdigest(),
            "responseSchemaSha256": hashlib.sha256(schema_json.encode()).hexdigest(),
        },
    }


@dataclass(frozen=True)
class Prepared:
    run_id: str
    input_digest: str
    bank_id: str
    experiment_tag: str
    items: list[dict[str, Any]]
    mappings: dict[str, dict[str, str]]
    scopes: list[list[str]]
    prior_state_markers: list[str]


def _text(message: dict[str, Any]) -> str:
    value = message.get("text", message.get("content"))
    if not isinstance(value, str) or not value:
        raise ContractError("Source messages require nonempty text/content")
    return value


def prepare(path: Path) -> Prepared:
    value = json.loads(path.read_text())
    run_id = value.get("runId")
    cases = value.get("cases")
    node_states = value.get("nodeStates")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9-]+", run_id):
        raise ContractError("runId must be alphanumeric/hyphen")
    if not isinstance(cases, list) or not cases:
        raise ContractError("classification handoff requires ordered cases")
    if not isinstance(node_states, list):
        raise ContractError("classification handoff requires frozen nodeStates")
    input_digest = digest(value)
    bank_id = f"learning-three-step-{input_digest[:20]}"
    experiment_tag = f"bt-exp:{run_id}"
    items: list[dict[str, Any]] = []
    mappings: dict[str, dict[str, str]] = {}
    scopes: set[tuple[str, str]] = set()
    seen: set[tuple[str, str]] = set()
    for case in cases:
        case_id = case.get("caseId")
        current, response = case.get("current"), case.get("response")
        classification = case.get("classification", {})
        matches = classification.get("matches", []) if isinstance(classification, dict) else None
        if not isinstance(case_id, str) or not isinstance(current, dict) or not isinstance(response, dict):
            raise ContractError("Every case requires caseId/current/response")
        if current.get("role") != "user" or response.get("role") != "assistant" or not isinstance(matches, list):
            raise ContractError(f"Invalid roles or matches for {case_id}")
        current_text = _text(current)
        _text(response)  # validate presence, but never feed assistant text as evidence
        for match in matches:
            if not isinstance(match, dict):
                raise ContractError(f"Non-object match for {case_id}")
            concept_id, quote = match.get("conceptId"), match.get("quote")
            relationship = match.get("relationship")
            if not isinstance(concept_id, str) or not concept_id or not isinstance(quote, str) or quote not in current_text:
                raise ContractError(f"Unknown concept or non-exact human quote for {case_id}")
            if relationship not in RELATIONSHIPS:
                raise ContractError(f"Invalid relationship for {case_id}/{concept_id}")
            evidence_kind, assessment = match.get("evidenceKind"), match.get("assessment")
            invalid_combo = (
                relationship in {"mention", "task_context"}
                and (evidence_kind != "insufficient" or assessment != "indeterminate")
            ) or (
                relationship == "learner_evidence"
                and (evidence_kind in {None, "insufficient", "misconception"}
                     or assessment not in {"supports", "partially_supports"})
            ) or (
                relationship == "misconception"
                and (evidence_kind != "misconception" or assessment != "contradicts")
            )
            if invalid_combo:
                raise ContractError(f"Invalid evidence classification for {case_id}/{concept_id}")
            identity = (case_id, concept_id)
            if identity in seen:
                raise ContractError(f"Duplicate case/concept match: {case_id}/{concept_id}")
            seen.add(identity)
            concept_tag = f"bt-concept:{concept_id}"
            source_tag = f"bt-source:{case_id}"
            document_id = f"bt-three-step:{run_id}:{case_id}:{concept_id}"
            source = {
                "caseId": case_id,
                "conceptId": concept_id,
                "humanSourceId": str(current.get("id", "")),
                "assistantSourceId": str(response.get("id", "")),
                "quote": quote,
                "relationship": relationship,
                "evidenceKind": match.get("evidenceKind"),
                "assessment": match.get("assessment"),
                "reason": match.get("reason"),
                "classificationRevision": value.get("classificationRevision"),
            }
            content = "PROVISIONAL CLASSIFICATION EVIDENCE; NOT A MASTERY ASSESSMENT\n" + canonical(source)
            tags = [experiment_tag, concept_tag, "bt-stage:classified", source_tag]
            items.append({
                "content": content,
                "context": "BizTools frozen human-message classification; assistant source is lineage only.",
                "document_id": document_id,
                "metadata": {"handoffDigest": input_digest, **source},
                "tags": tags,
                "observation_scopes": [[experiment_tag, concept_tag]],
                "update_mode": "replace",
            })
            mappings[document_id] = {key: str(source.get(key, "")) for key in (
                "caseId", "conceptId", "humanSourceId", "assistantSourceId", "classificationRevision"
            )}
            scopes.add((experiment_tag, concept_tag))
    matched_concepts = {scope[1].removeprefix("bt-concept:") for scope in scopes}
    state_by_concept: dict[str, dict[str, Any]] = {}
    for state in node_states:
        if not isinstance(state, dict) or not isinstance(state.get("conceptId"), str):
            raise ContractError("Every prior node state requires conceptId")
        concept_id = state["conceptId"]
        if concept_id in state_by_concept:
            raise ContractError(f"Duplicate prior node state for {concept_id}")
        state_by_concept[concept_id] = state
    missing_states = sorted(matched_concepts - set(state_by_concept))
    if missing_states:
        raise ContractError(f"Missing frozen prior node state for: {missing_states}")
    prior_state_markers: list[str] = []
    for concept_id in sorted(matched_concepts):
        state = state_by_concept[concept_id]
        marker = f"PRIOR NODE ASSESSMENT; NOT NEW HUMAN EVIDENCE; concept={concept_id}; digest={digest(state)}"
        prior_state_markers.append(marker)
        document_id = f"bt-three-step:{run_id}:prior-node:{concept_id}"
        concept_tag = f"bt-concept:{concept_id}"
        items.append({
            "content": marker + "\n" + canonical(state),
            "context": "Frozen pre-run node state supplied as prior assessment, not learner evidence.",
            "document_id": document_id,
            "metadata": {"handoffDigest": input_digest, "recordKind": "prior_assessment",
                         "conceptId": concept_id, "nodeStateDigest": digest(state)},
            "tags": [experiment_tag, concept_tag, "bt-stage:prior-assessment"],
            "observation_scopes": [[experiment_tag, concept_tag]],
            "update_mode": "replace",
        })
        mappings[document_id] = {"recordKind": "prior_assessment", "conceptId": concept_id,
                                 "nodeStateDigest": digest(state)}
    # A single native chunks-mode source fact is deliberate. Hindsight's
    # consolidator adaptively bisects failed multi-memory batches even when its
    # configured retry counts are zero. A one-memory feed cannot fan out that
    # way, so this proof remains exactly one native consolidation attempt while
    # preserving every case/concept/source record inside structured content.
    classification_records = [
        {"recordKind": "classification_evidence", **item["metadata"]}
        for item in items if item["metadata"].get("recordKind") != "prior_assessment"
    ]
    prior_records = [
        {"recordKind": "prior_assessment", "marker": item["content"].split("\n", 1)[0],
         "state": state_by_concept[item["metadata"]["conceptId"]]}
        for item in items if item["metadata"].get("recordKind") == "prior_assessment"
    ]
    if not classification_records:
        return Prepared(run_id, input_digest, bank_id, experiment_tag, [], {}, [], [])
    feed_content = canonical({
        "warning": "PROVISIONAL CLASSIFICATION EVIDENCE AND PRIOR ASSESSMENTS; NOT A MASTERY ASSESSMENT",
        "classificationEvidence": classification_records,
        "priorNodeAssessments": prior_records,
    })
    feed_document_id = f"bt-three-step:{run_id}:feed:{hashlib.sha256(feed_content.encode()).hexdigest()[:20]}"
    concept_tags = [f"bt-concept:{concept_id}" for concept_id in sorted(matched_concepts)]
    single_item = {
        "content": feed_content,
        "context": "Frozen BizTools classifications and prior node state; assistant IDs are lineage only.",
        "document_id": feed_document_id,
        "metadata": {"handoffDigest": input_digest, "recordKind": "three_step_feed",
                     "classificationCount": str(len(classification_records)),
                     "priorNodeStateCount": str(len(prior_records))},
        "tags": [experiment_tag, "bt-stage:classified-feed", *concept_tags],
        "observation_scopes": [[experiment_tag]],
        "update_mode": "replace",
    }
    feed_mapping = {feed_document_id: {
        "recordKind": "three_step_feed", "handoffDigest": input_digest,
        "classificationCount": str(len(classification_records)),
        "priorNodeStateCount": str(len(prior_records)),
    }}
    return Prepared(run_id, input_digest, bank_id, experiment_tag, [single_item], feed_mapping,
                    [[experiment_tag]] if classification_records else [], prior_state_markers)


MISSION = """Consolidate only the supplied provisional human-message classification evidence.
All records share one experiment scope to guarantee one native call. Organize observations by
the exact conceptId inside each record and include every supporting caseId and humanSourceId in
observation text; native source_memory_ids identify the bundled feed and are not case-level proof.
Preserve material contradictions, corrections, source identifiers, and evidence limitations.
Assistant source identifiers are lineage only: never infer the learner's ability from assistant
activity. Do not assign mastery, promote a learner, discover new concepts, or turn task requests
into demonstrated understanding."""


def configure(base: str, prepared: Prepared) -> dict[str, Any]:
    create = request(base, "PUT", f"/v1/default/banks/{prepared.bank_id}", {})
    updates = {
        "retain_extraction_mode": "chunks",
        "retain_chunk_size": 60_000,
        "retain_structured_chunk_size": 60_000,
        "enable_observations": True,
        "enable_auto_consolidation": False,
        "observations_mission": MISSION,
        "consolidation_llm_batch_size": 100,
        "consolidation_llm_parallelism": 1,
        "max_observations_per_scope": 5,
    }
    patch = request(base, "PATCH", f"/v1/default/banks/{prepared.bank_id}/config", {"updates": updates})
    read = request(base, "GET", f"/v1/default/banks/{prepared.bank_id}/config")
    actual = read["body"].get("config", {})
    mismatch = {key: {"expected": expected, "actual": actual.get(key)} for key, expected in updates.items()
                if actual.get(key) != expected}
    if mismatch:
        raise ContractError(f"Resolved bank config mismatch: {canonical(mismatch)}")
    return {"create": create, "patch": patch, "read": read, "expected": updates}


def preflight(base: str, prepared: Prepared, max_batch_tokens: int) -> dict[str, Any]:
    started = time.monotonic_ns()
    runtime = runtime_contract(urllib.parse.urlparse(base).port or 0)
    budget = native_budget(prepared, max_batch_tokens)
    config = configure(base, prepared)
    metrics = request_text(base, "/metrics")
    verification_calls = metric_value(metrics, "hindsight_llm_calls_total", {
        "provider": PROVIDER, "model": MODEL, "scope": "verification"
    })
    if verification_calls:
        raise ContractError(f"Runtime contains {verification_calls:g} startup verification call(s)")
    prior_calls = {scope: metric_snapshot(metrics, scope)["calls"]
                   for scope in ("consolidation", "consolidation_dedup")}
    if any(prior_calls.values()):
        raise ContractError(f"Runtime already contains consolidation calls: {canonical(prior_calls)}")
    existing_sources = list_all(base, prepared.bank_id, "world")
    existing_observations = list_all(base, prepared.bank_id, "observation")
    if existing_sources["body"].get("items") or existing_observations["body"].get("items"):
        raise ContractError("Proof bank is not empty; refusing hidden update/dedup fanout")
    max_source_characters = max((len(item["content"]) for item in prepared.items), default=0)
    max_source_utf8_bytes = max((len(item["content"].encode()) for item in prepared.items), default=0)
    if max_source_characters >= 60_000:
        raise ContractError("A feed item would fan out into multiple native chunks")
    native_request_validation = validate_native_retain_request(prepared.items)
    return {
        "terminalState": "ready", "zeroModelCalls": True, "runId": prepared.run_id,
        "inputDigest": prepared.input_digest, "bankId": prepared.bank_id,
        "feed": {"itemCount": len(prepared.items), "maxItemCharacters": max_source_characters,
                 "maxItemUtf8Bytes": max_source_utf8_bytes, "nativeChunkSizeCharacters": 60_000,
                 "documentIds": [item["document_id"] for item in prepared.items],
                 "nativeRequestValidation": native_request_validation},
        "scopes": prepared.scopes, "expectedConsolidationBatchUpperBound": 1,
        "budget": budget,
        "lineage": {
            "nativeGranularity": "bundled-feed-source-memory",
            "recordIdentifiersInPrompt": ["conceptId", "caseId", "humanSourceId"],
            "assessmentMustRereadFrozenEvidence": True,
        },
        "effective": {"provider": PROVIDER, "model": MODEL, "effort": EFFORT,
                      "providerRetries": 0, "outerAttempts": 1, "startupVerificationSkipped": True},
        "config": config, "runtime": runtime, "zeroCallBaseline": prior_calls,
        "freshBank": {"sourceFacts": 0, "observations": 0},
        "timing": {"preflightMs": round((time.monotonic_ns() - started) / 1e6, 3)},
        "privacy": {"canonicalArchiveTouched": False, "nodeOrMasteryMutations": 0},
    }


def list_all(base: str, bank: str, fact_type: str) -> dict[str, Any]:
    return request(base, "GET", f"/v1/default/banks/{bank}/memories/list?type={fact_type}&limit=10000")


def run(
    base: str,
    prepared: Prepared,
    receipt: dict[str, Any],
    poll_seconds: int,
    checkpoint_path: Path,
    resume_checkpoint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    phases: dict[str, float]
    started = time.monotonic_ns()
    if resume_checkpoint is not None:
        native_checkpoint = resume_checkpoint.get("native") or {}
        feed, sources, trigger = (native_checkpoint.get(key) for key in ("feed", "sourceFacts", "trigger"))
        if not all(isinstance(item, dict) for item in (feed, sources, trigger)):
            raise ContractError("Pending checkpoint is missing native feed/source/trigger receipts")
        metric_snapshots_before = resume_checkpoint.get("metricSnapshotsBefore")
        if not isinstance(metric_snapshots_before, dict):
            raise ContractError("Pending checkpoint is missing metric baseline")
        phases = dict(resume_checkpoint.get("timing") or {})
    else:
        validate_native_retain_request(prepared.items)
        metrics_before = request_text(base, "/metrics")
        metric_snapshots_before = {scope: metric_snapshot(metrics_before, scope)
                                   for scope in ("consolidation", "consolidation_dedup")}
        phases = {}
        feed_started = time.monotonic_ns()
        feed = request(base, "POST", f"/v1/default/banks/{prepared.bank_id}/memories",
                       {"items": prepared.items, "async": False}, timeout=900)
        phases["feedMs"] = round((time.monotonic_ns() - feed_started) / 1e6, 3)
        if (feed["body"].get("usage") or {}).get("total_tokens", 0) != 0:
            raise ContractError("Chunks-mode feed unexpectedly reported extraction tokens")
        sources = list_all(base, prepared.bank_id, "world")
        source_items = sources["body"].get("items", [])
        if len(source_items) != len(prepared.items):
            raise ContractError(f"Feed readback count {len(source_items)} != {len(prepared.items)}")
        trigger_started = time.monotonic_ns()
        trigger = request(base, "POST", f"/v1/default/banks/{prepared.bank_id}/consolidate",
                          {"observation_scopes": prepared.scopes})
        phases["triggerMs"] = round((time.monotonic_ns() - trigger_started) / 1e6, 3)
        operation_id = trigger["body"].get("operation_id")
        if not isinstance(operation_id, str):
            raise ContractError("Native consolidate response omitted operation_id")
        private_write(checkpoint_path, {
            "terminalState": "pending", "inputDigest": prepared.input_digest,
            "bankId": prepared.bank_id, "operationId": operation_id,
            "preflight": receipt, "native": {"feed": feed, "sourceFacts": sources, "trigger": trigger},
            "metricSnapshotsBefore": metric_snapshots_before, "timing": phases,
            "recovery": {"mode": "poll-only", "mustNotFeedOrTriggerAgain": True},
        })
    source_items = sources["body"].get("items", [])
    operation_id = trigger["body"].get("operation_id")
    if not isinstance(operation_id, str):
        raise ContractError("Pending native receipt omitted operation_id")
    deadline = time.monotonic() + poll_seconds
    polls: list[dict[str, Any]] = []
    while True:
        status = request(base, "GET", f"/v1/default/banks/{prepared.bank_id}/operations/{operation_id}")
        polls.append(status)
        state = status["body"].get("status")
        if state in TERMINAL:
            break
        if time.monotonic() >= deadline:
            raise ContractError(f"Consolidation operation {operation_id} did not finish within {poll_seconds}s")
        time.sleep(1)
    observations = list_all(base, prepared.bank_id, "observation")
    traces = request(
        base, "GET",
        f"/v1/default/banks/{prepared.bank_id}/llm-requests?operation=consolidation&limit=500",
    )
    metrics_after = request_text(base, "/metrics")
    snapshots = {}
    for scope in ("consolidation", "consolidation_dedup"):
        before, after = metric_snapshots_before[scope], metric_snapshot(metrics_after, scope)
        snapshots[scope] = {"before": before, "after": after,
                            "delta": {key: after[key] - before[key] for key in before}}
    allowed_scopes = {tuple(scope) for scope in prepared.scopes}
    invalid = []
    if snapshots["consolidation"]["delta"]["calls"] != 1:
        invalid.append({"reason": "native-consolidation-call-count-not-one",
                        "actual": snapshots["consolidation"]["delta"]["calls"]})
    if snapshots["consolidation_dedup"]["delta"]["calls"] != 0:
        invalid.append({"reason": "unexpected-native-dedup-fanout",
                        "actual": snapshots["consolidation_dedup"]["delta"]["calls"]})
    source_fact_mappings: dict[str, dict[str, str]] = {}
    allowed_source_ids: set[str] = set()
    for source in source_items:
        source_id, document_id = str(source.get("id", "")), source.get("document_id")
        if source_id:
            allowed_source_ids.add(source_id)
        if source_id and isinstance(document_id, str) and document_id in prepared.mappings:
            source_fact_mappings[source_id] = prepared.mappings[document_id]
    for observation in observations["body"].get("items", []):
        if tuple(sorted(observation.get("tags") or [])) not in {tuple(sorted(scope)) for scope in allowed_scopes}:
            invalid.append({"id": observation.get("id"), "reason": "foreign-observation-scope"})
        foreign_sources = sorted(set(map(str, observation.get("source_memory_ids") or [])) - allowed_source_ids)
        if foreign_sources:
            invalid.append({"id": observation.get("id"), "reason": "foreign-source-fact-ids",
                            "sourceFactIds": foreign_sources})
    trace_inputs = canonical([item.get("input") for item in traces["body"].get("items", [])])
    missing_prior_state = [marker for marker in prepared.prior_state_markers if marker not in trace_inputs]
    if missing_prior_state:
        invalid.append({"reason": "prior-node-state-not-present-in-native-prompt",
                        "missingMarkerDigests": [hashlib.sha256(marker.encode()).hexdigest()
                                                 for marker in missing_prior_state]})
    state = polls[-1]["body"].get("status")
    terminal = "success" if state == "completed" and not invalid else "failed"
    return {
        "terminalState": terminal, "error": None if terminal == "success" else "native operation or validation failed",
        "preflight": receipt, "native": {"feed": feed, "sourceFacts": sources,
            "trigger": trigger, "operationPolls": polls, "observations": observations,
            "llmRequestTraces": traces},
        "adapted": {"conceptScopes": prepared.scopes, "documentMappings": prepared.mappings,
                    "sourceFactMappings": source_fact_mappings,
                    "priorNodeStatePromptProof": {
                        "expectedMarkerCount": len(prepared.prior_state_markers),
                        "missingMarkerCount": len(missing_prior_state),
                        "nativeTraceInputSha256": hashlib.sha256(trace_inputs.encode()).hexdigest(),
                    },
                    "validationFailures": invalid, "assessment": None,
                    "semanticContradictionReview": "deferred-to-node-assessment",
                    "nativeLineageGranularity": "bundled-feed-source-memory",
                    "assessmentSourceRequirement":
                        "Verify each proposed caseId/humanSourceId against the frozen original evidence; "
                        "do not treat feed-level native source_memory_ids as individual proof."},
        "metrics": snapshots, "timing": {**phases, "totalMs": round((time.monotonic_ns() - started) / 1e6, 3)},
        "effective": receipt["effective"],
        "privacy": {"canonicalArchiveTouched": False, "nodeOrMasteryMutations": 0},
    }


def reconcile_truncated_trace(prepared: Prepared, raw_path: Path) -> dict[str, Any]:
    """Reconcile the installed recorder's 50k preview without another native call."""
    raw_bytes = raw_path.read_bytes()
    raw = json.loads(raw_bytes)
    failures = (raw.get("adapted") or {}).get("validationFailures")
    if raw.get("terminalState") != "failed" or not isinstance(failures, list) or len(failures) != 1 \
            or failures[0].get("reason") != "prior-node-state-not-present-in-native-prompt":
        raise ContractError("Raw receipt is not the exact trace-truncation-only failure")
    if (raw.get("preflight") or {}).get("inputDigest") != prepared.input_digest:
        raise ContractError("Raw receipt belongs to a different frozen input")
    native = raw.get("native") or {}
    source_items = (((native.get("sourceFacts") or {}).get("body") or {}).get("items") or [])
    trace_items = (((native.get("llmRequestTraces") or {}).get("body") or {}).get("items") or [])
    if len(source_items) != 1 or len(trace_items) != 1:
        raise ContractError("Reconciliation requires exactly one native source and one LLM trace")
    source, trace = source_items[0], trace_items[0]
    if source.get("document_id") != prepared.items[0]["document_id"] or source.get("text") != prepared.items[0]["content"]:
        raise ContractError("Persisted native source does not equal the frozen bundled feed")
    if trace.get("status") != "success" or trace.get("operation") != "consolidation" \
            or trace.get("provider") != PROVIDER or trace.get("model") != MODEL:
        raise ContractError("Trace is not the one successful configured consolidation call")
    source_id = str(source.get("id", ""))
    if (trace.get("metadata") or {}).get("source_memory_ids") != [source_id]:
        raise ContractError("Trace source lineage does not equal the bundled native source")
    stored_input = trace.get("input") or {}
    if stored_input.get("_truncated") is not True or not isinstance(stored_input.get("preview"), str) \
            or not isinstance(stored_input.get("_original_chars"), int):
        raise ContractError("Trace is not an installed-recorder truncated-input envelope")
    try:
        from hindsight_api.engine.consolidation.consolidator import (
            build_consolidation_input,
            build_consolidation_system_prompt,
        )
    except ImportError as error:
        raise ContractError("Installed native Hindsight prompt builders unavailable") from error
    fact_line = f"[{source_id}] {source['text']}"
    temporal = [f"{key}={source[key]}" for key in ("occurred_start", "occurred_end", "mentioned_at")
                if source.get(key)]
    if temporal:
        fact_line += f" ({', '.join(temporal)})"
    messages = [
        {"role": "system", "content": build_consolidation_system_prompt(llm_output_language=None)},
        {"role": "user", "content": build_consolidation_input(
            facts_text=fact_line, observations_text="[]", observations_mission=MISSION,
            observation_capacity_note=None,
        )},
    ]
    serialized = json.dumps(messages)
    preview = stored_input["preview"]
    if stored_input["_original_chars"] != len(serialized) or preview != serialized[:len(preview)]:
        raise ContractError("Persisted trace preview/length do not match the exact reconstructed native request")
    missing = [marker for marker in prepared.prior_state_markers if marker not in serialized]
    if missing:
        raise ContractError("Reconstructed installed native request is missing frozen prior-state markers")
    metrics = raw.get("metrics") or {}
    if ((metrics.get("consolidation") or {}).get("delta") or {}).get("calls") != 1 \
            or ((metrics.get("consolidation_dedup") or {}).get("delta") or {}).get("calls") != 0:
        raise ContractError("Raw receipt does not prove exactly one native call and zero dedup calls")
    adapted = dict(raw.get("adapted") or {})
    installed_sources = {
        "prompts.py": (HINDSIGHT_SRC / "hindsight_api/engine/consolidation/prompts.py"),
        "consolidator.py": (HINDSIGHT_SRC / "hindsight_api/engine/consolidation/consolidator.py"),
        "llm_trace.py": (HINDSIGHT_SRC / "hindsight_api/engine/llm_trace.py"),
    }
    if any(not path.is_file() for path in installed_sources.values()):
        raise ContractError("Installed Hindsight source provenance files are unavailable")
    from importlib.metadata import version
    adapted["validationFailures"] = []
    adapted["priorNodeStatePromptProof"] = {
        "expectedMarkerCount": len(prepared.prior_state_markers), "missingMarkerCount": 0,
        "proofKind": "installed-builder-reconstruction-bound-to-trace-prefix-and-original-length",
        "fullPromptDirectlyObserved": False,
        "traceId": trace.get("trace_id"), "tracePreviewCharacters": len(preview),
        "traceOriginalCharacters": stored_input["_original_chars"],
        "reconstructedInputSha256": hashlib.sha256(serialized.encode()).hexdigest(),
        "tracePreviewSha256": hashlib.sha256(preview.encode()).hexdigest(),
        "sourceFactId": source_id, "sourceDocumentId": source.get("document_id"),
        "sourceFactTextSha256": hashlib.sha256(source["text"].encode()).hexdigest(),
        "sourceFactEnvelopeSha256": digest(source),
        "preparedFeedTextSha256": hashlib.sha256(prepared.items[0]["content"].encode()).hexdigest(),
        "installedHindsight": {
            "distribution": "hindsight-api-slim", "version": version("hindsight-api-slim"),
            "sourceSha256": {name: hashlib.sha256(path.read_bytes()).hexdigest()
                             for name, path in installed_sources.items()},
        },
    }
    return {
        **raw, "terminalState": "success", "error": None, "adapted": adapted,
        "reconciliation": {
            "revision": "hindsight-truncated-trace-v1", "zeroModelCalls": True,
            "sourceRawPath": str(raw_path), "sourceRawSha256": hashlib.sha256(raw_bytes).hexdigest(),
            "originalTerminalState": "failed", "originalValidationFailures": failures,
            "limitation": "The native trace stores only a 50,000-character preview. Full-prompt proof is a "
                          "deterministic reconstruction using the exact installed prompt builder, persisted source "
                          "fact, exact preview prefix, and recorder-reported original serialized length.",
        },
    }


def cleanup_preview(base: str, prepared: Prepared) -> dict[str, Any]:
    observations = list_all(base, prepared.bank_id, "observation")
    items = observations["body"].get("items", [])
    allowed = {tuple(sorted(scope)) for scope in prepared.scopes}
    targets = sorted([{"id": str(item.get("id")), "tags": sorted(item.get("tags") or [])} for item in items],
                     key=lambda item: item["id"])
    if any(tuple(item["tags"]) not in allowed or prepared.experiment_tag not in item["tags"] for item in targets):
        raise ContractError("Cleanup preview found a foreign observation; refusing bank-wide observation clear")
    body = {"bankId": prepared.bank_id, "inputDigest": prepared.input_digest,
            "experimentTag": prepared.experiment_tag, "targets": targets,
            "feedDocumentsPreserved": [item["document_id"] for item in prepared.items]}
    return {**body, "previewDigest": digest(body), "terminalState": "previewed", "zeroModelCalls": True}


def cleanup_apply(base: str, prepared: Prepared, preview_path: Path, expected_digest: str) -> dict[str, Any]:
    saved = json.loads(preview_path.read_text())
    fresh = cleanup_preview(base, prepared)
    if saved.get("previewDigest") != expected_digest or fresh["previewDigest"] != expected_digest:
        raise ContractError("Cleanup preview digest missing, stale, or mismatched")
    deleted = request(base, "DELETE", f"/v1/default/banks/{prepared.bank_id}/observations")
    remaining = list_all(base, prepared.bank_id, "observation")
    if remaining["body"].get("items"):
        raise ContractError("Observation cleanup did not reach zero")
    return {"terminalState": "cleaned", "previewDigest": expected_digest, "native": deleted,
            "remainingObservations": 0, "feedDocumentsPreserved": fresh["feedDocumentsPreserved"],
            "zeroModelCalls": True, "canonicalArchiveTouched": False}


def completed_matches(path: Path, prepared: Prepared) -> bool:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return value.get("terminalState") == "success" and value.get("preflight", {}).get("inputDigest") == prepared.input_digest


def pending_checkpoint(path: Path, prepared: Prepared) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if value.get("terminalState") != "pending":
        return None
    if value.get("inputDigest") != prepared.input_digest or value.get("bankId") != prepared.bank_id:
        raise ContractError("Pending checkpoint belongs to a different frozen input or bank")
    if value.get("recovery") != {"mode": "poll-only", "mustNotFeedOrTriggerAgain": True}:
        raise ContractError("Pending checkpoint lacks fail-closed poll-only recovery contract")
    return value


def preserve_pending_error(path: Path, error: Exception) -> bool:
    """Keep an acknowledged native operation resumable after a local/polling failure."""
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if value.get("terminalState") != "pending":
        return False
    recovery = value.get("recovery")
    if recovery != {"mode": "poll-only", "mustNotFeedOrTriggerAgain": True}:
        return False
    value["lastPollError"] = f"{type(error).__name__}: {error}"
    value["lastPollErrorAt"] = datetime.now(timezone.utc).isoformat()
    private_write(path, value)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:18923")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--cleanup-preview", action="store_true")
    parser.add_argument("--cleanup-apply", type=Path)
    parser.add_argument("--reconcile-truncated-trace", type=Path)
    parser.add_argument("--confirm-preview-digest")
    parser.add_argument("--poll-seconds", type=int, default=900)
    parser.add_argument("--max-batch-tokens", type=int, default=DEFAULT_MAX_BATCH_TOKENS)
    args = parser.parse_args(argv)
    try:
        if args.max_batch_tokens < 1 or args.max_batch_tokens > DEFAULT_MAX_BATCH_TOKENS:
            raise ContractError("--max-batch-tokens must be between 1 and 400000")
        base, prepared = validate_url(args.base_url), prepare(args.input)
        if args.reconcile_truncated_trace:
            result = reconcile_truncated_trace(prepared, args.reconcile_truncated_trace)
        elif args.cleanup_preview:
            result = cleanup_preview(base, prepared)
        elif args.cleanup_apply:
            if not args.confirm_preview_digest:
                raise ContractError("--cleanup-apply requires --confirm-preview-digest")
            result = cleanup_apply(base, prepared, args.cleanup_apply, args.confirm_preview_digest)
        elif args.preflight:
            result = preflight(base, prepared, args.max_batch_tokens)
        elif completed_matches(args.output, prepared):
            print(canonical({"terminalState": "success", "reused": True, "zeroModelCalls": True,
                             "output": str(args.output)}))
            return 0
        else:
            pending = pending_checkpoint(args.output, prepared)
            if pending is not None:
                result = run(base, prepared, pending["preflight"], args.poll_seconds, args.output,
                             resume_checkpoint=pending)
            else:
                receipt = preflight(base, prepared, args.max_batch_tokens)
                result = run(base, prepared, receipt, args.poll_seconds, args.output)
        private_write(args.output, result)
        print(canonical({"terminalState": result["terminalState"], "output": str(args.output),
                         "zeroModelCalls": bool(args.preflight or args.cleanup_preview or args.cleanup_apply
                                                or args.reconcile_truncated_trace)}))
        return 0 if result["terminalState"] in {"ready", "success", "previewed", "cleaned"} else 1
    except Exception as error:
        result = {"terminalState": "failed", "error": f"{type(error).__name__}: {error}"}
        # Once the API has acknowledged a consolidation operation, never erase its
        # identity or turn an uncertain poll into permission for a second trigger.
        # The durable workflow can invoke the same argv and will resume by GET only.
        if not preserve_pending_error(args.output, error):
            private_write(args.output, result)
        print(canonical(result), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
