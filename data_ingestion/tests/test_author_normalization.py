"""Tests for author name normalization and mappings path resolution."""

import json
import os
from pathlib import Path

import pytest

from data_ingestion.utils import author_normalization as mod


@pytest.fixture(autouse=True)
def clear_author_mapping_cache():
    mod._author_mapping_cache.clear()
    yield
    mod._author_mapping_cache.clear()


class TestResolveAuthorMappingsPath:
    def test_finds_monorepo_file(self):
        path = mod.resolve_author_mappings_path()
        assert os.path.isfile(path)
        assert path.endswith("web/site-config/author_mappings.json")

    def test_env_override(self, tmp_path, monkeypatch):
        custom = tmp_path / "custom_author_mappings.json"
        custom.write_text("{}", encoding="utf-8")
        monkeypatch.setenv("AUTHOR_MAPPINGS_PATH", str(custom))
        assert mod.resolve_author_mappings_path() == str(custom)

    def test_container_path_when_present(self, tmp_path, monkeypatch):
        container_dir = tmp_path / "web" / "site-config"
        container_dir.mkdir(parents=True)
        container_file = container_dir / "author_mappings.json"
        container_file.write_text("{}", encoding="utf-8")

        monkeypatch.delenv("AUTHOR_MAPPINGS_PATH", raising=False)
        monkeypatch.setattr(mod, "_CONTAINER_MAPPINGS_PATH", str(container_file))

        assert mod.resolve_author_mappings_path() == str(container_file)


class TestNormalizeAuthor:
    def test_maps_known_variant_for_ananda_public(self):
        assert (
            mod.normalize_author("Paramahansa Yogananda", "ananda-public")
            == "Paramhansa Yogananda"
        )

    def test_loads_mappings_from_env_override(self, tmp_path, monkeypatch):
        mappings = {
            "ananda-public": {
                "Test Author Variant": "Canonical Author",
            }
        }
        custom = tmp_path / "author_mappings.json"
        custom.write_text(json.dumps(mappings), encoding="utf-8")
        monkeypatch.setenv("AUTHOR_MAPPINGS_PATH", str(custom))

        assert mod.normalize_author("Test Author Variant", "ananda-public") == (
            "Canonical Author"
        )

    def test_returns_unknown_for_empty_input(self):
        assert mod.normalize_author(None, "ananda-public") == "Unknown"
        assert mod.normalize_author("", "ananda-public") == "Unknown"

    def test_preserves_unmapped_author(self):
        assert mod.normalize_author("Nayaswami Hriman", "ananda-public") == (
            "Nayaswami Hriman"
        )
