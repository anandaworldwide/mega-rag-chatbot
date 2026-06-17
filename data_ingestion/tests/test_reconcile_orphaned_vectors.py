"""Tests for crawler/bin/reconcile_orphaned_vectors.py."""

from __future__ import annotations

import importlib.util
import pathlib
import re
import sys
import time
from argparse import Namespace
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_PATH = (
    REPO_ROOT / "data_ingestion" / "crawler" / "bin" / "reconcile_orphaned_vectors.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "reconcile_orphaned_vectors", SCRIPT_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["reconcile_orphaned_vectors"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def rov():
    return _load_module()


def _base_args(**overrides):
    defaults = dict(
        site="ananda-public",
        apply=False,
        apply_if_safe=False,
        email_report=False,
        skip_http_check=False,
        http_rate=3.0,
        http_workers=3,
        http_timeout=20,
        fetch_workers=2,
        min_db_urls=1000,
        max_delete_fraction=0.05,
        max_runtime_seconds=7140,
        force=False,
        sample=None,
        json=False,
    )
    defaults.update(overrides)
    return Namespace(**defaults)


def _ctx(rov, **arg_overrides):
    args = _base_args(**arg_overrides)
    return rov.RunContext(args=args, deadline=time.monotonic() + 3600)


class TestGuardLogic:
    def test_guard_basis_prefers_total_index(self, rov):
        basis, label = rov.guard_basis_and_label(100_000, 50_000)
        assert basis == 100_000
        assert label == "total index"

    def test_guard_basis_falls_back_to_scanned(self, rov):
        basis, label = rov.guard_basis_and_label(0, 50_000)
        assert basis == 50_000
        assert label == "scanned crawler"

    def test_is_guard_blocked_at_threshold(self, rov):
        assert not rov.is_guard_blocked([1] * 5000, 100_000, 0.05, False)
        assert rov.is_guard_blocked([1] * 5001, 100_000, 0.05, False)

    def test_is_guard_blocked_respects_force(self, rov):
        assert not rov.is_guard_blocked([1] * 9999, 10_000, 0.05, True)

    def test_is_guard_blocked_empty_delete_set(self, rov):
        assert not rov.is_guard_blocked([], 100_000, 0.05, False)


class TestValidateArgs:
    def _args(self, **overrides):
        return _base_args(**overrides)

    def test_rejects_apply_and_apply_if_safe(self, rov):
        err = rov.validate_args(self._args(apply=True, apply_if_safe=True))
        assert err is not None
        assert "apply" in err

    def test_rejects_force_with_apply_if_safe(self, rov):
        err = rov.validate_args(self._args(apply_if_safe=True, force=True))
        assert err is not None
        assert "force" in err

    def test_accepts_apply_if_safe_alone(self, rov):
        assert rov.validate_args(self._args(apply_if_safe=True)) is None


class TestClassification:
    def test_query_is_tracking_only(self, rov):
        assert rov.query_is_tracking_only("example.com/page?utm_source=x")
        assert not rov.query_is_tracking_only("example.com/page?id=1")

    def test_classify_orphan_skip_pattern(self, rov):
        rx = [re.compile(r"^/admin")]
        assert rov.classify_orphan("example.com/admin/foo", rx) == "skip_pattern"

    def test_classify_orphan_tracking_param(self, rov):
        assert (
            rov.classify_orphan("example.com/page?utm_campaign=x", [])
            == "tracking_param"
        )

    def test_decide_for_url(self, rov):
        assert rov.decide_for_url("skip_pattern", None, False) == "skip_pattern"
        assert rov.decide_for_url("ambiguous", 404, False) == "dead_404"
        assert rov.decide_for_url("ambiguous", 200, False) == "live"
        assert rov.decide_for_url("ambiguous", "ERR", False) == "keep_unknown"
        assert rov.decide_for_url("ambiguous", 404, True) == "keep_unchecked"


class TestExitCodes:
    def test_failed_exits_one(self, rov):
        result = rov.ReconcileResult(
            site="ananda-public",
            index_name="idx",
            db_path=None,
            manifest_path=None,
            db_url_count=0,
            total_index_vectors=0,
            scanned_vectors=0,
            orphan_url_count=0,
            orphan_vector_count=0,
            delete_urls=[],
            delete_ids=[],
            keep_urls=[],
            decision={},
            orphan_map={},
            guard_blocked=False,
            guard_basis=0,
            guard_basis_label="",
            applied=False,
            failed=True,
            error_message="boom",
        )
        assert rov.compute_exit_code(result) == 1

    def test_timeout_exits_124(self, rov):
        result = rov.ReconcileResult(
            site="ananda-public",
            index_name="idx",
            db_path=None,
            manifest_path=None,
            db_url_count=0,
            total_index_vectors=0,
            scanned_vectors=0,
            orphan_url_count=0,
            orphan_vector_count=0,
            delete_urls=[],
            delete_ids=[],
            keep_urls=[],
            decision={},
            orphan_map={},
            guard_blocked=False,
            guard_basis=0,
            guard_basis_label="",
            applied=False,
            timed_out=True,
        )
        assert rov.compute_exit_code(result) == rov.EXIT_TIMEOUT

    def test_needs_review_exits_two(self, rov):
        result = rov.ReconcileResult(
            site="ananda-public",
            index_name="idx",
            db_path=None,
            manifest_path=None,
            db_url_count=0,
            total_index_vectors=100_000,
            scanned_vectors=50_000,
            orphan_url_count=1,
            orphan_vector_count=10,
            delete_urls=["example.com/page"],
            delete_ids=["v1"],
            keep_urls=[],
            decision={"example.com/page": "skip_pattern"},
            orphan_map={"example.com/page": ["v1"]},
            guard_blocked=True,
            guard_basis=100_000,
            guard_basis_label="total index",
            applied=False,
            needs_review=True,
        )
        assert rov.compute_exit_code(result) == rov.EXIT_GUARD_BLOCKED


class TestEmailFormatting:
    def test_failed_subject(self, rov):
        with patch.object(rov, "get_site_shortname", return_value="Vivek"):
            result = rov.ReconcileResult(
                site="ananda-public",
                index_name="idx",
                db_path=None,
                manifest_path=None,
                db_url_count=0,
                total_index_vectors=0,
                scanned_vectors=0,
                orphan_url_count=0,
                orphan_vector_count=0,
                delete_urls=[],
                delete_ids=[],
                keep_urls=[],
                decision={},
                orphan_map={},
                guard_blocked=False,
                guard_basis=0,
                guard_basis_label="",
                applied=False,
                failed=True,
                error_message="PINECONE_API_KEY not set",
            )
            assert (
                rov.format_email_subject(result) == "[Vivek] FAILED - Orphan reconcile"
            )
            assert "PINECONE_API_KEY" in rov.format_email_body(result)

    def test_timeout_subject_and_body(self, rov):
        with patch.object(rov, "get_site_shortname", return_value="Vivek"):
            result = rov.ReconcileResult(
                site="ananda-public",
                index_name="idx",
                db_path=pathlib.Path("/data/db/crawler_queue_ananda-public.db"),
                manifest_path=pathlib.Path(
                    "/data/db/orphan_reconcile_ananda-public.json"
                ),
                db_url_count=5000,
                total_index_vectors=100_000,
                scanned_vectors=40_000,
                orphan_url_count=10,
                orphan_vector_count=20,
                delete_urls=[],
                delete_ids=[],
                keep_urls=["example.com/live"],
                decision={"example.com/live": "live"},
                orphan_map={"example.com/live": ["v1"]},
                guard_blocked=False,
                guard_basis=0,
                guard_basis_label="",
                applied=False,
                timed_out=True,
                timeout_phase="http_liveness",
                max_runtime_seconds=7140,
            )
            subject = rov.format_email_subject(result)
            body = rov.format_email_body(result)
            assert subject == "[Vivek] TIMED OUT - Orphan reconcile"
            assert "TIMED OUT" in body
            assert "http_liveness" in body
            assert "7140" in body

    def test_unexamined_vectors_in_email(self, rov):
        with patch.object(rov, "get_site_shortname", return_value="Vivek"):
            result = rov.ReconcileResult(
                site="ananda-public",
                index_name="idx",
                db_path=None,
                manifest_path=None,
                db_url_count=0,
                total_index_vectors=0,
                scanned_vectors=10,
                orphan_url_count=0,
                orphan_vector_count=0,
                delete_urls=[],
                delete_ids=[],
                keep_urls=[],
                decision={},
                orphan_map={},
                guard_blocked=False,
                guard_basis=0,
                guard_basis_label="",
                applied=False,
                unexamined_vectors=42,
            )
            assert "Unexamined vectors" in rov.format_email_body(result)
            assert "42" in rov.format_email_body(result)

    def test_needs_review_subject(self, rov):
        with patch.object(rov, "get_site_shortname", return_value="Vivek"):
            result = rov.ReconcileResult(
                site="ananda-public",
                index_name="idx",
                db_path=None,
                manifest_path=None,
                db_url_count=0,
                total_index_vectors=100_000,
                scanned_vectors=50_000,
                orphan_url_count=1,
                orphan_vector_count=5,
                delete_urls=["example.com/x"],
                delete_ids=["v1"] * 5,
                keep_urls=[],
                decision={"example.com/x": "skip_pattern"},
                orphan_map={"example.com/x": ["v1"] * 5},
                guard_blocked=True,
                guard_basis=100_000,
                guard_basis_label="total index",
                applied=False,
                needs_review=True,
            )
            assert "NEEDS REVIEW" in rov.format_email_subject(result)


class TestManifest:
    def test_manifest_reflects_guard_block_without_apply(self, rov, tmp_path):
        manifest_path = tmp_path / "orphan_reconcile_test.json"
        orphan_map = {"example.com/x": ["v1", "v2"]}
        decision = {"example.com/x": "skip_pattern", "example.com/y": "live"}
        rov.write_manifest(
            manifest_path,
            delete_urls=["example.com/x"],
            delete_ids=["v1", "v2"],
            keep_urls=["example.com/y"],
            orphan_map=orphan_map,
            decision=decision,
            applied=False,
            guard_blocked=True,
            timed_out=False,
            unexamined_vectors=3,
        )
        data = __import__("json").loads(manifest_path.read_text())
        assert data["meta"]["applied"] is False
        assert data["meta"]["guard_blocked"] is True
        assert data["meta"]["unexamined_vectors"] == 3
        assert data["delete_candidates"]["example.com/x"] == ["v1", "v2"]
        assert data["deleted"] == {}


class TestExecuteDeletePolicy:
    def test_apply_if_safe_skips_when_guard_blocked(self, rov):
        ctx = _ctx(rov, apply_if_safe=True)
        index = MagicMock()
        applied = rov.execute_delete_policy(
            ctx.args, index, ctx, ["v1"] * 6000, True, "total index", 100_000, 50_000
        )
        assert applied is False
        index.delete.assert_not_called()

    def test_apply_if_safe_deletes_when_safe(self, rov):
        ctx = _ctx(rov, apply_if_safe=True)
        index = MagicMock()
        with patch.object(rov, "delete_orphan_vectors") as mock_delete:
            applied = rov.execute_delete_policy(
                ctx.args, index, ctx, ["v1"], False, "total index", 100_000, 50_000
            )
        assert applied is True
        mock_delete.assert_called_once()

    def test_apply_raises_when_guard_blocked(self, rov):
        ctx = _ctx(rov, apply=True)
        index = MagicMock()
        with pytest.raises(rov.ReconcileFatalError):
            rov.execute_delete_policy(
                ctx.args, index, ctx, ["v1"] * 6000, True, "total index", 100_000, 50_000
            )


class TestPartialTimeout:
    def test_compute_partial_reconcile_state(self, rov):
        ctx = _ctx(rov)
        ctx.orphan_map = {"example.com/x": ["v1"]}
        ctx.categories = {"example.com/x": "skip_pattern"}
        ctx.scanned_vectors = 100
        ctx.total_index_vectors = 10_000
        partial = rov.compute_partial_reconcile_state(ctx)
        assert partial is not None
        assert partial.delete_urls == ["example.com/x"]
        assert partial.decision["example.com/x"] == "skip_pattern"

    def test_build_timeout_result_includes_decisions(self, rov):
        ctx = _ctx(rov)
        ctx.orphan_map = {"example.com/y": ["v2"]}
        ctx.categories = {"example.com/y": "live"}
        ctx.statuses = {"example.com/y": 200}
        ctx.scanned_vectors = 50
        result = rov.build_timeout_result(ctx, "http_liveness", "timed out")
        assert result.timed_out is True
        assert result.decision["example.com/y"] == "live"

    def test_main_timeout_path(self, rov):
        args = _base_args(email_report=True)
        ctx = rov.RunContext(args=args, deadline=time.monotonic() + 3600)
        ctx.orphan_map = {"example.com/x": ["v1"]}
        ctx.categories = {"example.com/x": "skip_pattern"}
        ctx.scanned_vectors = 10
        ctx.total_index_vectors = 100_000
        ctx.manifest_path = pathlib.Path("/tmp/manifest.json")

        with patch.object(rov, "build_arg_parser") as mock_parser:
            mock_parser.return_value.parse_args.return_value = args
            with patch.object(
                rov,
                "run_reconciliation",
                side_effect=rov.ReconcileTimeoutError("slow", phase="pinecone_scan"),
            ):
                with patch.object(rov, "write_partial_timeout_manifest") as mock_manifest:
                    with patch.object(rov, "send_email_report", return_value=True):
                        code = rov.main()
        assert code == rov.EXIT_TIMEOUT
        mock_manifest.assert_called_once()


class TestSigtermHandler:
    def test_sigterm_sends_partial_timeout_email(self, rov):
        args = _base_args(email_report=True)
        ctx = rov.RunContext(args=args, deadline=time.monotonic() + 3600)
        ctx.orphan_map = {"example.com/x": ["v1"]}
        ctx.categories = {"example.com/x": "skip_pattern"}
        ctx.scanned_vectors = 5
        ctx.phase = "http_liveness"
        rov._run_context = ctx

        with patch.object(rov, "send_email_report", return_value=True) as mock_send:
            with patch.object(rov, "write_partial_timeout_manifest") as mock_manifest:
                with patch.object(rov.os, "_exit") as mock_exit:
                    rov._handle_sigterm(15, None)
        mock_manifest.assert_called_once()
        mock_send.assert_called_once()
        assert mock_send.call_args[0][0].timed_out is True
        assert mock_send.call_args[0][0].delete_urls == ["example.com/x"]
        mock_exit.assert_called_once_with(rov.EXIT_TIMEOUT)


class TestListCrawlerVectorIds:
    def test_checks_deadline_during_list(self, rov):
        ctx = rov.RunContext(
            args=_base_args(max_runtime_seconds=1),
            deadline=time.monotonic() - 1,
        )
        index = MagicMock()
        index.list.return_value = [["id1"], ["id2"]]
        with pytest.raises(rov.ReconcileTimeoutError):
            rov.list_crawler_vector_ids(index, "prefix", None, ctx)


class TestScanPineconeOrphans:
    def test_fetch_retry_then_unexamined_on_failure(self, rov):
        ctx = _ctx(rov)
        db_urls = {"example.com/ok"}
        index = MagicMock()
        index.list.return_value = [["a1", "a2"]]

        def fetch_side_effect(ids):
            if ids == ["a1", "a2"]:
                raise RuntimeError("pinecone down")
            return {"vectors": {}}

        index.fetch.side_effect = fetch_side_effect

        orphan_map, scanned = rov.scan_pinecone_orphans(
            index, "example.com", db_urls, fetch_workers=1, sample=None, ctx=ctx
        )
        assert scanned == 0
        assert orphan_map == {}
        assert ctx.fetch_failures == 1
        assert ctx.unexamined_vectors == 2

    def test_missing_metadata_counts_as_unexamined(self, rov):
        ctx = _ctx(rov)
        db_urls: set[str] = set()
        index = MagicMock()
        index.list.return_value = [["v1", "v2"]]
        index.fetch.return_value = {
            "vectors": {
                "v1": {"metadata": {"source": "https://example.com/a"}},
                "v2": {"metadata": {}},
            }
        }
        orphan_map, scanned = rov.scan_pinecone_orphans(
            index, "example.com", db_urls, fetch_workers=1, sample=None, ctx=ctx
        )
        assert scanned == 1
        assert len(orphan_map) == 1
        assert ctx.unexamined_vectors == 1


class TestMain:
    def test_main_emails_on_fatal_error(self, rov):
        args = _base_args(email_report=True)
        with patch.object(rov, "build_arg_parser") as mock_parser:
            mock_parser.return_value.parse_args.return_value = args
            with patch.object(
                rov,
                "run_reconciliation",
                side_effect=rov.ReconcileFatalError("PINECONE_API_KEY not set"),
            ):
                with patch.object(rov, "send_email_report", return_value=True) as mock_send:
                    code = rov.main()
        assert code == 1
        mock_send.assert_called_once()
        assert mock_send.call_args[0][0].failed is True

    def test_main_fatal_with_partial_manifest(self, rov, tmp_path):
        args = _base_args(apply=True, email_report=False)
        manifest_path = tmp_path / "orphan_reconcile_ananda-public.json"

        def fail_on_apply(a, c):
            c.manifest_path = manifest_path
            c.orphan_map = {"example.com/x": ["v1"]}
            c.categories = {"example.com/x": "skip_pattern"}
            c.scanned_vectors = 100
            c.total_index_vectors = 1000
            raise rov.ReconcileFatalError("guard blocked")

        with patch.object(rov, "build_arg_parser") as mock_parser:
            mock_parser.return_value.parse_args.return_value = args
            with patch.object(rov, "run_reconciliation", side_effect=fail_on_apply):
                code = rov.main()
        assert code == 1
        data = __import__("json").loads(manifest_path.read_text())
        assert data["delete_candidates"]["example.com/x"] == ["v1"]
        assert data["meta"]["applied"] is False


class TestSystemdService:
    def test_orphan_reconcile_service_has_no_onfailure(self):
        service_path = (
            REPO_ROOT
            / "data_ingestion/crawler/deploy/vm/ananda-crawler-orphan-reconcile.service"
        )
        text = service_path.read_text()
        assert "OnFailure=" not in text
        service_section = text.split("[Service]", 1)[1].split("[", 1)[0]
        assert "SuccessExitStatus=2" in service_section
        unit_section = text.split("[Unit]", 1)[1].split("[Service]", 1)[0]
        assert "SuccessExitStatus=" not in unit_section
