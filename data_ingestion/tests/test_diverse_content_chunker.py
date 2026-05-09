import gzip
import json
import os
import sys
from pathlib import Path

import pdfplumber
import pytest
import spacy

# Add the parent directory to the path so we can find the utils module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from utils.text_splitter_utils import SpacyTextSplitter

os.environ.setdefault("OPENAI_INGEST_EMBEDDINGS_MODEL", "text-embedding-ada-002")

# Load spaCy English model
try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    print(
        "ERROR: spaCy model 'en_core_web_sm' not found. Install with: python -m spacy download en_core_web_sm"
    )
    sys.exit(1)

# Define paths for diverse content types
CONTENT_PATHS = {
    "spiritual_books": Path("media/pdf-docs/crystal"),
    "transcriptions": Path("media/transcriptions"),
    "wordpress_content": Path("media/pdf-docs"),
}

# Output log file
LOG_FILE = Path("chunker_test_results.log")

# Target word range for chunks
target_word_range = (225, 450)


def read_pdf_content(file_path):
    """Read content from a PDF file using pdfplumber, limiting to first 2 pages to reduce processing time."""
    try:
        with pdfplumber.open(file_path) as pdf:
            text = ""
            for i, page in enumerate(pdf.pages):
                if i >= 2:  # Limit to first 2 pages
                    break
                text += page.extract_text() + "\n"
            return (
                text[:5000]
                if text.strip()
                else "No text content extracted from " + str(file_path)
            )  # Limit to 5000 chars
    except Exception as e:
        return f"Error reading PDF {file_path}: {e}"


def read_json_gz_content(file_path):
    """Read content from a gzipped JSON file, limiting to first 5000 characters."""
    try:
        with gzip.open(file_path, "rt", encoding="utf-8") as f:
            data = json.load(f)
            text = data.get("text", "No text content found")
            return text[:5000]  # Limit to 5000 chars to reduce processing time
    except Exception as e:
        return f"Error reading {file_path}: {e}"


@pytest.fixture(
    params=[
        ("spiritual_books", Path("media/pdf-docs/crystal")),
        ("transcriptions", Path("media/transcriptions")),
        ("wordpress_content", Path("media/pdf-docs")),
    ]
)
def content_data(request):
    """Fixture providing content type and path pairs."""
    return request.param


def process_content_for_testing(content_data):
    """Process content for testing the chunker on the specified content type from the given path."""
    content_type, content_path = content_data

    if not content_path.exists():
        pytest.skip(f"Path for {content_type} does not exist: {content_path}")

    splitter = SpacyTextSplitter()
    results = []
    files_processed = 0
    total_chunks = 0

    for file_path in content_path.glob("**/*"):
        if files_processed >= 3:  # Limit to 3 samples per content type for brevity
            break
        if file_path.is_file():
            if content_type == "transcriptions" and file_path.suffixes == [
                ".json",
                ".gz",
            ]:
                content = read_json_gz_content(file_path)
            elif (
                content_type in ["spiritual_books", "wordpress_content"]
                and file_path.suffix == ".pdf"
            ):
                content = read_pdf_content(file_path)
            else:
                continue

            if content and len(content) > 100:  # Ensure there's substantial content
                chunks = splitter.split_text(content)
                word_counts = [len(chunk.split()) for chunk in chunks]
                total_chunks += len(chunks)
                files_processed += 1

                # Log details
                result = {
                    "file": str(file_path),
                    "content_type": content_type,
                    "total_words": len(content.split()),
                    "chunk_count": len(chunks),
                    "word_counts": word_counts,
                    "within_target_range": sum(
                        1
                        for wc in word_counts
                        if target_word_range[0] <= wc <= target_word_range[1]
                    ),
                }
                results.append(result)

    summary = f"Summary for {content_type}:\n"
    summary += f"  Files processed: {files_processed}\n"
    summary += f"  Total chunks: {total_chunks}\n"
    for res in results:
        summary += f"  File: {res['file']}\n"
        summary += f"    Total words: {res['total_words']}\n"
        summary += (
            f"    Chunks: {res['chunk_count']}, Words per chunk: {res['word_counts']}\n"
        )
        summary += f"    Chunks within target range ({target_word_range[0]}-{target_word_range[1]}): {res['within_target_range']}/{res['chunk_count']}\n"

    return summary, results, files_processed, total_chunks


def test_chunker_on_content(content_data):
    """Test the chunker on the specified content type from the given path using assertions."""
    summary, results, files_processed, total_chunks = process_content_for_testing(
        content_data
    )
    content_type, _ = content_data
    assert isinstance(summary, str), (
        f"Expected summary to be a string, got {type(summary)}"
    )
    assert f"Summary for {content_type}:" in summary, (
        f"Expected summary to mention {content_type}"
    )
    assert "Files processed:" in summary, "Expected 'Files processed' in summary"
    assert files_processed <= 3, (
        f"Expected no more than 3 files processed, got {files_processed}"
    )
    if files_processed > 0:
        assert total_chunks > 0, (
            "Expected chunks to be created when files are processed"
        )
        assert len(results) == files_processed, (
            f"Expected {files_processed} results, got {len(results)}"
        )


def main():
    """Main function to test chunker on diverse content types."""
    with open(LOG_FILE, "w") as log:
        for content_type, path in CONTENT_PATHS.items():
            result = test_chunker_on_content(content_type, path)
            log.write(result + "\n")
            log.write("-" * 50 + "\n")
            print(result)

    print(f"Results logged to {LOG_FILE}")


if __name__ == "__main__":
    main()
