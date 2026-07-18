"""
Tests for document hash generation utility.

Tests the content-based hash generation that enables deduplication across different
libraries, source locations, titles, and authors by using only the actual content.
"""

from ..utils.document_hash import generate_document_hash


class TestDocumentHash:
    """Test cases for document hash generation."""

    def test_identical_content_same_hash(self):
        """Test that identical content produces the same hash."""
        chunk_text = "This is the exact same content text."

        hash1 = generate_document_hash(
            content_type="text",
            chunk_text=chunk_text,
        )

        hash2 = generate_document_hash(
            content_type="text",
            chunk_text=chunk_text,
        )

        assert hash1 == hash2

    def test_different_metadata_same_content_same_hash(self):
        """Test that same content with different titles/authors produces same hash."""
        chunk_text = "This is the actual content that matters."

        # Different titles and authors but same content
        hash1 = generate_document_hash(
            title="Title Version 1",
            author="Author A",
            content_type="text",
            chunk_text=chunk_text,
        )

        hash2 = generate_document_hash(
            title="Title Version 2 (Different)",
            author="Author B (Different)",
            content_type="text",
            chunk_text=chunk_text,
        )

        # Should be the same because content_type and chunk_text are identical
        assert hash1 == hash2

    def test_different_content_different_hash(self):
        """Test that different content produces different hashes."""
        hash1 = generate_document_hash(
            content_type="text",
            chunk_text="This is content A.",
        )

        hash2 = generate_document_hash(
            content_type="text",
            chunk_text="This is content B.",
        )

        assert hash1 != hash2

    def test_different_content_type_different_hash(self):
        """Test that different content types produce different hashes."""
        chunk_text = "Same content text."

        hash1 = generate_document_hash(
            content_type="text",
            chunk_text=chunk_text,
        )

        hash2 = generate_document_hash(
            content_type="audio",
            chunk_text=chunk_text,
        )

        assert hash1 != hash2

    def test_whitespace_normalization(self):
        """Test that whitespace differences don't affect hash."""
        content_base = "Content with whitespace"

        hash1 = generate_document_hash(
            content_type="text",
            chunk_text=content_base,
        )

        hash2 = generate_document_hash(
            content_type="text",
            chunk_text=f"  {content_base}  ",  # Extra whitespace
        )

        assert hash1 == hash2

    def test_empty_content_fallback(self):
        """Test that empty content uses fallback value."""
        hash1 = generate_document_hash(
            content_type="text",
            chunk_text="",
        )

        hash2 = generate_document_hash(
            content_type="text",
            chunk_text=None,
        )

        # Both should use the fallback
        assert hash1 == hash2

    def test_hash_length_and_format(self):
        """Test that hash is 8 characters and hex format."""
        hash_value = generate_document_hash(
            content_type="text",
            chunk_text="Some content",
        )

        assert len(hash_value) == 8
        assert all(c in "0123456789abcdef" for c in hash_value)

    def test_consistency_across_calls(self):
        """Test that hash remains consistent across multiple calls."""
        content_type = "audio"
        chunk_text = "Consistent content for testing."

        hashes = [
            generate_document_hash(
                content_type=content_type,
                chunk_text=chunk_text,
            )
            for _ in range(10)
        ]

        # All hashes should be identical
        assert len(set(hashes)) == 1

    def test_ignored_parameters(self):
        """Test that title and author parameters are ignored."""
        chunk_text = "Content that matters"

        # Generate hash with no title/author
        hash1 = generate_document_hash(
            content_type="text",
            chunk_text=chunk_text,
        )

        # Generate hash with title/author (should be ignored)
        hash2 = generate_document_hash(
            title="This title is ignored",
            author="This author is ignored",
            content_type="text",
            chunk_text=chunk_text,
        )

        assert hash1 == hash2

    def test_real_world_deduplication_scenario(self):
        """Test a real-world scenario where content appears in multiple sources."""
        # Same content appearing in different sources/libraries
        chunk_text = """
        This is a paragraph from a spiritual text that appears in multiple 
        formats and sources but should be deduplicated based on content.
        """

        # Different sources but same content
        hash_pdf = generate_document_hash(
            title="PDF Version of Text",
            author="Original Author",
            content_type="text",
            chunk_text=chunk_text,
        )

        hash_web = generate_document_hash(
            title="Web Article: Same Content",
            author="Web Editor (different)",
            content_type="text",
            chunk_text=chunk_text,
        )

        hash_audio_transcript = generate_document_hash(
            title="Audio Transcript",
            author="Speaker Name",
            content_type="text",  # Same content type even though source is audio
            chunk_text=chunk_text,
        )

        # All should have the same hash for content-based deduplication
        assert hash_pdf == hash_web == hash_audio_transcript

    def test_empty_content_sentinel_collision_is_stable(self):
        # Literal "empty_content" collides with the empty-chunk sentinel; keep stable for IDs.
        empty_hash = generate_document_hash(content_type="text", chunk_text="")
        sentinel_hash = generate_document_hash(
            content_type="text", chunk_text="empty_content"
        )
        assert empty_hash == sentinel_hash

    def test_none_content_type_defaults_to_text(self):
        chunk = "Same body"
        assert generate_document_hash(
            content_type=None, chunk_text=chunk
        ) == generate_document_hash(content_type="text", chunk_text=chunk)

    def test_unicode_nfc_nfd_are_distinct_without_normalization(self):
        nfc = "café"
        nfd = "cafe\u0301"
        assert nfc != nfd
        assert generate_document_hash(
            content_type="text", chunk_text=nfc
        ) != generate_document_hash(content_type="text", chunk_text=nfd)
