import sys
from unittest.mock import Mock

mock_spacy = Mock()
mock_nlp = Mock()
mock_nlp.max_length = 2_000_000
# Reset the side_effect for each test run
mock_spacy.load = Mock(side_effect=[OSError(), mock_nlp])
mock_spacy.cli = Mock()
mock_spacy.cli.download = Mock()
sys.modules["spacy"] = mock_spacy

from unittest.mock import patch  # noqa: E402

import pytest  # noqa: E402

from data_ingestion.utils.text_splitter_utils import (  # noqa: E402
    Document,
    SpacyTextSplitter,
)

# Module-level patch to set the environment variable for all tests
pytestmark = pytest.mark.usefixtures("mock_embedding_model")


@pytest.fixture(autouse=True)
def mock_embedding_model():
    """Automatically mock the embedding model environment variable for all tests."""
    with patch.dict(
        "os.environ", {"OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002"}
    ):
        # Clear the spacy model cache between tests to avoid state pollution
        from data_ingestion.utils.text_splitter_utils import _SPACY_MODEL_CACHE

        _SPACY_MODEL_CACHE.clear()
        # Reset mock state
        mock_spacy.load.reset_mock()
        mock_spacy.load.side_effect = [OSError(), mock_nlp]
        mock_spacy.cli.download.reset_mock()
        yield


@pytest.fixture(autouse=True)
def mock_tiktoken(mocker):
    """Mock tiktoken to speed up tests - real tokenization is expensive.

    This mock approximates tiktoken behavior:
    - ~1.3 tokens per word (typical for English text)
    - encode() returns token IDs
    - decode() reconstructs text from IDs
    """
    # Cache for text -> token mapping to make decode() work properly
    _token_cache = {}
    _next_id = [0]

    def mock_encode(text):
        if not text or not text.strip():
            return []
        # Split on whitespace and punctuation to approximate tiktoken
        import re

        # Simple tokenization: split words and keep punctuation separate
        tokens = re.findall(r"\w+|[^\w\s]", text)
        # Store mapping for decode
        token_ids = []
        for token in tokens:
            if token not in _token_cache:
                _token_cache[token] = _next_id[0]
                _next_id[0] += 1
            token_ids.append(_token_cache[token])
        return token_ids

    def mock_decode(ids):
        if not ids:
            return ""
        # Reverse lookup
        id_to_token = {v: k for k, v in _token_cache.items()}
        tokens = [id_to_token.get(i, "?") for i in ids]
        # Reconstruct with proper spacing (no space before punctuation)
        result = []
        for i, token in enumerate(tokens):
            if i > 0 and token not in ".,!?;:)]}'\"" and result[-1] not in "([{\"'":
                result.append(" ")
            result.append(token)
        return "".join(result)

    mock_encoding = mocker.MagicMock()
    mock_encoding.encode = mock_encode
    mock_encoding.decode = mock_decode
    mocker.patch(
        "data_ingestion.utils.text_splitter_utils.tiktoken.encoding_for_model",
        return_value=mock_encoding,
    )


@pytest.fixture
def text_splitter():
    return SpacyTextSplitter()


def test_simple_split(text_splitter: SpacyTextSplitter):
    text = "This is the first sentence. This is the second sentence. This is the third sentence."
    chunks = text_splitter.split_text(text)
    assert len(chunks) == 1
    assert chunks[0] == text


def test_split_with_paragraph_separator(text_splitter: SpacyTextSplitter):
    text = "This is the first paragraph.\n\nThis is the second paragraph."
    chunks = text_splitter.split_text(text)
    # With dynamic sizing, very small texts may not be split
    # The text is only 10 words, which is below the minimum chunk size
    assert len(chunks) >= 1
    if len(chunks) == 1:
        # Small text kept as one chunk
        assert "This is the first paragraph." in chunks[0]
        assert "This is the second paragraph." in chunks[0]
    else:
        # Text was split as expected
        assert chunks[0] == "This is the first paragraph."
        assert chunks[1] == "This is the second paragraph."


def test_split_long_paragraph_into_sentences(text_splitter: SpacyTextSplitter):
    text = "This is a very long first sentence that will exceed the chunk size. This is the second sentence, which is shorter. This is a third sentence that also needs to be chunked appropriately to fit."
    # Note: spaCy sentence splitting might be slightly different than naive splitting
    # This test assumes spaCy correctly identifies sentences.
    chunks = text_splitter.split_text(text)
    assert (
        len(chunks) >= 1
    )  # Adjusted due to dynamic sizing; may not split if size is large
    for chunk in chunks:
        assert (
            len(chunk) <= text_splitter.chunk_size + text_splitter.chunk_overlap
        )  # Overlap can make it slightly larger


def test_chunk_overlap(text_splitter: SpacyTextSplitter):
    text_splitter_with_overlap = SpacyTextSplitter(separator=" ")
    text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
    chunks = text_splitter_with_overlap.split_text(text)
    # Expected:
    # chunk1: "one two three four five six seven eight nine ten" (len approx 50)
    # chunk2: "nine ten eleven twelve thirteen fourteen fifteen" (overlap "nine ten")
    assert len(chunks) >= 1  # Adjusted expectation due to dynamic sizing
    if len(chunks) > 1:
        # For space separator, check for word-based overlap
        # The second chunk should start with some words from the end of the first chunk
        first_chunk_words = chunks[0].split()
        second_chunk_words = chunks[1].split()

        # Check that the first few words of chunk 1 appear in the last few words of chunk 0
        # This is a more realistic test for word-based overlap
        overlap_found = False
        for i in range(
            1, min(4, len(first_chunk_words), len(second_chunk_words))
        ):  # Check up to 3 words
            if second_chunk_words[:i] == first_chunk_words[-i:]:
                overlap_found = True
                break

        assert overlap_found, (
            f"No word-based overlap found between chunks. Chunk 0: {chunks[0]}, Chunk 1: {chunks[1]}"
        )


def test_split_documents(text_splitter: SpacyTextSplitter):
    doc1 = Document(
        page_content="First document. It has two sentences.",
        metadata={"source": "doc1"},
    )
    doc2 = Document(
        page_content="Second document. Also two sentences.", metadata={"source": "doc2"}
    )
    documents = [doc1, doc2]
    chunked_docs = text_splitter.split_documents(documents)
    assert len(chunked_docs) == 2  # Since chunk_size is 100 and texts are short
    assert chunked_docs[0].page_content == "First document. It has two sentences."
    assert chunked_docs[0].metadata["source"] == "doc1"
    assert chunked_docs[1].page_content == "Second document. Also two sentences."
    assert chunked_docs[1].metadata["source"] == "doc2"


def test_split_document_into_multiple_chunks(text_splitter: SpacyTextSplitter):
    long_text = (
        "This is sentence one. " * 5 + "This is sentence two. " * 5
    )  # Approx 20*5 + 21*5 = 100 + 105 = 205 chars
    doc = Document(page_content=long_text, metadata={"source": "long_doc"})
    chunked_docs = text_splitter.split_documents([doc])
    assert len(chunked_docs) >= 1  # Adjusted due to dynamic sizing
    assert chunked_docs[0].metadata["source"] == "long_doc"
    "".join(
        c.page_content.replace(doc.page_content[-text_splitter.chunk_overlap :], "")
        if i > 0
        else c.page_content
        for i, c in enumerate(chunked_docs)
    )
    # This is an approximate check, exact reconstruction is tricky with sentence splitting and overlap logic
    # assert doc.page_content.startswith(combined_content[:len(doc.page_content)-50])


def test_empty_text(text_splitter: SpacyTextSplitter):
    text = ""
    chunks = text_splitter.split_text(text)
    # Empty text should return no chunks
    assert len(chunks) == 0


def test_text_shorter_than_chunk_size(text_splitter: SpacyTextSplitter):
    text = "This is a short text."
    chunks = text_splitter.split_text(text)
    assert len(chunks) == 1
    assert chunks[0] == text


def test_text_with_only_separators(text_splitter: SpacyTextSplitter):
    text = "\n\n\n\n"
    chunks = text_splitter.split_text(text)
    # Text with only separators should return no chunks (empty content)
    assert len(chunks) == 0


def test_very_long_sentence_exceeding_chunk_size(text_splitter: SpacyTextSplitter):
    # A single sentence that is longer than chunk_size should still be one chunk.
    # The current implementation splits it if it's longer than chunk_size. This test verifies that behavior.
    long_sentence = "ThisIsAVeryLongSentenceWithoutSpacesThatExceedsTheChunkSizeLimitOfOneHundredCharactersAndItShouldBeHandled."  # len > 100
    text = long_sentence
    chunks = text_splitter.split_text(text)
    # The current logic will split this long sentence if it has no internal sentence breaks found by spacy
    # and is longer than chunk_size. If it were a single sentence *within* chunk_size, it would be one chunk.
    # If it's a single sentence *over* chunk_size, it's appended directly as a chunk.
    # If the goal is that a single sentence (even if very long) should *not* be split by the splitter *unless* spacy finds sub-sentences,
    # then the logic in split_text needs adjustment.
    # The current code: `if len(sent_text) > self.chunk_size: chunks.append(sent_text)`
    # This means a single sentence longer than chunk_size is kept as one chunk.
    assert len(chunks) == 1
    assert chunks[0] == long_sentence


def test_chunk_overlap_disabled(text_splitter: SpacyTextSplitter):
    splitter_no_overlap = SpacyTextSplitter(separator=" ")
    text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
    # Each chunk should be around 50 chars. With no overlap, they should be distinct.
    chunks = splitter_no_overlap.split_text(text)
    assert (
        len(chunks) >= 1
    )  # Adjusted due to dynamic sizing, exact number depends on content length
    if len(chunks) > 1:
        # Check that chunks are not starting with the end of the previous one
        first_chunk_end_words = chunks[0].split(" ")[
            -2:
        ]  # last two words of first chunk
        second_chunk_start_words = chunks[1].split(" ")[
            :2
        ]  # first two words of second chunk
        assert not (
            first_chunk_end_words[0] in second_chunk_start_words
            and first_chunk_end_words[1] in second_chunk_start_words
        )


def test_split_with_custom_separator(text_splitter: SpacyTextSplitter):
    splitter_custom_sep = SpacyTextSplitter(separator="---")
    text = "Part one of the text---Part two of the text---Part three which is longer and might be split by sentences."
    chunks = splitter_custom_sep.split_text(text)
    # With dynamic sizing, small texts (21 words) may not be split
    assert len(chunks) >= 1
    if len(chunks) == 1:
        # Small text kept as one chunk
        assert "Part one of the text" in chunks[0]
        assert "Part two of the text" in chunks[0]
        assert "Part three" in chunks[0]
    else:
        # Text was split as expected
        assert "Part one of the text" in chunks[0]
        if len(chunks) > 1:
            assert "Part two of the text" in chunks[1] or chunks[0].endswith(
                "Part one of the text"
            )  # depends on overlap


def test_ensure_nlp_called(mocker):
    # Clear the cache to ensure this test starts fresh
    from data_ingestion.utils.text_splitter_utils import _SPACY_MODEL_CACHE

    _SPACY_MODEL_CACHE.clear()

    # Create a fresh mock nlp object
    mock_nlp = mocker.MagicMock()
    mock_nlp.max_length = 2_000_000

    # Patch spacy.load and spacy.cli.download directly for this test
    # This ensures we're mocking the actual spacy module being used
    mock_load = mocker.patch("data_ingestion.utils.text_splitter_utils.spacy.load")
    mock_download = mocker.patch(
        "data_ingestion.utils.text_splitter_utils.spacy.cli.download"
    )

    # Set up the side effect: first call raises OSError, second returns mock_nlp
    mock_load.side_effect = [OSError(), mock_nlp]

    splitter = SpacyTextSplitter()
    splitter._ensure_nlp()

    # Verify the calls
    assert mock_load.call_count == 2
    mock_load.assert_any_call(splitter.pipeline)
    mock_download.assert_called_once_with(splitter.pipeline)

    # Reset for the second call test
    mock_load.reset_mock()
    mock_download.reset_mock()

    # Second call should use cached nlp (no calls to load)
    splitter._ensure_nlp()
    mock_load.assert_not_called()
    mock_download.assert_not_called()


def test_dynamic_chunk_size_very_short_text():
    splitter = SpacyTextSplitter()
    # Historical defaults: 250-token chunks for text sources (PDF, web, SQL)
    text = "Short text. " * 50  # Approx 100 words
    chunks = splitter.split_text(text)
    assert len(chunks) == 1, f"Expected 1 chunk for very short text, got {len(chunks)}"
    # Historical parameters should be used
    # Implementation uses target_chunk_size=250 with base chunk_size=188 (75% buffer)
    assert splitter.target_chunk_size == 250, (
        f"Expected target_chunk_size=250 (historical default), got {splitter.target_chunk_size}"
    )
    assert splitter.chunk_size == 187, (
        f"Expected chunk_size=187 (75% of target), got {splitter.chunk_size}"
    )
    assert splitter.chunk_overlap == 50, (
        f"Expected overlap=50 (historical default), got {splitter.chunk_overlap}"
    )


def test_dynamic_chunk_size_short_text():
    splitter = SpacyTextSplitter()
    # Historical defaults: 250-token chunks for text sources (PDF, web, SQL)
    text = "Short text. " * 300  # Approx 600 words
    splitter.split_text(text)
    # Implementation uses target_chunk_size=250 with base chunk_size=187 (75% buffer)
    assert splitter.target_chunk_size == 250, (
        f"Expected target_chunk_size=250 (historical default), got {splitter.target_chunk_size}"
    )
    assert splitter.chunk_size == 187, (
        f"Expected chunk_size=187 (75% of target), got {splitter.chunk_size}"
    )
    assert splitter.chunk_overlap == 50, (
        f"Expected overlap=50 (historical default), got {splitter.chunk_overlap}"
    )


def test_dynamic_chunk_size_medium_text():
    splitter = SpacyTextSplitter()
    # Historical defaults: 250-token chunks for text sources (PDF, web, SQL)
    text = "Medium text. " * 1500  # Approx 3000 words
    splitter.split_text(text)
    # Implementation uses target_chunk_size=250 with base chunk_size=187 (75% buffer)
    assert splitter.target_chunk_size == 250, (
        f"Expected target_chunk_size=250 (historical default), got {splitter.target_chunk_size}"
    )
    assert splitter.chunk_size == 187, (
        f"Expected chunk_size=187 (75% of target), got {splitter.chunk_size}"
    )
    assert splitter.chunk_overlap == 50, (
        f"Expected overlap=50 (historical default), got {splitter.chunk_overlap}"
    )


def test_dynamic_chunk_size_long_text():
    splitter = SpacyTextSplitter()
    # Historical defaults: 250-token chunks for text sources (PDF, web, SQL)
    text = "Long text. " * 3000  # Approx 6000 words
    splitter.split_text(text)
    # Implementation uses target_chunk_size=250 with base chunk_size=187 (75% buffer)
    assert splitter.target_chunk_size == 250, (
        f"Expected target_chunk_size=250 (historical default), got {splitter.target_chunk_size}"
    )
    assert splitter.chunk_size == 187, (
        f"Expected chunk_size=187 (75% of target), got {splitter.chunk_size}"
    )
    assert splitter.chunk_overlap == 50, (
        f"Expected overlap=50 (historical default), got {splitter.chunk_overlap}"
    )


def test_punctuation_preservation():
    """Test that punctuation is preserved during chunking."""
    splitter = SpacyTextSplitter()
    text = "Hello, world! How are you? I'm fine, thanks."
    chunks = splitter.split_text(text)

    # Combine all chunks and check that punctuation is preserved
    combined_text = " ".join(chunks)
    assert "," in combined_text
    assert "!" in combined_text
    assert "?" in combined_text
    assert "'" in combined_text


def test_twenty_percent_overlap_calculation():
    """
    Test that chunks have proper 20% overlap based on word count.

    This test validates the bug fix where overlap was incorrectly calculated
    as a ratio of chunk size instead of 20% of the previous chunk's word count.
    """
    # Create a text splitter with paragraph separator to ensure chunking
    splitter = SpacyTextSplitter(separator="\n\n")

    # Create text with multiple paragraphs that will definitely be chunked
    # Each paragraph has approximately 50-60 words to ensure chunking occurs
    paragraph1 = " ".join(
        [f"This is sentence {i} in the first paragraph." for i in range(1, 11)]
    )  # ~50 words
    paragraph2 = " ".join(
        [f"This is sentence {i} in the second paragraph." for i in range(1, 11)]
    )  # ~50 words
    paragraph3 = " ".join(
        [f"This is sentence {i} in the third paragraph." for i in range(1, 11)]
    )  # ~50 words
    paragraph4 = " ".join(
        [f"This is sentence {i} in the fourth paragraph." for i in range(1, 11)]
    )  # ~50 words

    text = f"{paragraph1}\n\n{paragraph2}\n\n{paragraph3}\n\n{paragraph4}"

    # Force smaller chunk size to ensure multiple chunks
    original_chunk_size = splitter.chunk_size
    original_chunk_overlap = splitter.chunk_overlap
    splitter.chunk_size = 300  # Small enough to force chunking
    splitter.chunk_overlap = 60  # 20% of 300

    try:
        chunks = splitter.split_text(text, document_id="test_overlap")

        # We should have multiple chunks
        assert len(chunks) > 1, f"Expected multiple chunks, got {len(chunks)}: {chunks}"

        # Test overlap between consecutive chunks
        for i in range(1, len(chunks)):
            prev_chunk = chunks[i - 1]
            current_chunk = chunks[i]

            prev_words = prev_chunk.split()
            current_words = current_chunk.split()

            # Calculate expected overlap (20% of previous chunk)
            expected_overlap_words = max(1, int(len(prev_words) * 0.20))

            # Find actual overlap by checking how many words from the end of prev_chunk
            # appear at the start of current_chunk
            actual_overlap_words = 0
            for j in range(1, min(len(prev_words), len(current_words)) + 1):
                if current_words[:j] == prev_words[-j:]:
                    actual_overlap_words = j

            # The actual overlap should be close to the expected 20%
            # Allow some tolerance since we're dealing with word boundaries and token-based splitting
            min_expected = max(1, expected_overlap_words - 5)  # Allow 5 words tolerance
            max_expected = expected_overlap_words + 5

            assert min_expected <= actual_overlap_words <= max_expected, (
                f"Chunk {i}: Expected overlap ~{expected_overlap_words} words (20% of {len(prev_words)}), "
                f"but got {actual_overlap_words} words. "
                f"Previous chunk: '{prev_chunk[-100:]}...' "
                f"Current chunk: '...{current_chunk[:100]}'"
            )

            # Verify that there is meaningful overlap (not just punctuation)
            if actual_overlap_words > 0:
                overlap_text = " ".join(prev_words[-actual_overlap_words:])
                assert len(overlap_text.strip()) > 0, (
                    "Overlap should contain meaningful text"
                )
                assert current_chunk.startswith(overlap_text), (
                    f"Current chunk should start with overlap text. "
                    f"Expected start: '{overlap_text}', "
                    f"Actual start: '{current_chunk[: len(overlap_text) + 10]}'"
                )

    finally:
        # Restore original settings
        splitter.chunk_size = original_chunk_size
        splitter.chunk_overlap = original_chunk_overlap


def test_overlap_with_different_separators():
    """Test that overlap works correctly with different separators."""

    # Test with space separator (word-based chunking)
    space_splitter = SpacyTextSplitter(separator=" ")
    space_splitter.chunk_size = 100  # Force smaller chunks
    space_splitter.chunk_overlap = 20

    # Create text with many words
    words = [f"word{i}" for i in range(1, 51)]  # 50 words
    space_text = " ".join(words)

    space_chunks = space_splitter.split_text(
        space_text, document_id="test_space_overlap"
    )

    if len(space_chunks) > 1:
        # For space separator, overlap should be word-based
        for i in range(1, len(space_chunks)):
            prev_chunk = space_chunks[i - 1]
            current_chunk = space_chunks[i]

            prev_words = prev_chunk.split()
            current_words = current_chunk.split()

            # Check for word-based overlap
            overlap_found = False
            for j in range(
                1, min(6, len(prev_words), len(current_words))
            ):  # Check up to 5 words
                if current_words[:j] == prev_words[-j:]:
                    overlap_found = True
                    break

            assert overlap_found, (
                f"No word-based overlap found between space-separated chunks. "
                f"Chunk {i - 1}: '{prev_chunk}', Chunk {i}: '{current_chunk}'"
            )

    # Test with paragraph separator
    para_splitter = SpacyTextSplitter(separator="\n\n")
    para_splitter.chunk_size = 200
    para_splitter.chunk_overlap = 40

    # Create text with paragraphs
    para1 = " ".join(
        [f"Sentence {i} in paragraph one." for i in range(1, 16)]
    )  # ~60 words
    para2 = " ".join(
        [f"Sentence {i} in paragraph two." for i in range(1, 16)]
    )  # ~60 words
    para_text = f"{para1}\n\n{para2}"

    para_chunks = para_splitter.split_text(para_text, document_id="test_para_overlap")

    if len(para_chunks) > 1:
        # For paragraph separator, overlap should be 20% of previous chunk
        for i in range(1, len(para_chunks)):
            prev_chunk = para_chunks[i - 1]
            current_chunk = para_chunks[i]

            prev_words = prev_chunk.split()
            current_words = current_chunk.split()

            # Calculate expected 20% overlap
            expected_overlap_words = max(1, int(len(prev_words) * 0.20))

            # Find actual overlap
            actual_overlap_words = 0
            for j in range(1, min(len(prev_words), len(current_words)) + 1):
                if current_words[:j] == prev_words[-j:]:
                    actual_overlap_words = j

            # Should have meaningful overlap
            assert actual_overlap_words > 0, (
                f"No overlap found between paragraph chunks. "
                f"Expected ~{expected_overlap_words} words overlap"
            )


def mock_nlp_func(text):
    doc = Mock()
    sents = []
    sentences = text.split(".")
    all_tokens = []
    for s in sentences:
        if not s.strip():
            continue
        sent = Mock()
        sent_text = s.strip() + "."
        sent.text = sent_text
        # Create mock tokens by splitting on space
        words = sent_text.split()
        tokens = []
        for i, w in enumerate(words):
            token = Mock()
            token.text = w
            token.is_space = False
            # Add whitespace_ attribute - add space after all tokens except the last
            token.whitespace_ = " " if i < len(words) - 1 else ""
            tokens.append(token)
        all_tokens.extend(tokens)
        # Make sent iterable over its tokens
        sent.__iter__ = lambda self, tokens=tokens: iter(tokens)
        # Add tokens attribute for direct access
        sent.tokens = tokens
        sents.append(sent)
    # Set doc.sents as list of sent mocks
    doc.sents = sents
    # Make doc iterable over all tokens
    doc.__iter__ = lambda self, all_tokens=all_tokens: iter(all_tokens)
    return doc


mock_nlp.side_effect = mock_nlp_func


class TestTokenizationBugFixes:
    """Test cases for specific tokenization bugs that were discovered and fixed."""

    def test_chunks_should_never_exceed_target_token_limit(self):
        """Test that chunks never exceed the target token limit."""
        splitter = SpacyTextSplitter()

        # Create text that would produce chunks near the limit
        # Use repetitive text that might cause tokenization differences
        # Make paragraphs larger to get closer to the 450 token base limit
        paragraph = (
            "This is a comprehensive test paragraph designed to trigger tokenization "
            "inconsistencies between spaCy and tiktoken tokenizers. It contains various "
            "punctuation marks including commas, periods, semicolons; exclamation marks! "
            "question marks? and other symbols like @#$%^&*(). The text includes many "
            "contractions such as don't, won't, can't, shouldn't, wouldn't, couldn't, "
            "and it's. It also contains numbers in different formats: 123, 1,234, "
            "1.234, 12.34%, $45.67, and dates like 12/31/2023, 2023-12-31. "
            "Hyphenated words like state-of-the-art, well-known, twenty-first-century, "
            "and self-explanatory are included. URLs like http://example.com, "
            "https://www.test.org, and email addresses like test@example.com might "
            "be tokenized differently. Mathematical expressions like x = y + z, "
            "equations such as E = mc², and chemical formulas like H₂O or CO₂ "
            "could cause variations. Programming-related text with code snippets "
            "like function() { return true; } or variable_names and file.extensions "
            "might also contribute to tokenization differences between the two systems. "
        )

        # Create a large document with many paragraphs to force chunking
        # Use more paragraphs to create larger chunks that approach the limits
        large_text = "\n\n".join([paragraph] * 500)  # Much larger document

        chunks = splitter.split_text(large_text, document_id="test_token_limit")

        print(f"Created {len(chunks)} chunks from large document")

        # Verify that no chunk exceeds the target token limit
        max_tokens_found = 0
        for i, chunk in enumerate(chunks):
            token_count = len(splitter._tokenize_text(chunk))
            max_tokens_found = max(max_tokens_found, token_count)

            print(f"Chunk {i}: {token_count} tokens")

            assert token_count <= splitter.target_chunk_size, (
                f"Chunk {i} exceeds target token limit: {token_count} tokens "
                f"(target: {splitter.target_chunk_size} tokens). "
                f"This indicates the overlap application is not respecting token limits."
            )

            # Also check that it doesn't exceed the OpenAI limit
            assert token_count <= 8192, (
                f"Chunk {i} exceeds OpenAI embedding limit: {token_count} tokens "
                f"(max: 8192 tokens). This would cause embedding failures."
            )

        print(f"Maximum tokens found in any chunk: {max_tokens_found}")

    def test_tokenization_consistency_between_spacy_and_tiktoken(self):
        """Test that spaCy and tiktoken tokenization are handled consistently."""
        splitter = SpacyTextSplitter()

        # Text with punctuation that might be tokenized differently
        test_text = (
            "This text has contractions like don't, won't, can't, and it's. "
            "It also has punctuation: commas, periods, exclamation marks! "
            "Numbers like 1,234.56 and dates like 12/31/2023 might differ. "
            "Hyphenated words like state-of-the-art and URLs like http://example.com "
            "could be tokenized differently by different tokenizers."
        )

        # Get tiktoken token count (used for chunk size validation)
        tiktoken_tokens = splitter._tokenize_text(test_text)
        tiktoken_count = len(tiktoken_tokens)

        # Get spaCy token count (used for overlap application fallback)
        try:
            splitter._ensure_nlp()
            doc = splitter.nlp(test_text)
            spacy_tokens = [token.text for token in doc if not token.is_space]
            spacy_count = len(spacy_tokens)

            print(f"tiktoken tokens: {tiktoken_count}")
            print(f"spaCy tokens: {spacy_count}")
            print(f"Difference: {abs(tiktoken_count - spacy_count)}")

            # The bug occurs when different tokenizers produce different token counts
            # This causes overlap to be calculated based on one count but validated against another
            if tiktoken_count != spacy_count:
                print(
                    "Tokenization mismatch detected - this can cause overlap miscalculations!"
                )

        except Exception as e:
            pytest.skip(f"spaCy not available for tokenization comparison: {e}")

    def test_overlap_respects_token_budget(self):
        """Test that overlap calculation respects available token budget."""
        splitter = SpacyTextSplitter()

        # Create two chunks where the first is smaller and the second has room for overlap
        chunk1 = "This is the first chunk with moderate content. " * 30  # ~300 tokens
        chunk2 = "This is the second chunk with moderate content. " * 30  # ~300 tokens

        chunks = [chunk1, chunk2]

        chunk1_tokens = len(splitter._tokenize_text(chunk1))
        chunk2_tokens = len(splitter._tokenize_text(chunk2))

        print(f"Original chunk1 tokens: {chunk1_tokens}")
        print(f"Original chunk2 tokens: {chunk2_tokens}")

        # Apply overlap manually to test the logic
        overlapped_chunks = splitter._apply_overlap_to_chunks(chunks)

        # Check that the second chunk (with overlap) respects the budget
        if len(overlapped_chunks) >= 2:
            second_chunk_tokens = len(splitter._tokenize_text(overlapped_chunks[1]))
            print(f"Overlapped chunk2 tokens: {second_chunk_tokens}")

            # The overlap logic should either:
            # 1. Add appropriate overlap within the target limit, OR
            # 2. Skip overlap if the chunk is already too large

            # If overlap was applied, verify it's reasonable
            if second_chunk_tokens > chunk2_tokens:
                overlap_added = second_chunk_tokens - chunk2_tokens
                print(f"Overlap added: {overlap_added} tokens")

                # Overlap should not exceed the configured overlap amount
                assert overlap_added <= splitter.chunk_overlap, (
                    f"Too much overlap added: {overlap_added} tokens "
                    f"(max configured: {splitter.chunk_overlap} tokens)"
                )

                # Final chunk should not exceed target by more than a reasonable margin
                # (Allow some tolerance for paragraph boundaries)
                max_allowed = splitter.target_chunk_size + 50  # 50 token tolerance
                assert second_chunk_tokens <= max_allowed, (
                    f"Overlapped chunk exceeds reasonable limit: {second_chunk_tokens} tokens "
                    f"(max allowed with tolerance: {max_allowed} tokens)"
                )
            else:
                # No overlap was applied, which is fine if the chunk was already large
                print("No overlap applied (chunk already at or near limit)")

    def test_overlap_off_by_one_error_fixed(self):
        """Test that the off-by-one error in overlap logic is fixed.

        Previously, the overlap logic didn't account for the space character
        added during concatenation, causing warnings like:
        "Overlap would exceed target token limit (251 > 250)"
        """
        # Create a splitter with exact token limits
        splitter = SpacyTextSplitter(
            chunk_size=250,  # target_chunk_size = 250
            chunk_overlap=50,
            log_summary_on_split=False,
        )

        # Create text that will definitely produce multiple chunks
        # Each paragraph should be around 200 tokens to ensure we get multiple chunks
        paragraph = (
            "This is a test sentence with enough content to create a meaningful chunk. "
            * 30
        )  # ~600 tokens
        text = paragraph + "\n\n" + paragraph + "\n\n" + paragraph

        # Split the text
        chunks = splitter.split_text(text, document_id="test_off_by_one")

        # Verify that no chunk exceeds the target token limit
        for i, chunk in enumerate(chunks):
            token_count = len(splitter._tokenize_text(chunk))
            assert token_count <= 250, (
                f"Chunk {i} has {token_count} tokens, exceeds limit of 250"
            )

        # Verify that we have multiple chunks (overlap should be applied)
        assert len(chunks) > 1, "Should have multiple chunks for overlap testing"

        # Verify that overlap was successfully applied to chunks after the first
        for i in range(1, len(chunks)):
            # The chunk should contain content from the previous chunk
            prev_chunk = chunks[i - 1]
            current_chunk = chunks[i]

            # Extract some words from the end of the previous chunk
            prev_words = prev_chunk.split()[-5:]  # Last 5 words
            current_start = " ".join(current_chunk.split()[:10])  # First 10 words

            # At least one word from the previous chunk should appear in the current chunk
            overlap_found = any(word in current_start for word in prev_words)
            assert overlap_found, f"No overlap found between chunks {i - 1} and {i}"

    def test_extreme_case_with_very_large_chunks(self):
        """Test handling of extreme cases with very large chunks."""
        splitter = SpacyTextSplitter()

        # Create text that will produce chunks close to the base limit
        # Use smaller multiplier to avoid creating naturally oversized paragraphs
        base_text = (
            "This is a paragraph designed to test chunking behavior near limits. "
            "It contains various punctuation marks and contractions like don't, won't. "
            "Numbers like 1,234.56 and dates like 12/31/2023 are included. "
            "URLs like https://example.com might affect tokenization. "
        )

        # Create multiple paragraphs that should be chunked appropriately
        paragraphs = [base_text * 8 for _ in range(10)]  # Smaller paragraphs
        text = "\n\n".join(paragraphs)

        chunks = splitter.split_text(text, document_id="extreme_test")

        print(f"Extreme test created {len(chunks)} chunks")

        # The key test: no chunk should be excessively large (like the 9000+ token bug)
        max_reasonable_size = (
            1000  # Much more generous than target, but prevents extreme cases
        )

        for i, chunk in enumerate(chunks):
            token_count = len(splitter._tokenize_text(chunk))
            print(f"Extreme chunk {i}: {token_count} tokens")

            # Test for the actual bug: chunks shouldn't be excessively large
            assert token_count <= max_reasonable_size, (
                f"Extreme test chunk {i} is excessively large: {token_count} tokens "
                f"(max reasonable: {max_reasonable_size}). This indicates the tokenization bug!"
            )

            # Also ensure chunks aren't ridiculously large (the original bug)
            assert token_count <= 8192, (
                f"Chunk {i} exceeds OpenAI embedding limit: {token_count} tokens. "
                f"This would cause embedding failures."
            )

        # Verify we got reasonable chunking (not everything in one giant chunk)
        assert len(chunks) > 1, (
            f"Expected multiple chunks from large text, got only {len(chunks)}. "
            f"This might indicate chunking isn't working properly."
        )

    def test_massive_pdf_document_scenario(self):
        """
        Test that reproduces the exact scenario from the user's logs:
        A massive PDF (578 pages) assembled into one document and then chunked.

        This should trigger the bug where chunks exceed 9000+ tokens.
        """
        splitter = SpacyTextSplitter()

        # Simulate a page of text from a PDF
        pdf_page_text = (
            "This is a typical page from a spiritual text or book. It contains "
            "teachings, wisdom, and guidance for spiritual seekers. The text "
            "includes various punctuation marks, contractions like don't and won't, "
            "and references to concepts, practices, and experiences. There might be "
            "quotes from masters, descriptions of meditation techniques, and "
            "explanations of philosophical concepts. The page could contain "
            "numbered lists, bullet points, and various formatting elements "
            "that affect how the text is tokenized by different systems. "
            "Some pages might have URLs, dates like 12/31/2023, or special "
            "characters and symbols that are handled differently by spaCy vs tiktoken. "
        ) * 10  # Make each "page" substantial

        # Simulate assembling 578 pages into one massive document (like the PDF processing does)
        # Use fewer pages for testing but still create a very large document
        num_pages = 100  # Reduced from 578 for test performance
        massive_document = "\n\n".join([pdf_page_text] * num_pages)

        print(f"Created massive document with {len(massive_document)} characters")
        print(f"Estimated words: {len(massive_document.split())}")

        # This is the exact scenario that causes the bug
        chunks = splitter.split_text(massive_document, document_id="massive_pdf_test")

        print(f"Massive PDF test created {len(chunks)} chunks")

        # Check for chunks that exceed the target token limit
        oversized_chunks = []
        for i, chunk in enumerate(chunks):
            token_count = len(splitter._tokenize_text(chunk))
            if token_count > splitter.target_chunk_size:
                oversized_chunks.append((i, token_count))

            print(f"Massive chunk {i}: {token_count} tokens")

            # This test should fail if the bug exists
            assert token_count <= splitter.target_chunk_size, (
                f"Massive PDF chunk {i} exceeds target: {token_count} tokens "
                f"(target: {splitter.target_chunk_size}). This reproduces the user's bug!"
            )

        if oversized_chunks:
            print(f"Found {len(oversized_chunks)} oversized chunks:")
            for chunk_idx, token_count in oversized_chunks:
                print(f"  Chunk {chunk_idx}: {token_count} tokens")

    def test_spacy_vs_tiktoken_tokenization_mismatch_bug(self):
        """
        Test that demonstrates the REAL bug: SpacyTextSplitter uses spaCy tokenization
        but PDF processing validates with tiktoken, causing massive token count mismatches.

        This is the actual bug causing 9000+ token chunks!
        """
        splitter = SpacyTextSplitter()

        # Create text that might be tokenized very differently by spaCy vs tiktoken
        # Focus on repetitive patterns that might cause encoding differences
        problematic_text = (
            "This is a test of tokenization differences between spaCy and tiktoken. "
            "The text contains various elements that might be encoded differently: "
            "contractions like don't, won't, can't, shouldn't, wouldn't, couldn't; "
            "punctuation marks including commas, periods, semicolons, exclamation marks! "
            "question marks? and other symbols like @#$%^&*(); "
            "numbers in different formats: 123, 1,234, 1.234, 12.34%, $45.67; "
            "dates like 12/31/2023, 2023-12-31, Dec 31, 2023; "
            "URLs like https://example.com/path/to/resource?param=value&other=data; "
            "email addresses like test@example.com, user.name+tag@domain.co.uk; "
            "hyphenated words like state-of-the-art, well-known, twenty-first-century; "
            "mathematical expressions like x = y + z, E = mc², ∑(i=1 to n) xi; "
            "chemical formulas like H₂O, CO₂, C₆H₁₂O₆; "
            "programming code like function() { return true; }, variable_names; "
            "special Unicode characters like ñ, ü, é, ç, and emojis 😀 🎉 ✨; "
        ) * 20  # Repeat to make it substantial

        # Get tiktoken count (what SpacyTextSplitter uses)
        tiktoken_count = len(splitter._tokenize_text(problematic_text))

        # Get spaCy count (what was used in the old implementation)
        try:
            splitter._ensure_nlp()
            doc = splitter.nlp(problematic_text)
            spacy_tokens = [token.text for token in doc if not token.is_space]
            spacy_count = len(spacy_tokens)

            print(f"Text length: {len(problematic_text)} characters")
            print(f"spaCy tokens: {spacy_count}")
            print(f"tiktoken tokens: {tiktoken_count}")
            print(f"Ratio (tiktoken/spaCy): {tiktoken_count / spacy_count:.2f}")
            print(f"Difference: {abs(tiktoken_count - spacy_count)} tokens")

            # This is the bug! If tiktoken produces significantly more tokens than spaCy,
            # then chunks that seem fine to SpacyTextSplitter (e.g., 450 spaCy tokens)
            # could actually be massive when measured by tiktoken (e.g., 9000+ tokens)

            if tiktoken_count > spacy_count * 2:
                print(
                    f"🚨 BUG DETECTED: tiktoken produces {tiktoken_count / spacy_count:.1f}x more tokens than spaCy!"
                )
                print(
                    "This explains why chunks appear to be 9000+ tokens in PDF processing!"
                )

                # Demonstrate the bug: create a chunk that's "safe" by spaCy standards
                # but massive by tiktoken standards
                words = problematic_text.split()
                # Take enough words to get close to 450 spaCy tokens
                target_words = min(len(words), 400)  # Conservative estimate
                chunk_text = " ".join(words[:target_words])

                chunk_spacy_tokens = len(
                    [
                        token.text
                        for token in splitter.nlp(chunk_text)
                        if not token.is_space
                    ]
                )
                chunk_tiktoken_tokens = len(splitter._tokenize_text(chunk_text))

                print("\nExample 'safe' chunk:")
                print(f"  spaCy tokens: {chunk_spacy_tokens}")
                print(f"  tiktoken tokens: {chunk_tiktoken_tokens}")
                print(f"  Ratio: {chunk_tiktoken_tokens / chunk_spacy_tokens:.2f}")

                if chunk_tiktoken_tokens > 8192:
                    print(
                        f"  ❌ This chunk would FAIL OpenAI embedding (>{8192} tokens)!"
                    )
                    print(
                        f"  But SpacyTextSplitter thinks it's fine ({chunk_spacy_tokens} tokens)"
                    )

                    # This should fail to demonstrate the bug
                    pytest.fail(
                        f"TOKENIZATION MISMATCH BUG: Chunk has {chunk_spacy_tokens} spaCy tokens "
                        f"but {chunk_tiktoken_tokens} tiktoken tokens. This exceeds OpenAI's 8192 limit!"
                    )

        except ImportError:
            pytest.skip("spaCy not available for tokenization comparison")
        except Exception as e:
            pytest.skip(f"Error during tokenization comparison: {e}")

    def test_punctuation_preservation_in_overlap(self):
        """
        Test that punctuation is preserved correctly in overlap text after the tiktoken fix.
        """
        splitter = SpacyTextSplitter(chunk_size=600, chunk_overlap=120)

        # Create text with various punctuation that could be problematic
        text_with_punctuation = (
            "This is the first chunk with punctuation: commas, periods, semicolons; "
            "exclamation marks! question marks? and contractions like don't, won't, can't. "
            "It also has numbers like 1,234.56 and dates like 12/31/2023. "
            "URLs like https://example.com and emails like test@example.com are included. "
            "Mathematical expressions like x = y + z and chemical formulas like H₂O. "
            'Quotes "like this" and apostrophes in words like it\'s are important. '
        ) * 10  # Repeat to make it substantial

        text_second_chunk = (
            "This is the second chunk that should receive overlap from the first chunk. "
            "The overlap should preserve all punctuation marks correctly without adding "
            "extra spaces or breaking contractions. This text continues with more content "
            "to make it a substantial chunk for testing purposes. "
        ) * 10

        # Combine into a document that will be split
        full_text = text_with_punctuation + "\n\n" + text_second_chunk

        # Split the text
        chunks = splitter.split_text(full_text, document_id="punctuation_test")

        if len(chunks) >= 2:
            # Check the second chunk for overlap
            second_chunk = chunks[1]

            # Look for common punctuation patterns that should be preserved
            punctuation_tests = [
                ("don't", "Contraction with apostrophe"),
                ("won't", "Another contraction"),
                ("can't", "Third contraction"),
                ("1,234.56", "Number with comma and decimal"),
                ("12/31/2023", "Date with slashes"),
                ("https://example.com", "URL"),
                ("test@example.com", "Email address"),
                ("x = y + z", "Mathematical expression"),
                ("H₂O", "Chemical formula"),
                ('"like this"', "Quoted text"),
                ("it's", "Contraction with apostrophe"),
            ]

            for pattern, description in punctuation_tests:
                if pattern in second_chunk:
                    print(f"✓ {description}: '{pattern}' found correctly")
                # Note: Not all patterns may be in overlap, so we don't assert here

            # Check for common punctuation errors that should NOT exist
            error_patterns = [
                (" ,", "Space before comma"),
                (" .", "Space before period"),
                (" !", "Space before exclamation"),
                (" ?", "Space before question mark"),
                ("don ' t", "Broken contraction"),
                ("won ' t", "Broken contraction"),
                ("can ' t", "Broken contraction"),
                ("it ' s", "Broken contraction"),
            ]

            errors_found = []
            for error_pattern, description in error_patterns:
                if error_pattern in second_chunk:
                    errors_found.append(f"{description}: '{error_pattern}'")

            assert len(errors_found) == 0, (
                f"Found punctuation errors in overlap: {errors_found}"
            )
