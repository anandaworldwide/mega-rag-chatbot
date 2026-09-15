"""Tests for the ingest S3 publish CLI parser."""

import importlib.util
from pathlib import Path


def load_publish_cli():
    module_path = (
        Path(__file__).resolve().parents[2] / "bin" / "publish_ingest_sources_to_s3.py"
    )
    spec = importlib.util.spec_from_file_location("publish_ingest_sources_to_s3", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_cli_args_accepts_apply_after_state():
    module = load_publish_cli()
    args = module.parse_cli_args(["--site", "ananda", "state", "--apply"])
    assert args.command == "state"
    assert args.apply is True


def test_parse_cli_args_accepts_apply_after_youtube_list_file():
    module = load_publish_cli()
    args = module.parse_cli_args(
        ["--site", "ananda", "youtube-list", "--file", "links.xlsx", "--apply"]
    )
    assert args.command == "youtube-list"
    assert args.apply is True
    assert args.file.name == "links.xlsx"
