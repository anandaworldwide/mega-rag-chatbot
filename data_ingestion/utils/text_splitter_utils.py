"""
Utility module for text splitting using spaCy.
This module provides a reusable SpacyTextSplitter class that can be used
across different data ingestion scripts to ensure consistent chunking behavior.
"""

import logging
import os
import re
import time
from typing import TYPE_CHECKING, Any

import spacy
import tiktoken

if TYPE_CHECKING:
    from spacy.tokens import Doc
else:
    # Runtime import - handle test mocking
    try:
        from spacy.tokens import Doc
    except (ImportError, AttributeError):
        # Fallback for test environments where spacy might be mocked
        Doc = Any  # type: ignore

# NOTE: We intentionally do NOT import `spacy.cli.download` at module import time.
# Tests mock `spacy` via `sys.modules["spacy"] = mock_spacy`, which is not a real package,
# and importing submodules would crash test collection. Instead, we resolve the download
# function lazily inside `_ensure_nlp()` via `getattr(spacy, "cli")`.
spacy_download = None

# Configure logging
logger = logging.getLogger(__name__)

# Global cache for spaCy models to avoid reloading in tests
_SPACY_MODEL_CACHE = {}


# Define Document class to avoid circular imports
class Document:
    """Simple document class with content and metadata"""

    def __init__(self, page_content: str, metadata: dict[str, Any] | None = None):
        self.page_content = page_content
        self.metadata = metadata or {}


class ChunkingMetrics:
    """Class to track and log chunking metrics for analysis."""

    def __init__(self):
        self.total_documents = 0
        self.total_chunks = 0
        self.word_count_distribution = {
            "<200": 0,
            "200-999": 0,
            "1000-4999": 0,
            "5000+": 0,
        }
        # Updated to use token-based ranges aligned with 250-token target
        self.chunk_size_distribution = {
            "<125": 0,  # Very small chunks (< 50% of target)
            "125-187": 0,  # Small chunks (50-75% of target)
            "188-313": 0,  # Target range (75-125% of target)
            "313+": 0,  # Large chunks (> 125% of target)
        }
        self.edge_cases = []
        self.anomalies = []

    def _update_word_count_distribution(self, word_count: int) -> None:
        """Update word count distribution tracking."""
        if word_count < 200:
            self.word_count_distribution["<200"] += 1
        elif word_count < 1000:
            self.word_count_distribution["200-999"] += 1
        elif word_count < 5000:
            self.word_count_distribution["1000-4999"] += 1
        else:
            self.word_count_distribution["5000+"] += 1

    def _update_chunk_size_distribution(self, chunk_token_counts: list[int]) -> None:
        """Update chunk size distribution tracking using token counts."""
        for token_count in chunk_token_counts:
            if token_count < 125:
                self.chunk_size_distribution["<125"] += 1
            elif token_count < 188:
                self.chunk_size_distribution["125-187"] += 1
            elif token_count <= 313:
                self.chunk_size_distribution["188-313"] += 1
            else:
                self.chunk_size_distribution["313+"] += 1

    def _detect_edge_cases(
        self, word_count: int, chunk_count: int, document_id: str | None = None
    ) -> None:
        """Detect and log edge cases in document processing."""
        if word_count < 50:
            self.edge_cases.append(
                f"Very short document: {word_count} words (ID: {document_id})"
            )
        elif word_count > 200000:
            self.edge_cases.append(
                f"Very long document: {word_count} words (ID: {document_id})"
            )

        if chunk_count == 1 and word_count > 1000:
            self.edge_cases.append(
                f"Large document not chunked: {word_count} words, 1 chunk (ID: {document_id})"
            )

    def _detect_anomalies(
        self,
        chunk_token_counts: list[int],
        word_count: int,
        document_id: str | None = None,
    ) -> None:
        """Detect and log anomalies in chunk sizes using token counts."""
        if not chunk_token_counts:
            return

        avg_chunk_tokens = sum(chunk_token_counts) / len(chunk_token_counts)

        # Detect anomalies based on token counts (target is 250 tokens)
        if (
            avg_chunk_tokens < 62 and word_count > 500
        ):  # Very small chunks (< 25% of target)
            self.anomalies.append(
                f"Unexpectedly small chunks: avg {avg_chunk_tokens:.1f} tokens for {word_count} word document (ID: {document_id})"
            )
        elif avg_chunk_tokens > 500:  # Very large chunks (2x target)
            self.anomalies.append(
                f"Unexpectedly large chunks: avg {avg_chunk_tokens:.1f} tokens (ID: {document_id})"
            )

    def log_document_metrics(
        self,
        word_count: int,
        chunk_count: int,
        chunk_token_counts: list[int],
        chunk_overlaps: list[int],
        document_id: str | None = None,
    ):
        """Log metrics for a single document using token counts for chunk analysis."""
        self.total_documents += 1
        self.total_chunks += chunk_count

        # Update distributions
        self._update_word_count_distribution(word_count)
        self._update_chunk_size_distribution(chunk_token_counts)

        # Detect edge cases and anomalies
        self._detect_edge_cases(word_count, chunk_count, document_id)
        self._detect_anomalies(chunk_token_counts, word_count, document_id)

    def log_summary(self, logger: logging.Logger):
        """Log a summary of all chunking metrics."""
        logger.info("=== CHUNKING METRICS SUMMARY ===")
        logger.info(f"Total documents processed: {self.total_documents}")
        logger.info(f"Total chunks created: {self.total_chunks}")
        avg_chunks = (
            self.total_chunks / self.total_documents if self.total_documents > 0 else 0
        )
        logger.info(f"Average chunks per document: {avg_chunks:.2f}")

        logger.info("Document word count distribution:")
        for range_key, count in self.word_count_distribution.items():
            percentage = (
                (count / self.total_documents * 100) if self.total_documents > 0 else 0
            )
            logger.info(f"  {range_key} words: {count} documents ({percentage:.1f}%)")

        logger.info("Chunk size distribution (tokens):")
        for range_key, count in self.chunk_size_distribution.items():
            percentage = (
                (count / self.total_chunks * 100) if self.total_chunks > 0 else 0
            )
            logger.info(f"  {range_key} tokens: {count} chunks ({percentage:.1f}%)")

        if self.edge_cases:
            logger.info(f"Edge cases detected ({len(self.edge_cases)}):")
            for case in self.edge_cases[:10]:  # Log first 10 edge cases
                logger.info(f"  {case}")
            if len(self.edge_cases) > 10:
                logger.info(f"  ... and {len(self.edge_cases) - 10} more edge cases")

        if self.anomalies:
            logger.warning(f"Anomalies detected ({len(self.anomalies)}):")
            for anomaly in self.anomalies[:10]:  # Log first 10 anomalies
                logger.warning(f"  {anomaly}")
            if len(self.anomalies) > 10:
                logger.warning(f"  ... and {len(self.anomalies) - 10} more anomalies")

    def print_summary(self):
        """Print a summary of all chunking metrics to stdout."""
        if self.total_documents == 0:
            print("No documents were processed for chunking in this session.")
            return

        print("--- Chunking Statistics ---")
        print(f"Total documents chunked: {self.total_documents}")
        print(f"Total chunks created: {self.total_chunks}")
        print(
            f"Average chunks per document: {self.total_chunks / self.total_documents:.2f}"
        )

        print("\nDocument word count distribution:")
        for range_key, count in self.word_count_distribution.items():
            percentage = (
                (count / self.total_documents * 100) if self.total_documents > 0 else 0
            )
            print(f"  {range_key} words: {count} documents ({percentage:.1f}%)")

        print("\nChunk size distribution (tokens):")
        for range_key, count in self.chunk_size_distribution.items():
            percentage = (
                (count / self.total_chunks * 100) if self.total_chunks > 0 else 0
            )
            print(f"  {range_key} tokens: {count} chunks ({percentage:.1f}%)")

        if self.edge_cases:
            print(f"\nEdge cases detected: {len(self.edge_cases)}")
            for case in self.edge_cases[:200]:  # Show first 200 edge cases
                print(f"  {case}")
            if len(self.edge_cases) > 200:
                print(f"  ... and {len(self.edge_cases) - 200} more edge cases")

        if self.anomalies:
            print(f"\nAnomalies detected: {len(self.anomalies)}")
            for anomaly in self.anomalies[:200]:  # Show first 200 anomalies
                print(f"  {anomaly}")
            if len(self.anomalies) > 200:
                print(f"  ... and {len(self.anomalies) - 200} more anomalies")


class SpacyTextSplitter:
    """Text splitter that uses spaCy to split text into chunks by paragraphs with fixed sizing."""

    def __init__(
        self,
        chunk_size=250,  # Historical target size for text sources (PDF, web, SQL)
        chunk_overlap=50,  # Historical 20% overlap (50 tokens)
        separator="\n\n",
        pipeline="en_core_web_sm",
        log_summary_on_split: bool = True,
    ):
        """
        Initialize the SpacyTextSplitter with historical paragraph-based chunking parameters.

        Args:
            chunk_size (int): Target size for final chunks including overlap (default: 250)
            chunk_overlap (int): Fixed overlap in tokens (default: 50 = 20% of chunk_size)
            separator (str): Separator to use for splitting text
            pipeline (str): Name of spaCy pipeline/model to use
            log_summary_on_split (bool): Whether to automatically log summary after each split_documents call.
        """
        # Calculate base chunk size to account for overlap
        # Target: final chunks of 250 tokens with 50 token overlap
        # Problem: Paragraph-based chunking can create chunks slightly larger than target
        # Solution: Use 188 tokens base (75% of target) to provide buffer for overlap
        self.target_chunk_size = chunk_size  # Final target size (250)
        self.chunk_overlap = chunk_overlap
        # Use 75% of target size as base to provide buffer for paragraph boundaries
        self.chunk_size = int(chunk_size * 0.75)  # Base size for chunking (188)

        self.separator = separator
        self.pipeline = pipeline
        self.nlp = None
        self.logger = logging.getLogger(f"{__name__}.SpacyTextSplitter")
        self.metrics = ChunkingMetrics()
        self.log_summary_on_split = log_summary_on_split

    def _get_embedding_model(self) -> str:
        """
        Get the embedding model name from environment variables.

        Returns:
            str: The embedding model name

        Raises:
            ValueError: If OPENAI_INGEST_EMBEDDINGS_MODEL environment variable is not set
        """
        model_name = os.getenv("OPENAI_INGEST_EMBEDDINGS_MODEL")
        if not model_name:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set. "
                "Please set it to the OpenAI embedding model name (e.g., text-embedding-3-large)"
            )
        return model_name

    def _ensure_nlp(self):
        """
        Ensure spaCy model is loaded, downloading if necessary.
        Uses global cache to avoid reloading models in tests.

        Raises:
            RuntimeError: If the model couldn't be loaded or downloaded
        """
        if self.nlp is None:
            # Check global cache first
            if self.pipeline in _SPACY_MODEL_CACHE:
                self.logger.debug(f"Using cached spaCy model {self.pipeline}")
                self.nlp = _SPACY_MODEL_CACHE[self.pipeline]
                return

            try:
                self.logger.debug(f"Loading spaCy model {self.pipeline}")
                self.nlp = spacy.load(self.pipeline)

                # Increase max_length to handle very large documents
                # Default is 1,000,000 chars. Setting to 2,000,000 to handle large PDFs
                # This requires roughly 2GB of temporary memory during processing
                self.nlp.max_length = 2_000_000
                self.logger.debug(
                    f"Set spaCy max_length to {self.nlp.max_length:,} characters"
                )

                # Cache the loaded model
                _SPACY_MODEL_CACHE[self.pipeline] = self.nlp

            except OSError:
                try:
                    self.logger.info(f"Downloading spaCy model {self.pipeline}...")
                    download_fn = spacy_download
                    if download_fn is None:
                        download_fn = getattr(
                            getattr(spacy, "cli", None), "download", None
                        )
                    if download_fn is None:
                        raise RuntimeError(
                            "spaCy download function unavailable (spacy.cli.download missing)"
                        )

                    download_fn(self.pipeline)
                    self.nlp = spacy.load(self.pipeline)

                    # Increase max_length for downloaded model too
                    self.nlp.max_length = 2_000_000
                    self.logger.debug(
                        f"Set spaCy max_length to {self.nlp.max_length:,} characters"
                    )

                    # Cache the loaded model
                    _SPACY_MODEL_CACHE[self.pipeline] = self.nlp

                    self.logger.info(
                        f"Successfully downloaded and loaded {self.pipeline}"
                    )
                except Exception as e:
                    error_msg = (
                        f"Failed to download spaCy model {self.pipeline}: {str(e)}"
                    )
                    self.logger.error(error_msg)
                    raise RuntimeError(error_msg) from e
            except Exception as e:
                error_msg = f"Error loading spaCy model {self.pipeline}: {str(e)}"
                self.logger.error(error_msg)
                raise RuntimeError(error_msg) from e

    def _tokenize_text(self, text: str) -> list[str]:
        """
        Tokenize text into a list of tokens using tiktoken for consistency with OpenAI embeddings.

        This ensures token counting matches what OpenAI's embedding models expect,
        preventing chunks from exceeding the 8192 token limit.

        Args:
            text: Text to tokenize

        Returns:
            List of tokens as strings
        """
        if not text.strip():
            return []

        try:
            # Use tiktoken for consistent token counting with OpenAI embeddings
            model_name = self._get_embedding_model()
            encoding = tiktoken.encoding_for_model(model_name)
            # Get token IDs and convert back to strings for compatibility
            token_ids = encoding.encode(text)
            # Convert token IDs back to token strings
            tokens = [encoding.decode([token_id]) for token_id in token_ids]
            return tokens
        except ImportError:
            self.logger.warning(
                "tiktoken not available, falling back to spaCy tokenization. "
                "Install tiktoken for accurate OpenAI token counting: pip install tiktoken"
            )
            # Fallback to spaCy tokenization
            try:
                self._ensure_nlp()
                if self.nlp is None:
                    raise RuntimeError("spaCy model failed to load")
                doc = self.nlp(text)
                # Extract non-space tokens as strings
                tokens = [token.text for token in doc if not token.is_space]
                return tokens
            except Exception as e:
                # Final fallback to simple whitespace tokenization
                self.logger.warning(
                    f"spaCy tokenization failed, using whitespace fallback: {e}"
                )
                return text.split()

    def _clean_text(self, text: str) -> str:
        """
        Clean text by removing unnecessary newlines and fixing common OCR artifacts.

        Args:
            text (str): The text to clean

        Returns:
            str: Cleaned text
        """
        if not text:
            return text

        # First, fix hyphenated words split across lines (word-\nword -> word)
        text = re.sub(r"(\w+)-\s*\n\s*(\w+)", r"\1\2", text)

        # Preserve paragraph breaks (double newlines) but normalize them
        text = re.sub(r"\n\s*\n", "\n\n", text)

        # Remove single newlines that are just line wrapping within paragraphs
        # But preserve double newlines (paragraph breaks)
        lines = text.split("\n\n")
        cleaned_lines = []

        for line_group in lines:
            # Within each paragraph, remove single newlines and clean up spacing
            cleaned_paragraph = re.sub(r"\n+", " ", line_group)
            # Clean up multiple spaces
            cleaned_paragraph = re.sub(r"\s+", " ", cleaned_paragraph)
            cleaned_paragraph = cleaned_paragraph.strip()
            if cleaned_paragraph:
                cleaned_lines.append(cleaned_paragraph)

        # Rejoin paragraphs with double newlines
        cleaned_text = "\n\n".join(cleaned_lines)

        self.logger.debug(f"Cleaned text: {len(text)} -> {len(cleaned_text)} chars")
        return cleaned_text

    def _estimate_word_count(self, text: str, doc: Doc | None = None) -> int:
        """
        Estimate the word count of the input text by splitting on spaces or using pre-tokenized SpaCy Doc.

        Args:
            text (str): The text to estimate word count for (used if doc is None)
            doc (Doc, optional): Pre-tokenized SpaCy document to use if available

        Returns:
            int: Approximate number of words
        """
        if doc is not None:
            # Use pre-tokenized doc if provided
            words = [
                token.text for token in doc if not token.is_space and not token.is_punct
            ]
            return len(words)
        if not text:
            return 0
        # Split on whitespace and filter out empty strings
        words = [w for w in text.split() if w]
        return len(words)

    def _log_chunk_metrics(
        self, chunks: list[str], word_count: int, document_id: str | None = None
    ) -> None:
        """
        Log detailed chunking metrics for a document using token counts.

        Args:
            chunks (list[str]): The chunks created for the document
            word_count (int): The word count of the original document
            document_id (str, optional): Identifier for the document
        """
        # Log detailed chunking metrics using token counts
        chunk_token_counts = [len(self._tokenize_text(chunk)) for chunk in chunks]
        chunk_char_counts = [len(chunk) for chunk in chunks]

        if chunks:
            avg_chunk_tokens = sum(chunk_token_counts) / len(chunk_token_counts)
            min_chunk_tokens = min(chunk_token_counts)
            max_chunk_tokens = max(chunk_token_counts)
            avg_chunk_chars = sum(chunk_char_counts) / len(chunk_char_counts)

            self.logger.debug(
                f"Chunk statistics (ID: {document_id}): "
                f"avg={avg_chunk_tokens:.1f} tokens, "
                f"min={min_chunk_tokens}, max={max_chunk_tokens} tokens, "
                f"avg_chars={avg_chunk_chars:.1f}"
            )

            # Log edge cases for this document using token counts
            if min_chunk_tokens < 62:  # Less than 25% of target
                self.logger.warning(
                    f"Very small chunks detected (ID: {document_id}): "
                    f"minimum {min_chunk_tokens} tokens"
                )
            if max_chunk_tokens > 500:  # More than 200% of target
                self.logger.warning(
                    f"Very large chunks detected (ID: {document_id}): "
                    f"maximum {max_chunk_tokens} tokens"
                )
            if len(chunks) == 1 and word_count > 1000:
                self.logger.warning(
                    f"Large document not chunked (ID: {document_id}): "
                    f"{word_count} words in single chunk"
                )

        # Record metrics for analysis
        chunk_overlaps = (
            [self.chunk_overlap] * (len(chunks) - 1) if len(chunks) > 1 else []
        )
        self.metrics.log_document_metrics(
            word_count=word_count,
            chunk_count=len(chunks),
            chunk_token_counts=chunk_token_counts,
            chunk_overlaps=chunk_overlaps,
            document_id=document_id,
        )

    def _finalize_current_merge(
        self,
        current_merged: list[str],
        current_token_count: int,
        merged_chunks: list[str],
    ) -> tuple[list[str], int]:
        """Finalize the current merge group and add to merged chunks."""
        if current_merged:
            merged_text = " ".join(current_merged)
            merged_chunks.append(merged_text)
            self.logger.debug(
                f"Merged {len(current_merged)} chunks into {current_token_count} tokens"
            )
        return [], 0

    def _handle_target_sized_chunk(
        self,
        chunk: str,
        chunk_tokens: int,
        document_id: str | None,
        merged_chunks: list[str],
        current_merged: list[str],
        current_token_count: int,
    ) -> tuple[list[str], int]:
        """Handle chunks that are already in target range or too large."""
        target_max_tokens = int(self.target_chunk_size * 1.25)  # 313 tokens

        # First, finalize any accumulated chunks
        if current_merged:
            merged_text = " ".join(current_merged)
            merged_chunks.append(merged_text)
            merged_tokens = len(self._tokenize_text(merged_text))
            self.logger.debug(
                f"Merged {len(current_merged)} small chunks into {merged_tokens} tokens"
            )

        # Add this chunk as-is (it's already good size or too large to merge)
        merged_chunks.append(chunk)
        if chunk_tokens > target_max_tokens:
            self.logger.debug(
                f"Kept oversized chunk: {chunk_tokens} tokens (ID: {document_id})"
            )
        else:
            self.logger.debug(
                f"Kept target-sized chunk: {chunk_tokens} tokens (ID: {document_id})"
            )

        return [], 0

    def _should_preserve_chunk_separation(
        self,
        merged_chunks: list[str],
        min_chunks_for_total: int,
        current_token_count: int,
        chunk_tokens: int,
    ) -> bool:
        """Determine if we should preserve chunk separation to maintain multiple chunks."""
        target_min_tokens = int(self.target_chunk_size * 0.75)  # 188 tokens
        return (
            len(merged_chunks) >= min_chunks_for_total
            and current_token_count + chunk_tokens >= target_min_tokens * 0.7
        )

    def _handle_small_chunk_merging(
        self,
        chunk: str,
        chunk_tokens: int,
        merged_chunks: list[str],
        current_merged: list[str],
        current_token_count: int,
        min_chunks_for_total: int,
    ) -> tuple[list[str], int]:
        """Handle merging of small chunks."""
        target_min_tokens = int(self.target_chunk_size * 0.75)  # 188 tokens
        target_max_tokens = int(self.target_chunk_size * 1.25)  # 313 tokens

        # If we already have enough chunks and this would create a reasonable chunk, preserve it
        if self._should_preserve_chunk_separation(
            merged_chunks, min_chunks_for_total, current_token_count, chunk_tokens
        ):
            # We have enough chunks, finalize current merge and preserve separation
            if current_merged:
                merged_text = " ".join(current_merged)
                merged_chunks.append(merged_text)
                self.logger.debug(
                    f"Merged {len(current_merged)} chunks into {current_token_count} tokens (preserving multiple chunks)"
                )

            # Add this chunk separately to preserve multiple chunks
            merged_chunks.append(chunk)
            self.logger.debug(
                f"Added small chunk separately to preserve multiple chunks: {chunk_tokens} tokens"
            )
            return [], 0
        elif current_token_count + chunk_tokens <= target_max_tokens:
            # Can add to current merge group
            current_merged.append(chunk)
            current_token_count += chunk_tokens

            # If we've reached a good size, finalize this merge
            if current_token_count >= target_min_tokens:
                merged_text = " ".join(current_merged)
                merged_chunks.append(merged_text)
                self.logger.debug(
                    f"Merged {len(current_merged)} chunks into {current_token_count} tokens"
                )
                return [], 0
        else:
            # Adding this chunk would exceed max, finalize current merge first
            if current_merged:
                merged_text = " ".join(current_merged)
                merged_chunks.append(merged_text)
                self.logger.debug(
                    f"Merged {len(current_merged)} chunks into {current_token_count} tokens (below target)"
                )

            # Start new merge group with this chunk
            return [chunk], chunk_tokens

        return current_merged, current_token_count

    def _merge_small_chunks(
        self, chunks: list[str], document_id: str | None = None
    ) -> list[str]:
        """
        Merge small chunks to better meet the target token count range (188-313 tokens).

        This function is less aggressive to preserve multiple chunks for overlap.

        Args:
            chunks (list[str]): The original chunks
            document_id (str, optional): Identifier for the document

        Returns:
            list[str]: Merged chunks that better meet target token count
        """
        if not chunks:
            return chunks

        target_min_tokens = int(self.target_chunk_size * 0.75)  # 188 tokens
        target_max_tokens = int(self.target_chunk_size * 1.25)  # 313 tokens

        # Calculate total token count to decide strategy
        total_tokens = sum(len(self._tokenize_text(chunk)) for chunk in chunks)

        # If total content is large enough for multiple chunks, be less aggressive about merging
        min_chunks_for_total = max(2, total_tokens // target_max_tokens)

        self.logger.debug(
            f"Merge strategy: {total_tokens} total tokens, targeting {min_chunks_for_total} chunks minimum"
        )

        merged_chunks = []
        current_merged = []
        current_token_count = 0

        for chunk in chunks:
            chunk_tokens = len(self._tokenize_text(chunk))

            # If this chunk alone is already in target range or too large, handle it separately
            if chunk_tokens >= target_min_tokens:
                current_merged, current_token_count = self._handle_target_sized_chunk(
                    chunk,
                    chunk_tokens,
                    document_id,
                    merged_chunks,
                    current_merged,
                    current_token_count,
                )
            else:
                # This chunk is too small, try to merge it
                current_merged, current_token_count = self._handle_small_chunk_merging(
                    chunk,
                    chunk_tokens,
                    merged_chunks,
                    current_merged,
                    current_token_count,
                    min_chunks_for_total,
                )

        # Handle any remaining chunks in current_merged
        if current_merged:
            merged_text = " ".join(current_merged)
            merged_chunks.append(merged_text)
            self.logger.debug(
                f"Final merge: {len(current_merged)} chunks into {current_token_count} tokens"
            )

        # Log the improvement
        original_in_range = sum(
            1
            for chunk in chunks
            if target_min_tokens <= len(self._tokenize_text(chunk)) <= target_max_tokens
        )
        merged_in_range = sum(
            1
            for chunk in merged_chunks
            if target_min_tokens <= len(self._tokenize_text(chunk)) <= target_max_tokens
        )

        self.logger.info(
            f"Chunk merging (ID: {document_id}): {len(chunks)} → {len(merged_chunks)} chunks, "
            f"target range: {original_in_range} → {merged_in_range}"
        )

        return merged_chunks

    def _split_by_tokens(self, text: str, doc: Doc | None) -> list[str]:
        """Split text into token-based chunks using spaCy tokenization."""
        if doc is None:
            # Fallback to simple word splitting if no spaCy doc available
            words = text.split()
            if not words:
                return []

            chunks = []
            current_chunk = []
            current_token_count = 0

            for word in words:
                # Estimate 1 token per word for fallback
                if current_token_count + 1 > self.chunk_size and current_chunk:
                    chunks.append(" ".join(current_chunk))
                    current_chunk = [word]
                    current_token_count = 1
                else:
                    current_chunk.append(word)
                    current_token_count += 1

            # Add the last chunk
            if current_chunk:
                chunks.append(" ".join(current_chunk))

            self.logger.debug(
                f"Split text into {len(chunks)} word-based chunks (fallback mode)"
            )
            return chunks

        # Use spaCy tokens for accurate token counting
        tokens = [token for token in doc if not token.is_space]
        if not tokens:
            return []

        chunks = []
        current_chunk_tokens = []
        current_token_count = 0

        for token in tokens:
            # If adding this token would exceed chunk_size, start a new chunk
            if current_token_count + 1 > self.chunk_size and current_chunk_tokens:
                # Join tokens with appropriate spacing
                chunk_text = self._reconstruct_text_from_tokens(current_chunk_tokens)
                chunks.append(chunk_text)
                current_chunk_tokens = [token]
                current_token_count = 1
            else:
                current_chunk_tokens.append(token)
                current_token_count += 1

        # Add the last chunk
        if current_chunk_tokens:
            chunk_text = self._reconstruct_text_from_tokens(current_chunk_tokens)
            chunks.append(chunk_text)

        self.logger.debug(f"Split text into {len(chunks)} token-based chunks")
        return chunks

    def _reconstruct_text_from_tokens(self, tokens: list) -> str:
        """Reconstruct text from spaCy tokens, preserving original spacing."""
        if not tokens:
            return ""

        # Use spaCy's whitespace information to reconstruct text properly
        result = []
        for token in tokens:
            result.append(token.text)
            # Add space after token if the token has trailing whitespace
            # Note: whitespace_ contains the whitespace that follows the token
            if hasattr(token, "whitespace_") and token.whitespace_:
                result.append(token.whitespace_)

        return "".join(result)

    def _reconstruct_text_from_nltk_tokens(self, tokens: list[str]) -> str:
        """
        Reconstruct text from NLTK tokens, preserving proper punctuation spacing.

        Args:
            tokens: List of NLTK tokens (strings)

        Returns:
            str: Reconstructed text with proper spacing
        """
        if not tokens:
            return ""

        # Common punctuation marks that should not have spaces before them
        no_space_before = {
            ".",
            ",",
            "!",
            "?",
            ";",
            ":",
            ")",
            "]",
            "}",
            "'",
            '"',
            "``",
            "''",
        }
        # Punctuation marks that should not have spaces after them
        no_space_after = {"(", "[", "{", '"', "'", "``"}

        result = []
        for i, token in enumerate(tokens):
            if i == 0:
                # First token always gets added as-is
                result.append(token)
            elif token in no_space_before:
                # Punctuation that doesn't get a space before it
                result.append(token)
            elif i > 0 and tokens[i - 1] in no_space_after:
                # No space after certain punctuation
                result.append(token)
            else:
                # Regular token gets a space before it
                result.append(" " + token)

        return "".join(result)

    def _apply_token_overlap(self, chunks: list[str]) -> list[str]:  # noqa: C901
        """Apply token-based overlap to chunks."""
        if self.chunk_overlap <= 0 or len(chunks) <= 1:
            return chunks

        result = [chunks[0]]

        for i in range(1, len(chunks)):
            prev_chunk = chunks[i - 1]
            current_chunk = chunks[i]

            # For single-character separators like space, use token-based overlap
            if self.separator and len(self.separator) == 1 and self.separator.isspace():
                # Tokenize the previous chunk to get accurate token count
                if self.nlp is None:
                    self._ensure_nlp()
                if self.nlp is None:
                    raise RuntimeError("spaCy model failed to load")
                prev_doc = self.nlp(prev_chunk)
                prev_tokens = [token for token in prev_doc if not token.is_space]

                # Calculate overlap in tokens (use chunk_overlap directly as token count)
                overlap_tokens = min(self.chunk_overlap, len(prev_tokens))

                if overlap_tokens > 0:
                    overlap_token_objects = prev_tokens[-overlap_tokens:]
                    overlap_text = self._reconstruct_text_from_tokens(
                        overlap_token_objects
                    )

                    # Add overlap to current chunk if it doesn't already start with it
                    if not current_chunk.startswith(overlap_text.strip()):
                        current_chunk = overlap_text + " " + current_chunk
                        self.logger.debug(
                            f"Applied token-based overlap of {overlap_tokens} tokens between chunks"
                        )
            else:
                # Use token-based overlap for other separators too
                if self.nlp is None:
                    self._ensure_nlp()
                if self.nlp is None:
                    raise RuntimeError("spaCy model failed to load")
                prev_doc = self.nlp(prev_chunk)
                prev_tokens = [token for token in prev_doc if not token.is_space]

                # Target 20-30% overlap of the previous chunk in tokens
                target_overlap_tokens = max(
                    1, int(len(prev_tokens) * 0.25)
                )  # 25% overlap
                target_overlap_tokens = min(target_overlap_tokens, len(prev_tokens))
                target_overlap_tokens = min(
                    target_overlap_tokens, self.chunk_overlap
                )  # Respect max overlap setting

                if target_overlap_tokens > 0:
                    overlap_token_objects = prev_tokens[-target_overlap_tokens:]
                    overlap_text = self._reconstruct_text_from_tokens(
                        overlap_token_objects
                    )

                    # Add overlap to current chunk if it doesn't already start with it
                    if not current_chunk.startswith(overlap_text.strip()):
                        current_chunk = overlap_text + " " + current_chunk
                        self.logger.debug(
                            f"Applied token overlap of {target_overlap_tokens} tokens between chunks"
                        )

            result.append(current_chunk)

        return result

    def _get_split_doc(self, split_text: str, doc: Doc | None) -> Doc:
        """Get the spaCy doc for the split text, either from the original doc or by re-tokenizing."""
        if doc:
            # Find the corresponding span in the original doc
            for sent in doc.sents:
                if sent.text.strip() == split_text.strip():
                    return sent  # type: ignore

        # Fallback: re-tokenize the split
        if self.nlp is None:
            self._ensure_nlp()
        if self.nlp is None:
            raise RuntimeError("spaCy model failed to load")
        split_doc = self.nlp(split_text)
        self.logger.debug("Re-tokenized split for sentence-based splitting")
        return split_doc

    def _add_accumulated_chunk(
        self, current_chunk_tokens: list, current_token_count: int, chunks: list[str]
    ) -> tuple[list, int]:
        """Add accumulated tokens as a chunk if they exist."""
        if current_chunk_tokens:
            chunk_text = self._reconstruct_text_from_tokens(current_chunk_tokens)
            chunks.append(chunk_text)
            self.logger.debug(f"Created chunk of {current_token_count} tokens")
            return [], 0
        return current_chunk_tokens, current_token_count

    def _process_sentence(
        self,
        sent,
        chunks: list[str],
        current_chunk_tokens: list,
        current_token_count: int,
    ) -> tuple[list, int]:
        """Process a single sentence and update chunk state."""
        sent_text = sent.text.strip()
        if not sent_text:
            return current_chunk_tokens, current_token_count

        # Count tokens in this sentence (excluding spaces)
        sent_tokens = [token for token in sent if not token.is_space]
        sent_token_count = len(sent_tokens)

        # If a single sentence is longer than chunk_size, keep it as its own chunk
        if sent_token_count > self.chunk_size:
            # Add accumulated tokens as a chunk first
            current_chunk_tokens, current_token_count = self._add_accumulated_chunk(
                current_chunk_tokens, current_token_count, chunks
            )
            # Add the long sentence as its own chunk
            chunks.append(sent_text)
            self.logger.debug(
                f"Added long sentence as chunk: {sent_token_count} tokens"
            )
            return current_chunk_tokens, current_token_count

        # If adding this sentence would exceed chunk_size, start a new chunk
        if current_token_count + sent_token_count > self.chunk_size:
            current_chunk_tokens, current_token_count = self._add_accumulated_chunk(
                current_chunk_tokens, current_token_count, chunks
            )
            return sent_tokens, sent_token_count

        # Otherwise, add to current chunk
        current_chunk_tokens.extend(sent_tokens)
        current_token_count += sent_token_count
        return current_chunk_tokens, current_token_count

    def _split_by_sentences_with_token_limits(
        self, split_text: str, doc: Doc | None
    ) -> list[str]:
        """Split text into sentence-based chunks when it exceeds chunk_size, using token counts."""
        chunks = []

        # Get the document for processing
        split_doc = (
            self._get_split_doc(split_text, doc)
            if doc is not None
            else self._get_split_doc(split_text, None)
        )

        current_chunk_tokens = []
        current_token_count = 0

        # Process each sentence
        # split_doc is a Doc or Span, both have .sents attribute
        for sent in split_doc.sents:  # type: ignore
            current_chunk_tokens, current_token_count = self._process_sentence(
                sent, chunks, current_chunk_tokens, current_token_count
            )

        # Add any remaining tokens in the current chunk
        if current_chunk_tokens:
            chunk_text = self._reconstruct_text_from_tokens(current_chunk_tokens)
            chunks.append(chunk_text)
            self.logger.debug(
                f"Added final sentence chunk of {current_token_count} tokens"
            )

        return chunks

    def _process_initial_splits(self, text: str, doc: Doc | None) -> list[str]:
        """Process initial text splits based on separator, using token counts for decisions."""
        chunks = []

        # First split by separator - these are our primary chunk boundaries
        if self.separator and self.separator != " ":
            # For non-space separators, split directly
            initial_splits = text.split(self.separator)
            self.logger.debug(
                f"Split text into {len(initial_splits)} parts using separator '{self.separator}'"
            )
        else:
            initial_splits = [text]

        for split_text in initial_splits:
            split_text = split_text.strip()
            if not split_text:
                continue

            # Count tokens in this split to decide if further splitting is needed
            split_token_count = 0
            if doc:
                # Find tokens that belong to this split
                split_tokens = []
                for token in doc:
                    if not token.is_space and token.text in split_text:
                        split_tokens.append(token)
                split_token_count = len(split_tokens)
            else:
                # Fallback: estimate tokens as words
                split_token_count = len(split_text.split())

            # If the split has more tokens than chunk_size, break it down further with spaCy
            if split_token_count > self.chunk_size:
                try:
                    sentence_chunks = self._split_by_sentences_with_token_limits(
                        split_text, doc
                    )
                    chunks.extend(sentence_chunks)
                except Exception as e:
                    error_msg = f"Error processing text with spaCy: {str(e)}"
                    self.logger.error(error_msg)
                    raise RuntimeError(error_msg) from e
            else:
                # If the split has fewer tokens than chunk_size, add it directly
                chunks.append(split_text)
                self.logger.debug(
                    f"Added small split as chunk: {split_token_count} tokens"
                )

        return chunks

    def _force_split_large_chunk(self, chunks: list[str]) -> list[str]:
        """Force split single large chunks into multiple chunks."""
        if len(chunks) != 1 or len(chunks[0].split()) < 300:
            return chunks

        single_chunk = chunks[0]
        chunk_words = single_chunk.split()
        target_chunk_size = max(200, len(chunk_words) // 2)  # Split roughly in half

        self.logger.info(
            f"Forcing split of single large chunk ({len(chunk_words)} words) into multiple chunks"
        )

        # Split the single chunk into roughly equal parts
        forced_chunks = []
        current_chunk_words = []

        for word in chunk_words:
            current_chunk_words.append(word)

            # If we've reached target size and we're at a sentence boundary, split here
            if len(current_chunk_words) >= target_chunk_size and word.endswith(
                (".", "!", "?", ":", ";")
            ):
                forced_chunks.append(" ".join(current_chunk_words))
                current_chunk_words = []

        # Add any remaining words
        if current_chunk_words:
            if forced_chunks:
                # Add to last chunk if it's small
                last_chunk_words = forced_chunks[-1].split()
                if len(current_chunk_words) < 50:  # Very small remainder
                    forced_chunks[-1] = " ".join(last_chunk_words + current_chunk_words)
                else:
                    forced_chunks.append(" ".join(current_chunk_words))
            else:
                forced_chunks.append(" ".join(current_chunk_words))

        if len(forced_chunks) > 1:
            self.logger.info(
                f"Forced chunking created {len(forced_chunks)} chunks for overlap"
            )
            return forced_chunks

        return chunks

    def split_text(self, text: str, document_id: str | None = None) -> list[str]:
        """
        Split text into chunks using paragraph-based boundaries with fixed sizing.

        This implements the proven approach from RAG evaluation that showed 60% better
        precision than dynamic chunking by respecting natural paragraph boundaries.

        Args:
            text: Input text to split
            document_id: Optional document identifier for logging

        Returns:
            List of text chunks respecting paragraph boundaries
        """
        start_time = time.time()
        original_length = len(text)

        # Clean the text
        text = self._clean_text(text)
        cleaned_length = len(text)

        if document_id:
            # Estimate word count for metrics
            word_count = self._estimate_word_count(text)

            # Log document-level metrics with FIXED chunking parameters
            self.logger.debug(
                f"Processing document - ID: {document_id} - {word_count} words, "
                f"original length: {original_length} chars, cleaned: {cleaned_length} chars"
            )

        # Apply paragraph-based chunking (proven approach from evaluation)
        # Show progress for large documents (>50k chars)
        show_progress = len(text) > 50000
        progress = None
        if show_progress:
            # Create a simple progress indicator for chunking stages
            from tqdm import tqdm

            progress = tqdm(
                total=3,
                desc=f"Chunking {document_id or 'document'}",
                unit="stage",
                leave=False,
            )
            progress.set_postfix(stage="paragraphs")

        chunks = self._chunk_by_paragraphs(text)

        if show_progress and progress is not None:
            progress.update(1)
            progress.set_postfix(stage="overlap")

        # Apply overlap between chunks
        overlapped_chunks = self._apply_overlap_to_chunks(chunks)

        if show_progress and progress is not None:
            progress.update(1)
            progress.set_postfix(stage="finalizing")

        # Log results
        processing_time = time.time() - start_time
        self.logger.debug(
            f"Chunking completed: {len(overlapped_chunks)} chunks in {processing_time:.2f}s"
        )

        # Log chunk statistics for quality monitoring
        chunk_sizes = [len(self._tokenize_text(chunk)) for chunk in overlapped_chunks]
        if chunk_sizes:
            avg_size = sum(chunk_sizes) / len(chunk_sizes)
            min_size, max_size = min(chunk_sizes), max(chunk_sizes)
            # Target range should be around the target_chunk_size (250 tokens)
            # Allow some variance: 188-313 tokens (75%-125% of target)
            target_min = int(self.target_chunk_size * 0.75)  # 188 tokens
            target_max = int(self.target_chunk_size * 1.25)  # 313 tokens
            target_range_count = sum(
                1 for size in chunk_sizes if target_min <= size <= target_max
            )
            compliance_rate = (target_range_count / len(chunk_sizes)) * 100

            self.logger.debug(
                f"Chunk stats: avg={avg_size:.1f} tokens, range=[{min_size}-{max_size}], "
                f"target compliance={compliance_rate:.1f}% ({target_range_count}/{len(chunk_sizes)} in {target_min}-{target_max} range)"
            )

        if show_progress and progress is not None:
            progress.update(1)
            progress.close()

        # Record metrics for analysis
        if document_id:
            word_count = self._estimate_word_count(text)
            self._log_chunk_metrics(overlapped_chunks, word_count, document_id)

        return overlapped_chunks

    def _chunk_by_paragraphs(self, text: str) -> list[str]:
        """
        Handle paragraph-based chunking using the proven evaluation approach.

        This matches the winning strategy from RAG evaluation:
        1. Split on \\n\\n to respect natural paragraph boundaries
        2. Fall back to single \\n if insufficient double newlines found
        3. Group paragraphs to reach target token count
        4. Fall back to spaCy sentences if no clear paragraphs
        5. Force split large chunks using token-based approach
        """
        # Early return for empty text
        if not text.strip():
            return []

        # Get paragraphs using hierarchical approach
        paragraphs = self._extract_paragraphs(text)

        # Group paragraphs into chunks
        chunks = self._group_paragraphs_into_chunks(paragraphs)

        # Final safety check: force split any remaining large chunks
        final_chunks = self._force_split_large_chunks(chunks)

        return final_chunks

    def _extract_paragraphs(self, text: str) -> list[str]:
        """Extract paragraphs using hierarchical approach: double newlines -> single newlines -> spaCy sentences."""
        # Split on double newlines to respect natural paragraph boundaries
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

        # Check if we have sufficient paragraph structure
        if not self._has_sufficient_paragraph_structure(text, paragraphs):
            paragraphs = self._fallback_to_single_newlines(text, paragraphs)

        # Final fallback to spaCy sentences if no clear paragraphs exist
        if not paragraphs:
            paragraphs = self._fallback_to_spacy_sentences(text)

        return paragraphs

    def _has_sufficient_paragraph_structure(
        self, text: str, paragraphs: list[str]
    ) -> bool:
        """Check if we have sufficient paragraph structure with double newlines."""
        word_count = len(text.split())

        # Assume average paragraph length of 85 words (reasonable for most content)
        # Expect at least 50% of calculated paragraphs to consider structure sufficient
        expected_paragraphs = max(1, word_count // 85)  # At least 1 paragraph expected
        min_required_paragraphs = max(
            1, int(expected_paragraphs * 0.5)
        )  # 50% threshold

        has_sufficient_paragraphs = len(paragraphs) >= min_required_paragraphs

        self.logger.debug(
            f"Paragraph analysis: {word_count} words → expect ~{expected_paragraphs} paragraphs "
            f"(need ≥{min_required_paragraphs}), found {len(paragraphs)} from double newlines"
        )

        return has_sufficient_paragraphs

    def _fallback_to_single_newlines(
        self, text: str, original_paragraphs: list[str]
    ) -> list[str]:
        """Fall back to single newline splitting with intelligent line filtering."""
        self.logger.debug(
            f"Insufficient double newlines ({len(original_paragraphs)} paragraphs), "
            f"falling back to single newline splitting"
        )

        # Split on single newlines and filter out very short fragments
        single_newline_paragraphs = [p.strip() for p in text.split("\n") if p.strip()]

        # Filter out fragments that are likely line wrapping rather than paragraphs
        filtered_paragraphs = []
        for i, para in enumerate(single_newline_paragraphs):
            if len(para) > 15:  # Substantial content
                if self._should_keep_paragraph(para, i, single_newline_paragraphs):
                    filtered_paragraphs.append(para)
                elif filtered_paragraphs:
                    # Merge with previous paragraph (likely line wrapping)
                    filtered_paragraphs[-1] += " " + para
                else:
                    # First paragraph, keep it
                    filtered_paragraphs.append(para)
            elif filtered_paragraphs:
                # Short fragment, merge with previous
                filtered_paragraphs[-1] += " " + para
            else:
                # Very short first fragment, keep it
                filtered_paragraphs.append(para)

        if len(filtered_paragraphs) > len(original_paragraphs):
            double_newline_count = len(original_paragraphs)
            self.logger.debug(
                f"Single newline fallback produced {len(filtered_paragraphs)} paragraphs "
                f"(vs {double_newline_count} from double newlines)"
            )
            return filtered_paragraphs

        return original_paragraphs

    def _should_keep_paragraph(
        self, para: str, index: int, all_paragraphs: list[str]
    ) -> bool:
        """Determine if a paragraph should be kept as separate or merged with previous."""
        # Keep lines that: 1) End with sentence punctuation, 2) Start with capital letter, 3) Are the last line
        ends_with_punct = para.endswith((".", "!", "?", ":", ";"))
        starts_with_capital = para[0].isupper() if para else False
        is_last = index == len(all_paragraphs) - 1

        return ends_with_punct or starts_with_capital or is_last

    def _fallback_to_spacy_sentences(self, text: str) -> list[str]:
        """Fall back to spaCy sentence splitting or token-based splitting."""
        try:
            self._ensure_nlp()
            if self.nlp is None:
                raise RuntimeError("spaCy model failed to load")
            doc = self.nlp(text)
            paragraphs = [sent.text.strip() for sent in doc.sents if sent.text.strip()]
            self.logger.debug(
                "No clear paragraphs found, fell back to spaCy sentence splitting"
            )
            return paragraphs
        except Exception as e:
            self.logger.warning(
                f"spaCy processing failed, falling back to token-based splitting: {e}"
            )
            return self._fallback_to_token_based_splitting(text)

    def _fallback_to_token_based_splitting(self, text: str) -> list[str]:
        """Final fallback to token-based splitting."""
        try:
            self._ensure_nlp()
            if self.nlp is None:
                raise RuntimeError("spaCy model failed to load")
            doc = self.nlp(text)
            token_chunks = self._split_by_tokens(text, doc)
            self.logger.info(
                f"Token-based fallback produced {len(token_chunks)} chunks"
            )
            return token_chunks
        except Exception as token_error:
            self.logger.error(
                f"Both spaCy and token-based splitting failed: {token_error}"
            )
            # Last resort: use full text but we'll force split it later
            return [text.strip()] if text.strip() else []

    def _group_paragraphs_into_chunks(self, paragraphs: list[str]) -> list[str]:
        """Group paragraphs to reach target chunk size."""
        chunks = []
        current_chunk = []
        current_length = 0

        # Show progress for documents with many paragraphs (>100)
        paragraphs_iter = self._get_paragraphs_iterator(paragraphs)

        for para in paragraphs_iter:
            para_tokens = len(self._tokenize_text(para))

            # If this single paragraph is larger than chunk size, split it immediately
            if para_tokens > self.chunk_size:
                chunks = self._handle_large_paragraph(
                    para, para_tokens, chunks, current_chunk
                )
                current_chunk = []
                current_length = 0
                continue

            # If adding this paragraph would exceed chunk size, finalize current chunk
            if current_length + para_tokens > self.chunk_size and current_chunk:
                chunks.append(" ".join(current_chunk))
                current_chunk = [para]
                current_length = para_tokens
            else:
                current_chunk.append(para)
                current_length += para_tokens

        # Close progress bar if it was opened (tqdm objects have close method)
        if hasattr(paragraphs_iter, "close") and callable(
            getattr(paragraphs_iter, "close", None)
        ):
            paragraphs_iter.close()  # type: ignore

        # Add the final chunk if it exists
        if current_chunk:
            chunks.append(" ".join(current_chunk))

        return chunks

    def _get_paragraphs_iterator(self, paragraphs: list[str]):
        """Get an iterator for paragraphs, with progress bar for large documents."""
        show_para_progress = len(paragraphs) > 100
        if show_para_progress:
            from tqdm import tqdm

            return tqdm(
                paragraphs, desc="Processing paragraphs", unit="para", leave=False
            )
        else:
            return paragraphs

    def _handle_large_paragraph(
        self, para: str, para_tokens: int, chunks: list[str], current_chunk: list[str]
    ) -> list[str]:
        """Handle paragraphs that exceed chunk size by splitting them."""
        # First, finalize any current chunk
        if current_chunk:
            chunks.append(" ".join(current_chunk))

        # Split the large paragraph using token-based approach
        try:
            self._ensure_nlp()
            if self.nlp is None:
                raise RuntimeError("spaCy model failed to load")
            doc: Doc = self.nlp(para)
            para_chunks = self._split_by_tokens(para, doc)
            chunks.extend(para_chunks)
            self.logger.debug(
                f"Split large paragraph ({para_tokens} tokens) into {len(para_chunks)} chunks"
            )
        except Exception as e:
            self.logger.warning(
                f"Failed to split large paragraph, keeping as single chunk: {e}"
            )
            chunks.append(para)

        return chunks

    def _force_split_large_chunks(self, chunks: list[str]) -> list[str]:
        """Final safety check: force split any remaining large chunks."""
        final_chunks = []
        for chunk in chunks:
            chunk_tokens = len(self._tokenize_text(chunk))
            if chunk_tokens > self.chunk_size:
                try:
                    self._ensure_nlp()
                    if self.nlp is None:
                        raise RuntimeError("spaCy model failed to load")
                    doc = self.nlp(chunk)
                    split_chunks = self._split_by_tokens(chunk, doc)
                    final_chunks.extend(split_chunks)
                    self.logger.debug(
                        f"Force-split large chunk ({chunk_tokens} tokens) into {len(split_chunks)} chunks"
                    )
                except Exception as e:
                    self.logger.warning(f"Failed to force-split large chunk: {e}")
                    final_chunks.append(chunk)
            else:
                final_chunks.append(chunk)

        return final_chunks

    def _apply_overlap_to_chunks(self, chunks: list[str]) -> list[str]:
        """
        Apply overlap to chunks by prepending tokens from the previous chunk.

        This matches the proven evaluation approach for maintaining context.
        Uses NLTK word_tokenize to preserve punctuation spacing.
        Respects the target token limit when adding overlap.
        """
        if self.chunk_overlap <= 0 or len(chunks) <= 1:
            return chunks

        # Show progress for documents with many chunks (>50)
        show_overlap_progress = len(chunks) > 50
        overlap_progress = None
        if show_overlap_progress:
            from tqdm import tqdm

            overlap_progress = tqdm(
                total=len(chunks), desc="Applying overlap", unit="chunk", leave=False
            )

        overlapped_chunks = []

        for i, chunk in enumerate(chunks):
            if show_overlap_progress and overlap_progress is not None:
                overlap_progress.update(1)

            overlapped_chunk = chunk

            # Add overlap from previous chunk using NLTK tokenization
            if i > 0:
                # Calculate how much overlap we can add without exceeding target token limit
                chunk_tokens = len(self._tokenize_text(chunk))
                # Account for the space character that will be added during concatenation
                space_tokens = len(self._tokenize_text(" "))
                max_overlap_tokens = (
                    self.target_chunk_size - chunk_tokens - space_tokens
                )

                if max_overlap_tokens > 0:
                    # Use tiktoken directly for consistent tokenization
                    try:
                        model_name = self._get_embedding_model()
                        encoding = tiktoken.encoding_for_model(model_name)

                        # Tokenize the previous chunk to get token IDs
                        prev_chunk_token_ids = encoding.encode(chunks[i - 1])

                        # Use the minimum of: configured overlap, available previous tokens, and token budget
                        actual_overlap = min(
                            self.chunk_overlap,
                            len(prev_chunk_token_ids),
                            max_overlap_tokens,
                        )

                        # Take the last N token IDs for overlap
                        overlap_token_ids = prev_chunk_token_ids[-actual_overlap:]

                        # Use tiktoken's decode to properly reconstruct text
                        overlap_text = encoding.decode(overlap_token_ids).strip()
                    except (ImportError, Exception) as e:
                        # Fallback to _tokenize_text method if tiktoken fails
                        self.logger.warning(
                            f"Failed to use tiktoken for overlap calculation: {e}"
                        )
                        prev_chunk_tokens = self._tokenize_text(chunks[i - 1])
                        actual_overlap = min(
                            self.chunk_overlap,
                            len(prev_chunk_tokens),
                            max_overlap_tokens,
                        )
                        overlap_tokens = prev_chunk_tokens[-actual_overlap:]
                        overlap_text = " ".join(overlap_tokens).strip()
                    overlapped_chunk = overlap_text + " " + chunk

                    # Safety check: verify we didn't exceed target token limit
                    final_token_count = len(self._tokenize_text(overlapped_chunk))
                    if final_token_count > self.target_chunk_size:
                        self.logger.warning(
                            f"Overlap would exceed target token limit ({final_token_count} > {self.target_chunk_size}), using original chunk"
                        )
                        overlapped_chunk = chunk
                else:
                    self.logger.warning(
                        f"Chunk already at target token limit ({chunk_tokens} tokens), skipping overlap"
                    )

            overlapped_chunks.append(overlapped_chunk)

        if show_overlap_progress and overlap_progress is not None:
            overlap_progress.close()

        return overlapped_chunks

    def split_documents(self, documents: list[Document]) -> list[Document]:
        """
        Split documents into chunks.

        Args:
            documents (List[Document]): The documents to split

        Returns:
            List[Document]: A list of chunked documents

        Raises:
            ValueError: If the input is not a list of Document objects
            RuntimeError: If there's an error processing the documents
        """
        if not isinstance(documents, list):
            error_msg = f"Expected list of documents, got {type(documents)}"
            self.logger.error(error_msg)
            raise ValueError(error_msg)

        try:
            chunked_docs = []
            self.logger.info(f"Starting to split {len(documents)} documents")

            # Only show progress bar for multiple documents
            if len(documents) > 1:
                from tqdm import tqdm

                documents_iter = tqdm(documents, desc="Splitting documents", unit="doc")
            else:
                documents_iter = documents

            for i, doc in enumerate(documents_iter):
                # Check if doc has required attributes (supports both local Document and LangChain Document)
                if not hasattr(doc, "page_content") or not hasattr(doc, "metadata"):
                    error_msg = f"Expected Document object with 'page_content' and 'metadata' attributes, got {type(doc)}"
                    self.logger.error(error_msg)
                    raise ValueError(error_msg)

                text = doc.page_content
                # Generate document ID from metadata or use index
                document_id = (
                    doc.metadata.get("source")
                    or doc.metadata.get("title")
                    or doc.metadata.get("id")
                    or f"doc_{i}"
                )

                chunks = self.split_text(text, document_id=document_id)

                for j, chunk in enumerate(chunks):
                    if chunk:
                        # Add chunk index to metadata for tracking
                        chunk_metadata = doc.metadata.copy()
                        chunk_metadata["chunk_index"] = j
                        chunk_metadata["total_chunks"] = len(chunks)
                        chunk_metadata["document_id"] = document_id

                        chunked_docs.append(
                            Document(page_content=chunk, metadata=chunk_metadata)
                        )

            self.logger.info(
                f"Split {len(documents)} documents into {len(chunked_docs)} chunks"
            )

            # Log comprehensive metrics summary
            if self.log_summary_on_split:
                self.metrics.log_summary(self.logger)

            return chunked_docs
        except Exception as e:
            if isinstance(e, ValueError | RuntimeError):
                raise
            error_msg = f"Unexpected error in split_documents: {str(e)}"
            self.logger.error(error_msg)
            raise RuntimeError(error_msg) from e

    def get_metrics_summary(self) -> dict:
        """
        Get a dictionary summary of chunking metrics for external analysis.

        Returns:
            dict: Summary of chunking metrics including distributions and edge cases.
                 Note: chunk_size_distribution uses token counts aligned with 600-token target.
        """
        return {
            "total_documents": self.metrics.total_documents,
            "total_chunks": self.metrics.total_chunks,
            "avg_chunks_per_document": self.metrics.total_chunks
            / self.metrics.total_documents
            if self.metrics.total_documents > 0
            else 0,
            "word_count_distribution": self.metrics.word_count_distribution.copy(),
            "chunk_size_distribution_tokens": self.metrics.chunk_size_distribution.copy(),
            "edge_cases_count": len(self.metrics.edge_cases),
            "anomalies_count": len(self.metrics.anomalies),
            "edge_cases": self.metrics.edge_cases.copy(),
            "anomalies": self.metrics.anomalies.copy(),
        }
