import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("learning-seed-v1-hindsight.py")
SPEC = importlib.util.spec_from_file_location("learning_seed_v1_hindsight", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


CONCEPT_ID = "4b2fda8c-1d62-4e31-a4b8-03cd9b7b7e9a"


def manifest():
    return {
        "dataset": "seed V1",
        "conceptCatalog": [{"id": CONCEPT_ID, "title": "Abstraction"}],
        "cases": [
            {
                "caseId": f"case-{index:03d}",
                "current": {"id": f"u-{index}", "role": "user", "authorship": "human", "text": f"Explain abstraction {index}."},
                "response": {"id": f"a-{index}", "role": "assistant", "authorship": "assistant", "text": f"Response {index}."},
            }
            for index in range(100)
        ],
    }


class SeedV1HindsightTests(unittest.TestCase):
    def prepare(self):
        scratch = tempfile.TemporaryDirectory()
        path = Path(scratch.name) / "manifest.json"
        path.write_text(json.dumps(manifest()))
        return scratch, runner.prepare_manifest(path)

    def test_prepares_exact_100_pair_single_structured_document(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        self.assertEqual(len(prepared.cases), 100)
        self.assertEqual(json.loads(prepared.content)["dataset"], "seed V1")
        self.assertEqual(len(json.loads(prepared.content)["cases"]), 100)
        self.assertEqual(prepared.entity_labels[0]["key"], "case_id")
        self.assertEqual(len(prepared.entity_labels[0]["values"]), 100)

    def test_rejects_wrong_pair_count_and_canonical_archive(self):
        value = manifest()
        value["cases"].pop()
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "manifest.json"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(runner.ContractError, "exactly 100"):
                runner.prepare_manifest(path)
        with self.assertRaisesRegex(runner.ContractError, "18925"):
            runner.validate_base_url("http://127.0.0.1:18925")

    def test_adapter_preserves_native_and_maps_only_exact_valid_facts(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        valid = {
            "text": "Explain abstraction 0. | Reason: Direct task request.",
            "fact_type": "world",
            "entities": [
                "case_id:case-000", f"concept_id:{CONCEPT_ID}", "relationship:task_context",
                "evidence_kind:insufficient", "assessment:indeterminate",
            ],
        }
        invalid = {
            "text": "Not an exact quote. | Reason: Invented.",
            "fact_type": "world",
            "entities": valid["entities"],
        }
        adapted = runner.adapt_native_facts(prepared, [valid, invalid])
        first = adapted["results"][0]["classification"]
        self.assertEqual(first["assistance"], "unclear")
        self.assertEqual(first["status"], "provisional")
        self.assertEqual(first["matches"][0]["quote"], "Explain abstraction 0.")
        self.assertEqual(adapted["unmappableFacts"][0]["reason"], "non-exact-current-quote")

    def test_adapter_accepts_native_list_endpoint_entity_string(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        fact = {
            "text": "Explain abstraction 0. | Reason: Direct task request.",
            "fact_type": "world",
            "entities": ", ".join([
                "case_id:case-000", f"concept_id:{CONCEPT_ID}", "relationship:task_context",
                "evidence_kind:insufficient", "assessment:indeterminate",
            ]),
        }
        adapted = runner.adapt_native_facts(prepared, [fact])
        self.assertEqual(len(adapted["results"][0]["classification"]["matches"]), 1)
        self.assertEqual(adapted["unmappableFacts"], [])

    def test_metric_delta_filters_effective_model_scope(self):
        text = "\n".join([
            'hindsight_llm_calls_total{provider="openai-codex",model="gpt-5.6-luna",scope="retain_extract_facts",success="true"} 2',
            'hindsight_llm_calls_total{provider="openai-codex",model="other",scope="retain_extract_facts",success="true"} 99',
        ])
        self.assertEqual(runner.metric_value(text, "hindsight_llm_calls_total", {
            "provider": "openai-codex", "model": "gpt-5.6-luna", "scope": "retain_extract_facts",
        }), 2)

    def test_completed_output_replays_without_a_new_call(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        output = Path(scratch.name) / "result.json"
        output.write_text(json.dumps({
            "terminalState": "success",
            "preflight": {
                "manifestSha256": prepared.manifest_sha256,
                "contentSha256": prepared.content_sha256,
            },
            "effective": {
                "provider": runner.PROVIDER,
                "model": runner.MODEL,
                "effort": runner.EFFORT,
            },
            "attempt": {"nativeModelCallsObserved": 1},
        }))
        self.assertTrue(runner.completed_output_matches(output, prepared))
        value = json.loads(output.read_text())
        value["preflight"]["contentSha256"] = "different"
        output.write_text(json.dumps(value))
        self.assertFalse(runner.completed_output_matches(output, prepared))

    def test_failed_native_attempt_preserves_error_and_metric_discrepancy(self):
        scratch, prepared = self.prepare()
        self.addCleanup(scratch.cleanup)
        preflight = {"resolvedConfig": {}, "chunking": {"nativeChunkCount": 1}}
        with patch.object(runner, "request_text", return_value=""), patch.object(
            runner, "request_json", side_effect=runner.ContractError("Hindsight POST failed HTTP 500: timeout")
        ):
            result = runner.execute_once("http://127.0.0.1:18924", prepared, preflight)
        self.assertEqual(result["terminalState"], "failed")
        self.assertIn("timeout", result["error"])
        self.assertEqual(result["attempt"]["retainHttpAttempts"], 1)
        self.assertEqual(result["attempt"]["nativeSuccessfulModelCallsObserved"], 0)
        self.assertIn("observed 0", result["attempt"]["metricDiscrepancy"])


if __name__ == "__main__":
    unittest.main()
