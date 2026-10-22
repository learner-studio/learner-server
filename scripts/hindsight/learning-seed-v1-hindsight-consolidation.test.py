import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PATH = Path(__file__).with_name("learning-seed-v1-hindsight-consolidation.py")
SPEC = importlib.util.spec_from_file_location("learning_seed_v1_hindsight_consolidation", PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def handoff():
    return {
        "runId": "three-step-fixture",
        "classificationRevision": "classifier-v6",
        "nodeStates": [{"conceptId": "concept-1", "nodeId": "node-1", "nodeVersion": 7,
                        "assessment": "insufficient_evidence", "sourceIds": []}],
        "cases": [{
            "caseId": "case-1",
            "current": {"id": "human-1", "role": "user", "text": "I can compare queues and streams."},
            "response": {"id": "assistant-1", "role": "assistant", "text": "Here is the distinction."},
            "classification": {"matches": [{
                "conceptId": "concept-1", "quote": "compare queues and streams",
                "relationship": "learner_evidence", "evidenceKind": "comparison",
                "assessment": "supports", "reason": "Explicit comparison.",
            }]},
        }],
    }


class ConsolidationAdapterTests(unittest.TestCase):
    def prepare(self, value=None):
        scratch = tempfile.TemporaryDirectory()
        path = Path(scratch.name) / "handoff.json"
        path.write_text(json.dumps(value or handoff()))
        return scratch, runner.prepare(path)

    def test_chunks_feed_has_exact_isolated_concept_scope(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        self.assertEqual(len(prepared.items), 1)
        item = prepared.items[0]
        self.assertEqual(item["observation_scopes"], [[prepared.experiment_tag]])
        self.assertIn("human-1", item["content"])
        self.assertIn("assistant-1", item["content"])
        self.assertNotIn("Here is the distinction.", item["content"])
        self.assertEqual(item["update_mode"], "replace")
        self.assertTrue(all(isinstance(value, str) for value in item["metadata"].values()))
        self.assertEqual(item["metadata"]["classificationCount"], "1")
        self.assertEqual(item["metadata"]["priorNodeStateCount"], "1")

    def test_feed_passes_exact_installed_hindsight_retain_request_model(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        validation = runner.validate_native_retain_request(prepared.items)
        self.assertEqual(validation["model"], "hindsight_api.api.http.RetainRequest")
        self.assertEqual(len(validation["jsonSchemaSha256"]), 64)
        self.assertEqual(len(validation["payloadSha256"]), 64)

    def test_zero_matches_is_valid(self):
        value = handoff()
        value["cases"][0]["classification"]["matches"] = []
        value["nodeStates"] = []
        scratch, prepared = self.prepare(value)
        self.addCleanup(scratch.cleanup)
        self.assertEqual(prepared.items, [])
        self.assertEqual(prepared.scopes, [])

    def test_prior_state_is_separate_labeled_supported_input(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        feed = prepared.items[0]
        self.assertIn("NOT NEW HUMAN EVIDENCE", feed["content"])
        self.assertIn("priorNodeAssessments", feed["content"])
        self.assertEqual(prepared.mappings[feed["document_id"]]["recordKind"], "three_step_feed")

    def test_non_exact_quote_and_duplicate_are_rejected(self):
        value = handoff()
        value["cases"][0]["classification"]["matches"][0]["quote"] = "not present"
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "handoff.json"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(runner.ContractError, "non-exact"):
                runner.prepare(path)
        value = handoff()
        value["cases"][0]["classification"]["matches"] *= 2
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "handoff.json"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(runner.ContractError, "Duplicate"):
                runner.prepare(path)

    def test_cleanup_preview_refuses_foreign_scope(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        original = runner.list_all
        runner.list_all = lambda *_args: {"body": {"items": [{"id": "obs", "tags": ["foreign"]}]}}
        self.addCleanup(setattr, runner, "list_all", original)
        with self.assertRaisesRegex(runner.ContractError, "foreign observation"):
            runner.cleanup_preview("http://127.0.0.1:18923", prepared)

    def test_terminal_digest_controls_zero_call_replay(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        path = Path(scratch.name) / "result.json"
        path.write_text(json.dumps({"terminalState": "success", "preflight": {"inputDigest": prepared.input_digest}}))
        self.assertTrue(runner.completed_matches(path, prepared))
        path.write_text(json.dumps({"terminalState": "success", "preflight": {"inputDigest": "other"}}))
        self.assertFalse(runner.completed_matches(path, prepared))

    def test_pending_checkpoint_resumes_poll_only_without_feed_or_trigger(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        document_id = prepared.items[0]["document_id"]
        source = {"id": "source-1", "document_id": document_id}
        checkpoint = {
            "terminalState": "pending", "inputDigest": prepared.input_digest,
            "bankId": prepared.bank_id, "operationId": "operation-1",
            "preflight": {"inputDigest": prepared.input_digest, "effective": {}},
            "native": {
                "feed": {"body": {"usage": {"total_tokens": 0}}},
                "sourceFacts": {"body": {"items": [source]}},
                "trigger": {"body": {"operation_id": "operation-1"}},
            },
            "metricSnapshotsBefore": {
                "consolidation": runner.metric_snapshot("", "consolidation"),
                "consolidation_dedup": runner.metric_snapshot("", "consolidation_dedup"),
            },
            "timing": {},
            "recovery": {"mode": "poll-only", "mustNotFeedOrTriggerAgain": True},
        }
        calls = []
        def fake_request(_base, method, path, *_args, **_kwargs):
            calls.append((method, path))
            if "/operations/" in path:
                return {"body": {"status": "completed"}}
            if "llm-requests" in path:
                return {"body": {"items": [{"input": prepared.prior_state_markers}]}}
            if "memories/list" in path:
                return {"body": {"items": [{"id": "obs-1", "tags": prepared.scopes[0],
                                              "source_memory_ids": ["source-1"]}]}}
            raise AssertionError(path)
        metrics = ('hindsight_llm_calls_total{provider="openai-codex",model="gpt-5.6-luna",'
                   'scope="consolidation",success="true"} 1\n')
        with patch.object(runner, "request", side_effect=fake_request), patch.object(
            runner, "request_text", return_value=metrics
        ):
            result = runner.run("http://127.0.0.1:18923", prepared, checkpoint["preflight"], 1,
                                Path(scratch.name) / "result.json", resume_checkpoint=checkpoint)
        self.assertEqual(result["terminalState"], "success")
        self.assertTrue(all(method == "GET" for method, _path in calls))

    def test_poll_error_preserves_pending_operation_identity(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        path = Path(scratch.name) / "result.json"
        checkpoint = {
            "terminalState": "pending", "inputDigest": prepared.input_digest,
            "bankId": prepared.bank_id, "operationId": "operation-1",
            "recovery": {"mode": "poll-only", "mustNotFeedOrTriggerAgain": True},
        }
        path.write_text(json.dumps(checkpoint))
        self.assertTrue(runner.preserve_pending_error(path, TimeoutError("poll unavailable")))
        saved = json.loads(path.read_text())
        self.assertEqual(saved["terminalState"], "pending")
        self.assertEqual(saved["operationId"], "operation-1")
        self.assertEqual(saved["recovery"], checkpoint["recovery"])
        self.assertIn("TimeoutError: poll unavailable", saved["lastPollError"])

    def test_truncated_trace_reconciles_only_exact_installed_prompt_prefix_and_length(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        from hindsight_api.engine.consolidation.consolidator import (
            build_consolidation_input, build_consolidation_system_prompt,
        )
        source_id = "source-1"
        messages = [
            {"role": "system", "content": build_consolidation_system_prompt(llm_output_language=None)},
            {"role": "user", "content": build_consolidation_input(
                facts_text=f"[{source_id}] {prepared.items[0]['content']}", observations_text="[]",
                observations_mission=runner.MISSION, observation_capacity_note=None,
            )},
        ]
        serialized = json.dumps(messages)
        raw = {
            "terminalState": "failed", "error": "native operation or validation failed",
            "preflight": {"inputDigest": prepared.input_digest},
            "native": {
                "sourceFacts": {"body": {"items": [{"id": source_id,
                    "document_id": prepared.items[0]["document_id"], "text": prepared.items[0]["content"]}]}},
                "llmRequestTraces": {"body": {"items": [{
                    "trace_id": "trace-1", "status": "success", "operation": "consolidation",
                    "provider": runner.PROVIDER, "model": runner.MODEL,
                    "metadata": {"source_memory_ids": [source_id]},
                    "input": {"_truncated": True, "_original_chars": len(serialized),
                              "preview": serialized[:100]},
                }]}},
            },
            "adapted": {"validationFailures": [{
                "reason": "prior-node-state-not-present-in-native-prompt", "missingMarkerDigests": ["old"],
            }]},
            "metrics": {
                "consolidation": {"delta": {"calls": 1}},
                "consolidation_dedup": {"delta": {"calls": 0}},
            },
        }
        raw_path = Path(scratch.name) / "raw.json"
        raw_path.write_text(json.dumps(raw))
        result = runner.reconcile_truncated_trace(prepared, raw_path)
        self.assertEqual(result["terminalState"], "success")
        self.assertEqual(result["adapted"]["priorNodeStatePromptProof"]["missingMarkerCount"], 0)
        raw["native"]["llmRequestTraces"]["body"]["items"][0]["input"]["preview"] += "drift"
        raw_path.write_text(json.dumps(raw))
        with self.assertRaisesRegex(runner.ContractError, "preview/length"):
            runner.reconcile_truncated_trace(prepared, raw_path)

    def test_canonical_archive_is_refused(self):
        with self.assertRaisesRegex(runner.ContractError, "18925"):
            runner.validate_url("http://127.0.0.1:18925")

    def test_workflow_batch_token_ceiling_is_explicit_and_bounded(self):
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "result.json"
            status = runner.main([
                "--input", str(Path(scratch) / "missing.json"),
                "--output", str(output),
                "--max-batch-tokens", "400001",
            ])
            self.assertEqual(status, 1)
            result = json.loads(output.read_text())
            self.assertIn("between 1 and 400000", result["error"])


if __name__ == "__main__":
    unittest.main()
