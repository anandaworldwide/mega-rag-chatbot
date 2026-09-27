"""Crystal Clarity PDF selection."""

from unittest.mock import MagicMock

import pytest

from data_ingestion.crystal_pdf_ingest import (
    one_vector_id_per_document,
    pdf_basenames_from_sources,
    read_dotenv_value,
    represented_basenames_from_index,
    represented_pdfs_from_index,
    run_pdf,
    select_new_pdf_keys,
    titles_from_vector_ids,
)


def test_select_new_pdf_keys_skips_books_already_in_pinecone():
    keys = [
        "ingestion/sources/crystal/pdfs/ALL/Already.pdf",
        "ingestion/sources/crystal/pdfs/ALL/New Book.pdf",
        "ingestion/sources/crystal/pdfs/ALL/notes.txt",
    ]

    selected = select_new_pdf_keys(keys, {"already.pdf"})

    assert selected == ["ingestion/sources/crystal/pdfs/ALL/New Book.pdf"]
    with pytest.raises(SystemExit, match="public"):
        select_new_pdf_keys(["public/pdf/Secret.pdf"], set())


def test_pdf_basename_lookup_uses_one_vector_per_document():
    ids = one_vector_id_per_document(
        [
            "text||Crystal Clarity||pdf||Book||Author||hash||0",
            "text||Crystal Clarity||pdf||Book||Author||hash||1",
            "text||Crystal Clarity||pdf||Other||Author||hash||0",
        ]
    )
    assert len(ids) == 2
    names = pdf_basenames_from_sources(
        [
            "/tmp/crystal/ALL/Already.pdf",
            "notes.txt",
            "",
        ]
    )
    assert names == {"already.pdf"}


def test_run_pdf_keeps_existing_vectors_and_skips_represented_books(tmp_path):
    publisher = MagicMock()
    publisher.list_prefix.return_value = [
        "ingestion/sources/crystal/pdfs/ALL/Already.pdf",
        "ingestion/sources/crystal/pdfs/ALL/New Book.pdf",
    ]
    calls = []

    def runner(command, check, cwd):
        calls.append((command, check, cwd))

    args = MagicMock()
    args.site = "crystal"
    args.s3_prefix = None
    args.replace_library = False
    args.local_dir = None

    downloaded = run_pdf(
        args,
        publisher=publisher,
        repo_root=tmp_path,
        runner=runner,
        represented_basenames={"already.pdf"},
        dest_dir=tmp_path / "pdfs",
    )

    assert downloaded == ["ingestion/sources/crystal/pdfs/ALL/New Book.pdf"]
    publisher.download_pdfs.assert_called_once()
    command, check, cwd = calls[0]
    assert check is True
    assert cwd == tmp_path
    assert "--keep-data" in command
    assert "--library-name" in command
    assert "Crystal Clarity" in command
    assert "--site" in command
    assert "crystal" in command
    assert "publish_title_catalog" not in " ".join(command)


def test_run_pdf_replace_requires_typed_library_name(tmp_path):
    publisher = MagicMock()
    args = MagicMock()
    args.site = "crystal"
    args.s3_prefix = None
    args.replace_library = True
    args.local_dir = None

    with pytest.raises(SystemExit, match="cancelled"):
        run_pdf(
            args,
            publisher=publisher,
            repo_root=tmp_path,
            runner=MagicMock(),
            represented_basenames=set(),
            prompt=lambda _message: "no",
        )

    publisher.list_prefix.assert_not_called()
    publisher.download_pdfs.assert_not_called()


def test_run_pdf_replace_omits_keep_data_after_typed_confirm(tmp_path):
    publisher = MagicMock()
    publisher.list_prefix.return_value = ["ingestion/sources/crystal/pdfs/ALL/Book.pdf"]
    calls = []
    args = MagicMock()
    args.site = "crystal"
    args.s3_prefix = None
    args.replace_library = True
    args.local_dir = None

    run_pdf(
        args,
        publisher=publisher,
        repo_root=tmp_path,
        runner=lambda command, check, cwd: calls.append(command),
        represented_basenames={"book.pdf"},
        prompt=lambda _message: "Crystal Clarity",
        dest_dir=tmp_path / "pdfs",
    )

    assert "--keep-data" not in calls[0]
    assert calls[0][calls[0].index("--library-name") + 1] == "Crystal Clarity"


def test_represented_basenames_from_index_reads_one_source_per_document():
    class Index:
        def list(self, prefix):
            assert prefix == "text||Crystal Clarity||"
            yield [
                "text||Crystal Clarity||pdf||Book||A||h||0",
                "text||Crystal Clarity||pdf||Book||A||h||1",
            ]

        def fetch(self, ids):
            assert ids == ["text||Crystal Clarity||pdf||Book||A||h||0"]
            return {
                "vectors": {
                    ids[0]: {"metadata": {"source": "/books/Already.pdf"}},
                }
            }

    assert represented_basenames_from_index(Index(), "Crystal Clarity") == {
        "already.pdf"
    }


def test_select_new_pdf_keys_skips_title_already_in_pinecone():
    keys = [
        "ingestion/sources/crystal/pdfs/ALL/A Fight for Religious Freedom.pdf",
        "ingestion/sources/crystal/pdfs/ALL/Brand New Book.pdf",
    ]
    titles = titles_from_vector_ids(
        [
            "text||Crystal Clarity||pdf||A Fight for Religious Freedom||Jon Parsons||001e782d||113"
        ]
    )

    selected = select_new_pdf_keys(keys, set(), titles)

    assert selected == ["ingestion/sources/crystal/pdfs/ALL/Brand New Book.pdf"]


def test_represented_pdfs_skip_same_file_when_title_differs():
    class Index:
        def list(self, prefix):
            assert prefix == "text||Crystal Clarity||"
            yield [
                "text||Crystal Clarity||pdf||Product Title From PDF Info||Author||hash||0"
            ]

        def fetch(self, ids):
            return {
                "vectors": {
                    ids[0]: {
                        "metadata": {
                            "source": "https://shop.example/book",
                            "pdf_filename": "Already.pdf",
                        }
                    }
                }
            }

    basenames, titles = represented_pdfs_from_index(Index(), "Crystal Clarity")
    keys = [
        "ingestion/sources/crystal/pdfs/ALL/Already.pdf",
        "ingestion/sources/crystal/pdfs/ALL/Brand New Book.pdf",
    ]

    assert select_new_pdf_keys(keys, basenames, titles) == [
        "ingestion/sources/crystal/pdfs/ALL/Brand New Book.pdf"
    ]


def test_select_new_pdf_keys_does_not_skip_a_longer_filename():
    long_name = "A Fight for Religious Freedom and a Much Longer Distinct Title"
    key = f"ingestion/sources/crystal/pdfs/ALL/{long_name}.pdf"
    titles = titles_from_vector_ids(
        [
            "text||Crystal Clarity||pdf||A Fight for Religious Freedom||Jon Parsons||001e782d||113"
        ]
    )

    assert select_new_pdf_keys([key], set(), titles) == [key]


def test_run_pdf_removes_its_temp_directory(tmp_path, monkeypatch):
    work = tmp_path / "crystal-pdfs"
    publisher = MagicMock()
    publisher.list_prefix.return_value = [
        "ingestion/sources/crystal/pdfs/ALL/New Book.pdf"
    ]

    def download(_keys, dest, _prefix):
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "New Book.pdf").write_bytes(b"pdf")

    publisher.download_pdfs.side_effect = download
    monkeypatch.setattr(
        "data_ingestion.crystal_pdf_ingest.tempfile.mkdtemp",
        lambda **_kwargs: str(work),
    )
    args = MagicMock()
    args.site = "crystal"
    args.s3_prefix = None
    args.replace_library = False
    args.local_dir = None

    run_pdf(
        args,
        publisher=publisher,
        repo_root=tmp_path,
        runner=lambda *_args, **_kwargs: None,
        represented_basenames=set(),
        represented_titles=set(),
    )

    assert not work.exists()


def test_read_dotenv_value_reads_archive_bucket(tmp_path):
    env_file = tmp_path / ".env.ananda"
    env_file.write_text("OPENAI_API_KEY=secret\nS3_BUCKET_NAME=ananda-chatbot\n")

    assert read_dotenv_value(env_file, "S3_BUCKET_NAME") == "ananda-chatbot"
