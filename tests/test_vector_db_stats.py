"""Unit tests for library stats and the read-only unknown-author list."""

import importlib.util
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


def load_script_module():
    script_path = Path(__file__).resolve().parents[1] / "bin" / "vector_db_stats.py"
    spec = importlib.util.spec_from_file_location("vector_db_stats", script_path)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load vector_db_stats.py")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()


def empty_stats():
    return {"author": Counter(), "library": Counter(), "type": Counter()}


def count_records(records):
    stats = empty_stats()
    unknown_chunks = 0
    for index, metadata in enumerate(records):
        unknown_chunks += SCRIPT.process_vector_metadata(
            f"id-{index}",
            SimpleNamespace(metadata=metadata),
            stats,
            {},
        )
    return stats, unknown_chunks


def assert_map_keys_are_safe(payload):
    for map_name in ("authors", "libraries", "mediaTypes"):
        assert payload[map_name]
        for key in payload[map_name]:
            assert isinstance(key, str)
            assert key.strip()
            assert key != ""


class TestUnknownAuthorCounts:
    def test_blank_authors_use_one_key_and_keep_other_counts(self):
        stats, unknown_chunks = count_records(
            [
                {"author": "Alice", "library": "Lib", "type": "text"},
                {"author": "Alice", "library": "Lib", "type": "text"},
                {"author": "", "library": "Lib", "type": "text"},
                {"author": "   ", "library": "Lib", "type": "text"},
                {"author": None, "library": "Lib", "type": "text"},
                {"library": "Lib", "type": "text"},
                {"author": "Bob", "library": "Other", "type": "audio"},
                {"author": "Unknown author", "library": "Lib", "type": "text"},
            ]
        )

        assert unknown_chunks == 4
        assert stats["author"]["Alice"] == 2
        assert stats["author"]["Bob"] == 1
        assert stats["author"][SCRIPT.UNKNOWN_AUTHOR] == 5
        assert "" not in stats["author"]
        assert "   " not in stats["author"]
        assert stats["library"]["Lib"] == 7
        assert stats["library"]["Other"] == 1
        assert stats["type"]["text"] == 7
        assert stats["type"]["audio"] == 1

        payload = SCRIPT.build_stats_payload(stats, "ananda")
        assert_map_keys_are_safe(payload)
        assert payload["authors"]["Alice"] == 2
        assert payload["authors"]["Bob"] == 1
        assert payload["authors"][SCRIPT.UNKNOWN_AUTHOR] == 5
        assert payload["authors"]["whole_library"] == 8
        assert payload["libraries"]["Lib"] == 7
        assert payload["libraries"]["Other"] == 1
        assert payload["mediaTypes"]["text"] == 7
        assert payload["mediaTypes"]["audio"] == 1

    def test_non_string_author_is_unknown(self):
        stats, unknown_chunks = count_records(
            [{"author": 12, "library": "Lib", "type": "text"}]
        )

        assert unknown_chunks == 1
        assert stats["author"][SCRIPT.UNKNOWN_AUTHOR] == 1
        assert 12 not in stats["author"]

    def test_blank_library_and_type_keys_are_replaced(self):
        stats, unknown_chunks = count_records(
            [
                {"author": "Alice", "library": "", "type": "  "},
                {"author": "Alice", "library": "Lib", "type": "text"},
            ]
        )

        assert unknown_chunks == 0
        assert stats["author"]["Alice"] == 2
        assert stats["library"]["Lib"] == 1
        assert stats["library"][SCRIPT.UNKNOWN_LIBRARY] == 1
        assert "" not in stats["library"]
        assert stats["type"]["text"] == 1
        assert stats["type"][SCRIPT.UNKNOWN_TYPE] == 1
        assert "  " not in stats["type"]

    def test_warning_line_prints_once(self, capsys):
        stats = {
            "author": Counter({SCRIPT.UNKNOWN_AUTHOR: 5, "Alice": 2}),
            "library": Counter({"Lib": 7}),
            "type": Counter({"text": 7}),
        }

        SCRIPT.print_stats(stats, {"Lib": 1}, unknown_author_chunks=4)

        output = capsys.readouterr().out
        assert output.count("Warning:") == 1
        assert SCRIPT.unknown_author_warning_line(4) in output
        assert "Alice: 2" in output

    def test_no_warning_when_every_author_is_present(self, capsys):
        SCRIPT.print_stats(
            {
                "author": Counter({"Alice": 2}),
                "library": Counter(),
                "type": Counter(),
            },
            {},
            0,
        )

        assert "Warning:" not in capsys.readouterr().out


class TestFirestorePayload:
    def test_empty_keys_never_reach_the_write(self, monkeypatch):
        stats = {
            "author": Counter({"": 3, "   ": 1, None: 2, 5: 1, "Alice": 5, "Bob": 1}),
            "library": Counter({"": 4, "Lib": 7}),
            "type": Counter({"text": 9, " ": 2}),
        }
        captured = {}

        class Document:
            def set(self, data):
                captured["data"] = data

        class Collection:
            def document(self, site):
                assert site == "ananda"
                return Document()

        class Database:
            def collection(self, name):
                assert name == "libraryStats"
                return Collection()

        monkeypatch.setattr(SCRIPT, "_initialize_firebase_admin", lambda env: None)
        monkeypatch.setattr(SCRIPT.firestore, "client", lambda: Database())

        SCRIPT.write_stats_to_firestore(stats, "ananda", "prod")

        data = captured["data"]
        assert_map_keys_are_safe(data)
        assert "" not in data["authors"]
        assert None not in data["authors"]
        assert data["authors"]["Alice"] == 5
        assert data["authors"]["Bob"] == 1
        assert data["authors"][SCRIPT.UNKNOWN_AUTHOR] == 7
        assert data["authors"]["whole_library"] == 13
        assert data["libraries"]["Lib"] == 7
        assert data["libraries"][SCRIPT.UNKNOWN_LIBRARY] == 4
        assert data["mediaTypes"]["text"] == 9
        assert data["mediaTypes"][SCRIPT.UNKNOWN_TYPE] == 2


class TestListUnknownAuthors:
    def test_groups_documents_and_skips_known_authors(self):
        groups = SCRIPT.group_unknown_author_documents(
            [
                {
                    "author": "",
                    "title": "Healing",
                    "source": "blog",
                    "url": "https://example.test/h",
                },
                {
                    "author": None,
                    "title": "Healing",
                    "source": "blog",
                    "url": "https://example.test/h",
                },
                {
                    "author": "   ",
                    "title": "Healing",
                    "source": "blog",
                    "url": "https://example.test/h",
                },
                {"title": "Notes", "url": "https://example.test/n"},
                {
                    "author": "Alice",
                    "title": "Known",
                    "source": "blog",
                    "url": "https://example.test/k",
                },
                {
                    "author": "\n",
                    "title": "  Spaced Title  ",
                    "source": "  src  ",
                    "url": " https://example.test/s ",
                },
            ]
        )

        assert [
            (group.title, group.source, group.url, group.chunk_count)
            for group in groups
        ] == [
            ("Healing", "blog", "https://example.test/h", 3),
            ("Notes", "", "https://example.test/n", 1),
            ("Spaced Title", "src", "https://example.test/s", 1),
        ]
        assert sum(group.chunk_count for group in groups) == 5

    def test_list_flag_prints_groups_and_does_not_write(
        self, tmp_path, monkeypatch, capsys
    ):
        env_dir = tmp_path / "env"
        env_dir.mkdir()
        (env_dir / ".env.ananda").write_text(
            "PINECONE_API_KEY=test-key\nPINECONE_INGEST_INDEX_NAME=test-index\n"
        )
        monkeypatch.chdir(env_dir)
        monkeypatch.setenv("PINECONE_API_KEY", "test-key")
        monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "test-index")

        index = Mock()
        index.describe_index_stats.return_value = SimpleNamespace(total_vector_count=4)
        index.list.return_value = [["c1", "c2", "c3", "c4"]]
        index.fetch.return_value = SimpleNamespace(
            vectors={
                "c1": SimpleNamespace(
                    metadata={
                        "author": "",
                        "title": "Healing",
                        "source": "blog",
                        "url": "https://example.test/h",
                    }
                ),
                "c2": SimpleNamespace(
                    metadata={
                        "author": "  ",
                        "title": "Healing",
                        "source": "blog",
                        "url": "https://example.test/h",
                    }
                ),
                "c3": SimpleNamespace(
                    metadata={
                        "title": "No Author Field",
                        "url": "https://example.test/n",
                    }
                ),
                "c4": SimpleNamespace(
                    metadata={
                        "author": "Alice",
                        "title": "Known",
                        "url": "https://example.test/k",
                    }
                ),
            }
        )

        def pinecone_factory(api_key):
            assert api_key == "test-key"
            client = Mock()
            client.Index.return_value = index
            return client

        monkeypatch.setattr(SCRIPT, "Pinecone", pinecone_factory)
        firestore_write = Mock(side_effect=AssertionError("firestore write"))
        monkeypatch.setattr(SCRIPT, "write_stats_to_firestore", firestore_write)
        monkeypatch.setattr(
            SCRIPT,
            "verify_firestore_access",
            Mock(side_effect=AssertionError("firestore read")),
        )

        csv_path = tmp_path / "unknown.csv"
        SCRIPT.main(
            [
                "--site",
                "ananda",
                "--list-unknown-authors",
                "--unknown-authors-csv",
                str(csv_path),
            ]
        )

        index.update.assert_not_called()
        index.upsert.assert_not_called()
        index.delete.assert_not_called()
        firestore_write.assert_not_called()

        output = capsys.readouterr().out
        assert "Healing" in output
        assert "No Author Field" in output
        assert "Known" not in output
        assert "Total chunks: 3" in output

        csv_text = csv_path.read_text(encoding="utf-8")
        assert "chunk_count,title,source,url" in csv_text
        assert "2,Healing,blog,https://example.test/h" in csv_text
        assert "1,No Author Field,,https://example.test/n" in csv_text
        assert "Alice" not in csv_text
        assert "Known" not in csv_text

    def test_csv_option_requires_the_list_flag(self):
        with pytest.raises(SystemExit):
            SCRIPT.main(["--site", "ananda", "--unknown-authors-csv", "out.csv"])

    def test_list_flag_rejects_a_firestore_write(self):
        with pytest.raises(SystemExit):
            SCRIPT.main(
                [
                    "--site",
                    "ananda",
                    "--list-unknown-authors",
                    "--write-firestore",
                    "--env",
                    "prod",
                ]
            )
