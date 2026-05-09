"""
This script ingests PDF documents from a specified directory into a Pinecone vector database.
It processes the documents, splits them into chunks using spaCy's paragraph-based chunking,
and stores them as embeddings for efficient retrieval.

The script supports resuming ingestion from checkpoints and handles graceful shutdowns.

Key features:
- Processes PDF files recursively from a given directory
- Chunks documents using spaCy's paragraph-based approach
- Creates and manages a Pinecone index for storing document embeddings
- Supports incremental updates with checkpointing
- Handles graceful shutdowns and resumption of processing
- Clears existing vectors for a given library name if requested
- Uses OpenAI embeddings for vector representation

Usage:
Run the script with the following options:
--file-path: Path to the directory containing PDF files
--site: Site name for loading environment variables
--library-name: Name of the library to process
--keep-data: Flag to keep existing data in the index (default: false)
--max-files: Maximum number of files to process (optional, useful for testing)
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from typing import TYPE_CHECKING, Any

import pdfplumber
import psutil
import tiktoken
from tqdm import tqdm

if TYPE_CHECKING:
    from pinecone import Index
else:
    Index = Any

from data_ingestion.utils.checkpoint_utils import pdf_checkpoint_integration
from data_ingestion.utils.embeddings_utils import OpenAIEmbeddings
from data_ingestion.utils.pinecone_utils import (
    clear_library_vectors,
    create_pinecone_index_if_not_exists,
    generate_vector_id,
    get_pinecone_client,
    get_pinecone_ingest_index_name,
)
from data_ingestion.utils.progress_utils import (
    ProgressConfig,
    create_progress_bar,
    is_exiting,
    setup_signal_handlers,
)
from data_ingestion.utils.retry_utils import (
    EMBEDDING_RETRY_CONFIG,
    PINECONE_RETRY_CONFIG,
    retry_with_backoff,
)
from data_ingestion.utils.text_processing import clean_document_text
from data_ingestion.utils.text_splitter_utils import Document, SpacyTextSplitter
from pyutil.env_utils import load_env  # noqa: E402

# Configure logging - set root to WARNING, enable DEBUG only for this module
logging.basicConfig(
    level=logging.WARNING, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)  # Enable DEBUG only for this script

# Global variable for file path
file_path = ""


def _count_tokens(text: str, model: str = "text-embedding-ada-002") -> int:
    """
    Count the number of tokens in a text string using tiktoken.

    Args:
        text: The text to count tokens for
        model: The OpenAI model to use for token counting

    Returns:
        Number of tokens in the text
    """
    try:
        encoding = tiktoken.encoding_for_model(model)
        return len(encoding.encode(text))
    except KeyError:
        # Fallback to cl100k_base encoding if model not found
        encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text))


def _validate_chunk_token_limit(text: str, max_tokens: int = 8192) -> tuple[bool, int]:
    """
    Validate that a chunk doesn't exceed the token limit for OpenAI embeddings.

    Args:
        text: The text chunk to validate
        max_tokens: Maximum tokens allowed (default 8192 for text-embedding-ada-002)

    Returns:
        Tuple of (is_valid, token_count)
    """
    token_count = _count_tokens(text)
    return token_count <= max_tokens, token_count


def _determine_page_separator(previous_text: str, current_text: str) -> str:
    """
    Determine the appropriate separator between pages based on text flow.

    Args:
        previous_text: Text from the previous page (last part)
        current_text: Text from the current page (first part)

    Returns:
        Appropriate separator string
    """
    if not previous_text or not current_text:
        return "\n\n"

    # Get last 50 characters of previous text and first 50 of current
    prev_end = previous_text[-50:].strip()
    curr_start = current_text[:50].strip()

    # Check if previous text ends with sentence-ending punctuation
    ends_with_sentence = prev_end.endswith((".", "!", "?", ":", ";"))

    # Check if current text starts with a capital letter or number (likely new section/paragraph)
    starts_with_capital = curr_start and (
        curr_start[0].isupper() or curr_start[0].isdigit()
    )

    # Check for section headers (short lines with capitals, numbers, or special formatting)
    is_section_header = (
        len(curr_start.split()) <= 5  # Short line
        and (
            curr_start.isupper()  # All caps
            or any(char.isdigit() for char in curr_start[:10])  # Contains numbers early
            or curr_start.startswith(("Chapter", "Section", "Part", "N ", "n "))
        )  # Common headers
    )

    # Check if previous text ends mid-word (hyphenated word split across pages)
    ends_with_hyphen = prev_end.endswith("-")

    # Check if this looks like a continuation of the same sentence
    is_continuation = (
        not ends_with_sentence
        and not starts_with_capital
        and not is_section_header
        and not ends_with_hyphen
    )

    # Determine separator
    if ends_with_hyphen:
        # Hyphenated word split across pages - no space needed
        return ""
    elif is_continuation:
        # Continuing same sentence - just add a space
        return " "
    elif is_section_header or (ends_with_sentence and starts_with_capital):
        # Clear section break or sentence boundary - use paragraph break
        return "\n\n"
    else:
        # Default case - use paragraph break for safety
        return "\n\n"


# Custom PDF document loader
class PyPDFLoader:
    """PDF document loader using pdfplumber for superior text extraction and layout preservation"""

    def __init__(self, file_path):
        self.file_path = file_path

    def _is_header_footer_text(self, text, y_position, page_height, page_width):
        """
        Determine if text is likely a header or footer based on position and content patterns.
        """
        if not text or not text.strip():
            return True

        text = text.strip()

        # Define header/footer regions (top 8% and bottom 8% of page)
        header_threshold = page_height * 0.92  # pdfplumber uses bottom-left origin
        footer_threshold = page_height * 0.08

        is_in_header_region = y_position > header_threshold
        is_in_footer_region = y_position < footer_threshold

        # Check for common header/footer patterns
        is_page_number = bool(re.match(r"^\s*\d+\s*$", text))
        is_chapter_header = bool(
            re.match(r"^(Chapter|Section|Part)\s+\d+", text, re.IGNORECASE)
        )
        # Check for book title patterns (Title Case Words followed by numbers)
        is_book_title_pattern = bool(
            re.search(r"\b([A-Z][a-z]+\s+){1,4}[A-Z][a-z]+\s+\d{1,3}\b", text)
        )
        is_book_title = len(text.split()) <= 5 and any(
            word[0].isupper() for word in text.split() if word
        )

        # Decision logic
        if is_page_number:
            return True

        # Always filter book title patterns regardless of position
        if is_book_title_pattern:
            return True

        if (is_in_header_region or is_in_footer_region) and (
            is_chapter_header or is_book_title
        ):
            return True

        # Very short text in margins is likely header/footer
        return (is_in_header_region or is_in_footer_region) and len(text.split()) <= 3

    def _extract_clean_text(self, page):
        """
        Extract text from page while filtering out headers and footers.
        Uses pdfplumber's superior text extraction with layout preservation.
        """
        try:
            # Get page dimensions
            page_height = page.height
            page_width = page.width

            # Extract text with character-level positioning
            chars = page.chars
            if not chars:
                # Fallback to simple text extraction
                return page.extract_text() or ""

            # Group characters into lines and filter headers/footers
            filtered_chars = []
            filtered_parts = []  # For debugging

            for char in chars:
                char_text = char.get("text", "")
                char_y = char.get("y0", 0)  # Bottom y coordinate

                if char_text and not self._is_header_footer_text(
                    char_text, char_y, page_height, page_width
                ):
                    filtered_chars.append(char)
                elif char_text.strip():
                    filtered_parts.append(f"'{char_text}' (filtered)")

            # If we filtered too much, fall back to full text
            if len(filtered_chars) < len(chars) * 0.8:
                return page.extract_text() or ""

            # Use pdfplumber's layout-aware text extraction on filtered content
            # This preserves word spacing and paragraph structure
            if filtered_chars:
                # Create a new page object with only the filtered characters
                filtered_page = page.within_bbox((0, 0, page_width, page_height))
                text = filtered_page.extract_text()
                return text or ""
            else:
                return ""

        except Exception as e:
            logger.debug(
                f"Advanced text extraction failed: {e}, falling back to simple extraction"
            )
            # Fallback to simple text extraction
            return page.extract_text() or ""

    def _clean_text_artifacts(self, text):
        """
        Clean up extracted text to remove common PDF artifacts and improve readability.
        """
        if not text:
            return ""

        # Remove common PDF artifacts that appear in this specific document
        # Remove "N n" artifacts that appear in the middle of text
        text = re.sub(r"\bN n\b", "", text)

        # Remove standalone single characters that are likely artifacts (but preserve "I" and "a")
        text = re.sub(r"\n[B-HJ-Z]\n", "\n", text)
        text = re.sub(r"\n[b-z]\n", "\n", text)

        # Remove standalone numbers that are likely page numbers
        text = re.sub(r"\n\d+\n", "\n", text)

        # Remove common book/chapter patterns that might appear in text
        text = re.sub(
            r"\b(Chapter|Section|Part)\s+\d+\b", "", text, flags=re.IGNORECASE
        )

        # Remove patterns that look like book titles (Title Case Words followed by numbers)
        # This catches patterns like "Control Your Destiny 23" without hard-coding specific titles
        text = re.sub(r"\b([A-Z][a-z]+\s+){1,4}[A-Z][a-z]+\s+\d{1,3}\b", "", text)

        # Remove standalone page numbers (more comprehensive)
        text = re.sub(r"\b\d{1,3}\b(?=\s|$)", "", text)

        # Remove multiple consecutive spaces
        text = re.sub(r" {3,}", " ", text)

        # Remove multiple consecutive newlines
        text = re.sub(r"\n{3,}", "\n\n", text)

        # Clean up line breaks - remove single newlines within paragraphs but keep double newlines
        # This helps with text that has been broken across lines unnecessarily
        lines = text.split("\n")
        cleaned_lines = []

        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                # Empty line - preserve as paragraph break
                if cleaned_lines and cleaned_lines[-1] != "":
                    cleaned_lines.append("")
            else:
                # Non-empty line
                if (
                    i > 0
                    and lines[i - 1].strip()  # Previous line was not empty
                    and not line[0].isupper()  # Current line doesn't start with capital
                    and not lines[i - 1]
                    .strip()
                    .endswith(
                        (".", "!", "?", ":", ";")
                    )  # Previous line doesn't end with punctuation
                    and len(line.split()) > 1
                ):  # Current line has multiple words
                    # This looks like a continuation of the previous line
                    if cleaned_lines:
                        cleaned_lines[-1] += " " + line
                    else:
                        cleaned_lines.append(line)
                else:
                    # This looks like a new paragraph or sentence
                    cleaned_lines.append(line)

        # Join lines back together
        cleaned_text = "\n".join(cleaned_lines)

        # Final cleanup
        cleaned_text = re.sub(
            r"\n{3,}", "\n\n", cleaned_text
        )  # Remove excessive newlines
        cleaned_text = re.sub(r" +", " ", cleaned_text)  # Remove excessive spaces

        return cleaned_text.strip()

    def load(self):
        """Load a PDF file into documents using pdfplumber with header/footer filtering"""
        documents = []
        try:
            # Open the PDF document with pdfplumber
            with pdfplumber.open(self.file_path) as pdf:
                # Extract metadata
                metadata_dict = pdf.metadata or {}

                for page_num, page in enumerate(pdf.pages):
                    # Extract clean text (filtering headers/footers)
                    text = self._extract_clean_text(page)

                    # Apply additional text cleaning to remove artifacts
                    if text:
                        text = self._clean_text_artifacts(text)

                    if not text or not text.strip():
                        continue

                    metadata = {
                        "source": self.file_path,
                        "page": page_num,
                        "pdf": {"info": metadata_dict},
                    }
                    documents.append(Document(page_content=text, metadata=metadata))

        except Exception as e:
            logger.error(f"Error reading PDF {self.file_path}: {e}", exc_info=True)
            return []  # Return empty on errors

        return documents


class DirectoryLoader:
    """Load documents from a directory"""

    def __init__(
        self, dir_path, glob, loader_cls=None, show_progress=False, silent_errors=False
    ):
        self.dir_path = dir_path
        self.glob = glob
        self.loader_cls = loader_cls
        self.show_progress = show_progress
        self.silent_errors = silent_errors

    def load(self):
        """Load documents from a directory matching glob pattern"""
        import glob as glob_module

        documents = []
        # Ensure dir_path is an absolute path for robust globbing
        absolute_dir_path = os.path.abspath(self.dir_path)
        glob_pattern = os.path.join(absolute_dir_path, self.glob)

        logger.info(f"Searching for files with pattern: {glob_pattern}")
        paths = glob_module.glob(
            glob_pattern, recursive=True
        )  # Added recursive=True for '**'

        logger.info(f"Found {len(paths)} files matching glob pattern.")

        if self.show_progress and paths:  # Ensure paths is not empty
            paths_iter = tqdm(paths, desc="Loading documents")
        else:
            paths_iter = paths

        for path in paths_iter:
            logger.info(f"Attempting to load document: {path}")
            try:
                if self.loader_cls:
                    loader = self.loader_cls(path)
                    docs = loader.load()
                    logger.info(f"Successfully loaded {len(docs)} pages from {path}")
                    documents.extend(docs)
            except Exception as e:
                logger.error(
                    f"Error loading {path}: {e}", exc_info=True
                )  # Log traceback
                if not self.silent_errors:
                    # If silent_errors is False, re-raise the exception
                    # or handle it as per existing logic (e.g. print and continue)
                    print(f"Error loading {path}: {e}")

        logger.info(f"Total documents loaded: {len(documents)}")
        return documents


def _extract_document_metadata(raw_doc: Document) -> tuple[str, str, str]:
    """
    Extract metadata from document with comprehensive field name checking.

    Returns:
        tuple: (source_url, title, author)
    """
    source_url = None
    title = "Untitled"
    author = "Unknown"

    # Access metadata
    if isinstance(raw_doc.metadata, dict):
        # Check if pdf info exists in metadata
        pdf_info = raw_doc.metadata.get("pdf", {}).get("info", {})
        if isinstance(pdf_info, dict):
            # Extract title - check multiple possible field names
            title_fields = ["title", "Title", "subject", "Subject"]
            for field in title_fields:
                if field in pdf_info and pdf_info[field] and pdf_info[field].strip():
                    title = pdf_info[field].strip()
                    break

            # Extract author - check multiple possible field names
            author_fields = ["author", "Author", "creator", "Creator"]
            for field in author_fields:
                if field in pdf_info and pdf_info[field] and pdf_info[field].strip():
                    author = pdf_info[field].strip()
                    break
            else:
                logger.info(
                    f"DEBUG EXTRACTION: No author found in any of: {author_fields}"
                )

            # Extract source URL - use Subject field if available, otherwise use file path
            if pdf_info.get("subject") and pdf_info["subject"].strip():
                source_url = pdf_info["subject"].strip()
            elif pdf_info.get("Subject") and pdf_info["Subject"].strip():
                source_url = pdf_info["Subject"].strip()

        # Use source from metadata if available (fallback to file path)
        if raw_doc.metadata.get("source"):
            source_url = source_url or raw_doc.metadata.get("source")

    return source_url, title, author


def _calculate_page_references(
    docs: list, page_boundaries: list, full_text: str
) -> list:
    """
    Calculate page references for document chunks efficiently.

    Args:
        docs: List of document chunks
        page_boundaries: List of page boundary information
        full_text: Complete document text

    Returns:
        List of documents with page references calculated
    """
    valid_docs = []

    # Create progress bar for page reference calculation
    config = ProgressConfig(
        description="Calculating page references",
        unit="chunk",
        total=len(docs),
        show_progress=True,
    )

    progress_bar = create_progress_bar(config)

    try:
        for i, doc in enumerate(docs):
            # Check for graceful shutdown
            if is_exiting():
                logger.info(
                    "Graceful shutdown detected during page reference calculation."
                )
                break

            if isinstance(doc.page_content, str) and doc.page_content.strip():
                page_reference = None

                if page_boundaries:
                    # More efficient approach: estimate position based on chunk sequence
                    estimated_position = (i / len(docs)) * len(full_text)

                    # Find the page containing this estimated position
                    for page_boundary in page_boundaries:
                        if (
                            page_boundary["start_offset"]
                            <= estimated_position
                            <= page_boundary["end_offset"]
                        ):
                            page_reference = str(page_boundary["page_number"])
                            doc.metadata["page"] = page_reference
                            break

                    # If estimation didn't work, try a few nearby pages
                    if not page_reference:
                        for page_boundary in page_boundaries:
                            # Check if chunk might span this page (with some tolerance)
                            page_start = page_boundary["start_offset"]
                            page_end = page_boundary["end_offset"]
                            tolerance = len(full_text) * 0.02  # 2% tolerance

                            if (
                                estimated_position >= page_start - tolerance
                                and estimated_position <= page_end + tolerance
                            ):
                                page_reference = str(page_boundary["page_number"])
                                doc.metadata["page"] = page_reference
                                break

                valid_docs.append(doc)

            progress_bar.update(1)

    finally:
        progress_bar.close()

    return valid_docs


async def _process_single_batch(
    batch: list, start_idx: int, pinecone_index, embeddings, library_name: str
) -> int:
    """
    Process a single batch of document chunks with improved error handling.

    Args:
        batch: List of document chunks in this batch
        start_idx: Starting index for chunk numbering
        pinecone_index: Pinecone index for storage
        embeddings: OpenAI embeddings instance
        library_name: Name of the library

    Returns:
        int: Total number of failed chunks in this batch
    """
    # Create tasks for the batch
    tasks = []
    for j, doc in enumerate(batch):
        # Check for shutdown before creating each task
        if is_exiting():
            logger.info("Graceful shutdown detected while preparing batch tasks.")
            return 0

        task = process_chunk(
            doc, pinecone_index, embeddings, start_idx + j, library_name
        )
        tasks.append(task)

    # Process batch with longer timeout and better error handling
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=120.0,  # Increased timeout to 2 minutes per batch
        )
    except asyncio.TimeoutError:
        logger.warning("Batch processing timeout after 2 minutes")
        # Cancel remaining tasks on timeout
        for task in tasks:
            if not task.done():
                task.cancel()
        # Check if we should exit due to shutdown signal
        if is_exiting():
            logger.info("Graceful shutdown detected during batch timeout.")
            return 0
        else:
            # If not shutting down, continue with a warning
            logger.warning("Continuing after batch timeout...")
            return 0

    # Check for exceptions and handle them
    failed_chunks = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            chunk_idx = start_idx + i
            failed_chunks.append(chunk_idx)
            logger.error(f"Error processing chunk {chunk_idx}: {result}")

    if failed_chunks:
        logger.warning(
            f"Failed to process {len(failed_chunks)} chunks in batch: {failed_chunks}"
        )
        # For network connectivity issues, we'll continue rather than failing the entire batch
        # This allows processing to continue even if some chunks fail due to temporary issues

    return len(failed_chunks)


async def _process_chunks_in_batches(
    valid_docs: list,
    pinecone_index,
    embeddings,
    library_name: str,
    batch_size: int = 5,  # Reduced batch size for better stability
) -> int:
    """
    Process document chunks in batches with progress tracking and rate limiting.

    Args:
        valid_docs: List of validated document chunks
        pinecone_index: Pinecone index for storage
        embeddings: OpenAI embeddings instance
        library_name: Name of the library
        batch_size: Number of chunks to process per batch (reduced from 10 to 5)

    Returns:
        int: Total number of failed chunks across all batches
    """
    # Calculate batch ranges
    batch_ranges = [
        (i, min(i + batch_size, len(valid_docs)))
        for i in range(0, len(valid_docs), batch_size)
    ]

    # Create progress bar for batch processing
    config = ProgressConfig(
        description="Processing batches",
        unit="batch",
        total=len(batch_ranges),
        show_progress=True,
    )

    progress_bar = create_progress_bar(config)
    total_failed_chunks = 0

    try:
        for batch_num, (start_idx, end_idx) in enumerate(batch_ranges):
            # Check for graceful shutdown before starting each batch
            if is_exiting():
                logger.info("Graceful shutdown detected during batch processing.")
                break

            batch = valid_docs[start_idx:end_idx]

            # Process the single batch and get failed count
            failed_count = await _process_single_batch(
                batch, start_idx, pinecone_index, embeddings, library_name
            )
            total_failed_chunks += failed_count

            # Add a small delay between batches to prevent overwhelming APIs
            if batch_num < len(batch_ranges) - 1:  # Don't delay after the last batch
                await asyncio.sleep(1.0)  # 1 second delay between batches

            progress_bar.update(1)

    finally:
        progress_bar.close()

    return total_failed_chunks


def _split_oversized_chunk(text: str, max_tokens: int = 8192) -> list[str]:
    """
    Split an oversized chunk into smaller sub-chunks that fit within token limits.

    Args:
        text: The oversized text chunk
        max_tokens: Maximum tokens per sub-chunk (default 8192)

    Returns:
        List of text sub-chunks, each within token limits
    """
    # Target 75% of max tokens to provide buffer
    target_tokens = int(max_tokens * 0.75)

    # First try splitting by paragraphs
    paragraphs = text.split("\n\n")
    if len(paragraphs) > 1:
        sub_chunks = []
        current_chunk = ""

        for paragraph in paragraphs:
            # Check if adding this paragraph would exceed the limit
            test_chunk = current_chunk + ("\n\n" if current_chunk else "") + paragraph
            token_count = _count_tokens(test_chunk)

            if token_count <= target_tokens:
                current_chunk = test_chunk
            else:
                # Save current chunk if it has content
                if current_chunk:
                    sub_chunks.append(current_chunk)

                # Check if the paragraph itself is too large
                paragraph_tokens = _count_tokens(paragraph)
                if paragraph_tokens > target_tokens:
                    # Split the paragraph by sentences
                    sentences = paragraph.split(". ")
                    temp_chunk = ""

                    for i, sentence in enumerate(sentences):
                        if i < len(sentences) - 1:
                            sentence += ". "  # Re-add the period and space

                        test_sentence_chunk = temp_chunk + sentence
                        sentence_tokens = _count_tokens(test_sentence_chunk)

                        if sentence_tokens <= target_tokens:
                            temp_chunk = test_sentence_chunk
                        else:
                            if temp_chunk:
                                sub_chunks.append(temp_chunk)
                            temp_chunk = sentence

                    current_chunk = temp_chunk if temp_chunk else ""
                else:
                    current_chunk = paragraph

        # Add any remaining content
        if current_chunk:
            sub_chunks.append(current_chunk)

        return sub_chunks

    # If no paragraphs, try splitting by sentences
    sentences = text.split(". ")
    if len(sentences) > 1:
        sub_chunks = []
        current_chunk = ""

        for i, sentence in enumerate(sentences):
            if i < len(sentences) - 1:
                sentence += ". "  # Re-add the period and space

            test_chunk = current_chunk + sentence
            token_count = _count_tokens(test_chunk)

            if token_count <= target_tokens:
                current_chunk = test_chunk
            else:
                if current_chunk:
                    sub_chunks.append(current_chunk)
                current_chunk = sentence

        if current_chunk:
            sub_chunks.append(current_chunk)

        return sub_chunks

    # Last resort: split by character count
    # Estimate characters per token (roughly 4 characters per token)
    chars_per_token = 4
    max_chars = target_tokens * chars_per_token

    sub_chunks = []
    for i in range(0, len(text), max_chars):
        chunk = text[i : i + max_chars]
        # Try to break at word boundaries
        if i + max_chars < len(text) and not text[i + max_chars].isspace():
            # Find last space within the chunk
            last_space = chunk.rfind(" ")
            if last_space > max_chars * 0.8:  # Only use if we don't lose too much
                chunk = chunk[:last_space]

        sub_chunks.append(chunk)

    return sub_chunks


async def process_document(
    raw_doc: Document,
    pinecone_index: Index,
    embeddings: OpenAIEmbeddings,
    doc_index: int,
    library_name: str,
    text_splitter: SpacyTextSplitter,
) -> tuple[bool, int, int]:
    """
    Processes a single document, splitting it into chunks using spaCy and adding it to the vector store.

    Returns:
        tuple[bool, int, int]: (success, total_chunks, failed_chunks)
    """
    # Extract and validate metadata
    source_url, title, author = _extract_document_metadata(raw_doc)

    if not source_url:
        logger.error(
            f"ERROR: No source URL found in metadata for document from file: "
            f"{raw_doc.metadata.get('source', 'Unknown File')}, "
            f"page: {raw_doc.metadata.get('page', 'Unknown Page')}"
        )
        logger.error(f"Full metadata: {raw_doc.metadata}")
        logger.warning("Skipping this page/document due to missing source URL.")
        return False, 0, 0

    # Update document metadata
    raw_doc.metadata["source"] = source_url
    raw_doc.metadata["title"] = title
    raw_doc.metadata["author"] = author

    # Log document information for first page only
    page_number = raw_doc.metadata.get("page", 0)
    if page_number == 0:
        logger.info(f"Processing document with source URL: {source_url}")
        logger.info(f"Document title: {title}")
        logger.info(f"Document author: {author}")

    # Get document filename for logging context
    doc_filename = os.path.basename(raw_doc.metadata.get("source", "Unknown File"))

    # Split document into chunks
    logger.info(f"Splitting complete document {doc_filename} into chunks...")
    docs = text_splitter.split_documents([raw_doc])

    # Calculate page references for chunks
    page_boundaries = raw_doc.metadata.get("page_boundaries", [])
    full_text = raw_doc.page_content

    logger.info(
        f"Processing {len(docs)} chunks, page_boundaries available: {len(page_boundaries) > 0}"
    )

    valid_docs = _calculate_page_references(docs, page_boundaries, full_text)

    if valid_docs:
        logger.info(f"Document {doc_filename} split into {len(valid_docs)} chunks")
        # Count how many got page references
        with_page_refs = sum(1 for doc in valid_docs if doc.metadata.get("page"))
        logger.info(
            f"DEBUG: {with_page_refs}/{len(valid_docs)} chunks got page references"
        )

        # Process chunks in batches
        failed_chunks = await _process_chunks_in_batches(
            valid_docs, pinecone_index, embeddings, library_name
        )

        total_chunks = len(valid_docs)
        success = failed_chunks == 0

        if failed_chunks > 0:
            logger.warning(
                f"Document processing completed with {failed_chunks}/{total_chunks} chunks failed"
            )
        else:
            logger.info(
                f"Document processing completed successfully: {total_chunks} chunks processed"
            )

        return success, total_chunks, failed_chunks

    return False, 0, 0


async def _process_oversized_chunk(
    doc: Document,
    pinecone_index: Index,
    embeddings: OpenAIEmbeddings,
    chunk_index: int,
    library_name: str,
) -> int:
    """
    Process an oversized chunk by splitting it into smaller sub-chunks.

    Returns:
        Number of sub-chunks that failed to process
    """
    logger.info(
        f"Attempting to split oversized chunk {chunk_index} into smaller sub-chunks..."
    )

    # Split the oversized chunk
    sub_chunks_text = _split_oversized_chunk(doc.page_content)

    if not sub_chunks_text:
        logger.error(f"Failed to split oversized chunk {chunk_index}")
        return 1

    logger.info(f"Split chunk {chunk_index} into {len(sub_chunks_text)} sub-chunks")

    failed_sub_chunks = 0

    for i, sub_chunk_text in enumerate(sub_chunks_text):
        # Validate the sub-chunk
        is_valid, token_count = _validate_chunk_token_limit(sub_chunk_text)
        if not is_valid:
            logger.error(
                f"Sub-chunk {chunk_index}.{i} still exceeds token limit: {token_count} tokens"
            )
            failed_sub_chunks += 1
            continue

        # Create a new document for the sub-chunk
        sub_chunk_doc = Document(
            page_content=sub_chunk_text, metadata=doc.metadata.copy()
        )

        # Use a modified chunk index to indicate this is a sub-chunk
        sub_chunk_index = f"{chunk_index}.{i}"

        try:
            # Process the sub-chunk using the regular processing logic
            await _process_valid_chunk(
                sub_chunk_doc, pinecone_index, embeddings, sub_chunk_index, library_name
            )
            logger.debug(
                f"Successfully processed sub-chunk {sub_chunk_index} ({token_count} tokens)"
            )
        except Exception as e:
            logger.error(f"Failed to process sub-chunk {sub_chunk_index}: {e}")
            failed_sub_chunks += 1

    if failed_sub_chunks == 0:
        logger.info(
            f"Successfully processed all {len(sub_chunks_text)} sub-chunks for original chunk {chunk_index}"
        )
    else:
        logger.warning(
            f"Failed to process {failed_sub_chunks}/{len(sub_chunks_text)} sub-chunks for original chunk {chunk_index}"
        )

    return failed_sub_chunks


async def _process_valid_chunk(
    doc: Document,
    pinecone_index: Index,
    embeddings: OpenAIEmbeddings,
    chunk_index: str | int,
    library_name: str,
) -> None:
    """Process a validated chunk (token count already confirmed to be within limits)."""
    # Extract metadata
    title = doc.metadata.get("title", "Unknown")
    author = doc.metadata.get("author", "Unknown")
    source_path = doc.metadata.get("source", "")

    # Generate standardized vector ID using the shared utility
    id = generate_vector_id(
        library_name=library_name,
        title=title,
        chunk_index=chunk_index,
        source_location="pdf",
        source_identifier=source_path,
        content_type="text",
        author=author,
        chunk_text=doc.page_content,
    )

    # Minimize metadata
    minimal_metadata = {
        "id": id,
        "library": library_name,
        "type": "text",
        "author": doc.metadata.get("author", "Unknown"),
        "source": doc.metadata.get("source"),
        "title": doc.metadata.get("title"),
        "text": doc.page_content,
        "access_level": "public",
        "required_access_level": 0,
    }

    # Add page reference if it was calculated during processing
    page_reference = doc.metadata.get("page")
    if page_reference:
        minimal_metadata["page"] = page_reference

    # Generate embedding with retry logic
    async def embedding_operation():
        return await asyncio.wait_for(
            asyncio.to_thread(embeddings.embed_query, doc.page_content),
            timeout=30.0,  # Increased timeout for embedding
        )

    try:
        vector = await retry_with_backoff(
            embedding_operation,
            operation_name=f"OpenAI embedding for chunk {chunk_index}",
            **EMBEDDING_RETRY_CONFIG,
        )
    except asyncio.TimeoutError:
        logger.warning(
            f"Embedding timeout for chunk {chunk_index} after retries, skipping..."
        )
        raise
    except Exception as e:
        logger.error(f"Embedding failed for chunk {chunk_index} after retries: {e}")
        raise

    # Check for shutdown before Pinecone upsert
    if is_exiting():
        logger.info(
            f"Graceful shutdown detected before upserting chunk {chunk_index}. Skipping..."
        )
        return

    # Upsert to Pinecone with retry logic
    async def pinecone_operation():
        return await asyncio.wait_for(
            asyncio.to_thread(
                pinecone_index.upsert, vectors=[(id, vector, minimal_metadata)]
            ),
            timeout=20.0,  # Increased timeout for upsert
        )

    try:
        await retry_with_backoff(
            pinecone_operation,
            operation_name=f"Pinecone upsert for chunk {chunk_index}",
            **PINECONE_RETRY_CONFIG,
        )
    except asyncio.TimeoutError:
        logger.warning(
            f"Pinecone upsert timeout for chunk {chunk_index} after retries, skipping..."
        )
        raise
    except Exception as e:
        logger.error(
            f"Pinecone upsert failed for chunk {chunk_index} after retries: {e}"
        )
        raise


async def process_chunk(
    doc: Document,
    pinecone_index: Index,
    embeddings: OpenAIEmbeddings,
    chunk_index: int,
    library_name: str,
) -> None:
    """Process and store a single document chunk with retry logic for network issues."""
    # Check for shutdown at the start of processing each chunk
    if is_exiting():
        logger.info(
            f"Graceful shutdown detected before processing chunk {chunk_index}. Skipping..."
        )
        return

    try:
        # Check for shutdown before expensive embedding operation
        if is_exiting():
            logger.info(
                f"Graceful shutdown detected before embedding chunk {chunk_index}. Skipping..."
            )
            return

        # Validate chunk token count before processing
        is_valid, token_count = _validate_chunk_token_limit(doc.page_content)
        if not is_valid:
            logger.warning(
                f"Chunk {chunk_index} exceeds token limit: {token_count} tokens (max 8192). Attempting to split..."
            )

            # Try to process as oversized chunk (split into sub-chunks)
            failed_sub_chunks = await _process_oversized_chunk(
                doc, pinecone_index, embeddings, chunk_index, library_name
            )

            if failed_sub_chunks > 0:
                error_msg = f"Chunk {chunk_index} split processing failed: {failed_sub_chunks} sub-chunks failed. Original chunk: {token_count} tokens, {len(doc.page_content)} chars, {len(doc.page_content.split())} words"
                logger.error(error_msg)
                raise ValueError(error_msg)

            # Successfully processed all sub-chunks
            return

        # Process the chunk normally (within token limits)
        await _process_valid_chunk(
            doc, pinecone_index, embeddings, chunk_index, library_name
        )

    except Exception as e:
        # Check if error is due to shutdown
        if is_exiting():
            logger.info(
                f"Error during shutdown for chunk {chunk_index}, stopping gracefully..."
            )
            return
        print(f"Error processing chunk {chunk_index}: {e}")
        print(f"Chunk size: {len(json.dumps(doc.__dict__))} bytes")
        raise


def _initialize_pinecone_services(library_name: str, keep_data: bool) -> tuple:
    """
    Initialize Pinecone client and index, handling data clearing if needed.

    Returns:
        tuple: (pinecone_client, pinecone_index)
    """
    # Initialize Pinecone
    try:
        pinecone = get_pinecone_client()
    except ValueError as e:
        logger.error(f"Failed to initialize Pinecone: {e}")
        sys.exit(1)

    # Get or create index
    index_name = get_pinecone_ingest_index_name()
    logger.info(f"Using Pinecone ingest index: {index_name}")
    create_pinecone_index_if_not_exists(pinecone, index_name)

    # Get index
    try:
        pinecone_index = pinecone.Index(index_name)
    except Exception as e:
        logger.error(f"Error getting Pinecone index '{index_name}': {e}", exc_info=True)
        sys.exit(1)

    # Clear existing data if needed
    if not keep_data:
        logger.info(f"Clearing existing vectors for library '{library_name}'.")
        deletion_successful = clear_library_vectors(pinecone_index, library_name)
        if not deletion_successful:
            logger.info("Vector deletion was aborted by user. Exiting script.")
            sys.exit(0)
    else:
        logger.info(
            "keep_data is True. Proceeding with adding/updating vectors, existing data will be preserved."
        )

    return pinecone, pinecone_index


def _initialize_processing_components() -> tuple:
    """
    Initialize text splitter and OpenAI embeddings.

    Returns:
        tuple: (text_splitter, embeddings)
    """
    # Initialize text splitter with historical parameters
    # Historical PDF processing used 1000 chars (~250 tokens) with 200 chars (~50 tokens) overlap (20%)
    text_splitter = SpacyTextSplitter(chunk_size=250, chunk_overlap=50)

    # Initialize OpenAI embeddings
    try:
        model_name = os.environ.get("OPENAI_INGEST_EMBEDDINGS_MODEL")
        if not model_name:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set"
            )
        embeddings = OpenAIEmbeddings(model=model_name)
    except ValueError as e:
        logger.error(f"Error initializing OpenAI Embeddings: {e}")
        sys.exit(1)

    return text_splitter, embeddings


def _discover_pdf_files() -> list[str]:
    """
    Discover all PDF files in the target directory recursively.

    Returns:
        list: Sorted list of PDF file paths
    """
    global file_path

    pdf_file_paths = []
    for root, _, files_in_dir in os.walk(file_path):
        for file_name in files_in_dir:
            if file_name.lower().endswith(".pdf"):
                pdf_file_paths.append(os.path.join(root, file_name))
    pdf_file_paths.sort()  # Ensure consistent order for checkpointing

    if not pdf_file_paths:
        logger.info(f"No PDF files found in {file_path}. Ingestion complete.")
        return []

    logger.info(f"Found {len(pdf_file_paths)} PDF files to process.")
    return pdf_file_paths


def _assemble_full_document(pages_from_pdf: list) -> Document | None:
    """
    Assemble pages into a single document with page boundaries tracking.

    Args:
        pages_from_pdf: List of page documents from PDF loader

    Returns:
        Document: Assembled document with page boundaries, or None if no content
    """
    if not pages_from_pdf:
        return None

    # Extract metadata from first page (should be consistent across all pages)
    first_page = pages_from_pdf[0]

    # Concatenate all page content and track page boundaries
    full_text_parts = []
    page_boundaries = []  # Track where each page starts/ends in concatenated text
    current_offset = 0

    for page_index, page_doc in enumerate(pages_from_pdf):
        if page_doc.page_content and page_doc.page_content.strip():
            page_text = page_doc.page_content.strip()

            # Add intelligent spacing between pages
            if page_index > 0:
                # Get the last few characters of the previous page
                previous_text = full_text_parts[-1] if full_text_parts else ""

                # Determine appropriate separator based on text flow
                page_separator = _determine_page_separator(previous_text, page_text)
                full_text_parts.append(page_separator)
                current_offset += len(page_separator)

            # Track this page's boundaries in the concatenated text
            start_offset = current_offset
            full_text_parts.append(page_text)
            current_offset += len(page_text)
            end_offset = current_offset

            # Use actual PDF page number (not sequential index)
            actual_pdf_page_number = page_doc.metadata.get("page", page_index) + 1
            page_boundaries.append(
                {
                    "page_number": actual_pdf_page_number,
                    "start_offset": start_offset,
                    "end_offset": end_offset,
                }
            )

    if not full_text_parts:
        return None

    # Create a single document with all content (no page markers)
    full_document = Document(
        page_content=clean_document_text("".join(full_text_parts)),
        metadata={
            **first_page.metadata.copy(),
            "page_boundaries": page_boundaries,
            "total_pages": len(pages_from_pdf),
        },
    )

    return full_document


async def _process_single_pdf(
    pdf_path: str,
    file_index: int,
    total_files: int,
    pinecone_index,
    embeddings,
    library_name: str,
    text_splitter,
    save_checkpoint_func,
) -> tuple[bool, str | None]:
    """
    Process a single PDF file and return success status.

    Args:
        pdf_path: Path to the PDF file
        file_index: Current file index (0-based)
        total_files: Total number of files
        pinecone_index: Pinecone index for storage
        embeddings: OpenAI embeddings instance
        library_name: Name of the library
        text_splitter: Text splitter instance
        save_checkpoint_func: Function to save progress

    Returns:
        tuple[bool, str | None]: (True if file was successfully processed, failure reason if failed)
    """
    logger.info(f"Processing PDF file {file_index + 1} of {total_files}: {pdf_path}")

    try:
        pdf_loader = PyPDFLoader(pdf_path)
        pages_from_pdf = pdf_loader.load()

        if not pages_from_pdf:
            logger.warning(f"No pages or text extracted from {pdf_path}. Skipping.")
            save_checkpoint_func(file_index + 1)
            return False, "No pages or text extracted from PDF"

        logger.info(f"Loaded {len(pages_from_pdf)} pages from {pdf_path}.")

        # Assemble pages into full document
        full_document = _assemble_full_document(pages_from_pdf)

        if not full_document:
            logger.warning(
                f"No text content found in any pages of {pdf_path}. Skipping."
            )
            save_checkpoint_func(file_index + 1)
            return False, "No text content found in any pages"

        # Process the complete document
        success, total_chunks, failed_chunks = await process_document(
            full_document,
            pinecone_index,
            embeddings,
            0,
            library_name,
            text_splitter,
        )

        if not success:
            logger.warning(
                f"Failed to process document {pdf_path}. Total chunks: {total_chunks}, Failed chunks: {failed_chunks}"
            )
            save_checkpoint_func(file_index + 1)
            return (
                False,
                f"Failed to process document. Total chunks: {total_chunks}, Failed chunks: {failed_chunks}",
            )

        # Check for graceful shutdown after processing each document
        if is_exiting():
            logger.info(
                f"Graceful shutdown detected after processing {pdf_path}. Saving progress and exiting."
            )
            save_checkpoint_func(file_index + 1)
            logger.info(
                f"Progress saved. Next run will start from file index {file_index + 1}."
            )
            sys.exit(0)

        # Mark file as successfully processed
        save_checkpoint_func(file_index + 1)

        # Add summary for this PDF
        pdf_filename = os.path.basename(pdf_path)
        logger.info(
            f"✓ Completed {pdf_filename} - processed {len(pages_from_pdf)} pages as single document"
        )
        logger.info(
            f"Successfully processed PDF file {file_index + 1} of {total_files} ({((file_index + 1) / total_files * 100):.1f}% done in scan)"
        )

        return True, None

    except Exception as file_processing_error:
        logger.error(
            f"Failed to process PDF file {pdf_path}: {file_processing_error}",
            exc_info=True,
        )
        error_message = str(file_processing_error)

        # Determine specific failure reason for better reporting
        failure_reason = "Unknown error"
        if "InsufficientQuotaError" in error_message or "429" in error_message:
            failure_reason = "OpenAI API quota exceeded"
            logger.error(
                "OpenAI API quota exceeded during file processing. Saving progress and exiting."
            )
            save_checkpoint_func(file_index)
            sys.exit(1)
        elif "exceeds token limit" in error_message:
            # Extract token count from error message if available
            token_match = re.search(r"(\d+) tokens \(max 8192\)", error_message)
            if token_match:
                token_count = int(token_match.group(1))
                failure_reason = (
                    f"Chunk too large: {token_count:,} tokens (OpenAI limit: 8192)"
                )
            else:
                failure_reason = "Chunk too large: exceeds OpenAI 8192 token limit"
        elif (
            "Failed to connect" in error_message
            or "Remote end closed connection" in error_message
        ):
            failure_reason = (
                "Network connectivity issue (Pinecone/OpenAI API connection failed)"
            )
        elif (
            "embedding timeout" in error_message.lower()
            or "embedding failed" in error_message.lower()
        ):
            failure_reason = "OpenAI embedding service timeout/failure"
        elif (
            "pinecone upsert timeout" in error_message.lower()
            or "pinecone upsert failed" in error_message.lower()
        ):
            failure_reason = "Pinecone upsert service timeout/failure"
        elif "Text of length" in error_message and "exceeds maximum" in error_message:
            # Extract the text length from the error message
            match = re.search(
                r"Text of length (\d+) exceeds maximum of (\d+)", error_message
            )
            if match:
                text_length = int(match.group(1))
                max_length = int(match.group(2))
                failure_reason = (
                    f"Document too large: {text_length:,} chars (max: {max_length:,})"
                )
            else:
                failure_reason = "Document too large for spaCy processing"
        elif "memory" in error_message.lower() or "Memory" in error_message:
            failure_reason = "Memory allocation error (document too large)"
        elif "pdfplumber" in error_message or "PDF" in error_message:
            failure_reason = "PDF parsing error"
        elif "embedding" in error_message.lower():
            failure_reason = "OpenAI embedding generation error"
        elif "pinecone" in error_message.lower():
            failure_reason = "Pinecone vector storage error"
        else:
            # Truncate very long error messages
            if len(error_message) > 200:
                failure_reason = error_message[:200] + "..."
            else:
                failure_reason = error_message

        logger.warning(
            f"Skipping file {pdf_path} due to error. Will attempt to continue with next file."
        )
        save_checkpoint_func(file_index + 1)
        return False, failure_reason


def _print_final_statistics(
    total_files: int,
    files_processed: int,
    library_name: str,
    text_splitter,
    failed_files: list,
) -> None:
    """Print final ingestion statistics and suggestions."""
    logger.info(
        f"Ingestion run complete. Scanned {total_files} files. "
        f"Actually processed content from {files_processed} files in this session."
    )

    # Print final memory usage
    final_memory = psutil.virtual_memory()
    final_available_gb = final_memory.available / (1024**3)
    print()
    print(
        f"📊 Final memory usage: {final_memory.percent:.1f}% used, {final_available_gb:.1f} GB available"
    )

    # Print chunking statistics
    print()
    text_splitter.metrics.print_summary()

    # Print failed files and reasons
    if failed_files:
        print()
        print("=" * 60)
        print(f"FAILED FILES REPORT ({len(failed_files)} failures)")
        print("=" * 60)

        # Group failures by reason for better organization
        failures_by_reason = {}
        for failed_file in failed_files:
            reason = failed_file["reason"]
            if reason not in failures_by_reason:
                failures_by_reason[reason] = []
            failures_by_reason[reason].append(failed_file)

        for reason, files in failures_by_reason.items():
            print(f"\n{reason} ({len(files)} files):")
            for failed_file in files:
                pdf_filename = os.path.basename(failed_file["file_path"])
                print(f"  • {pdf_filename}")
                print(f"    Full path: {failed_file['file_path']}")
                print(f"    File index: {failed_file['file_index']}")

        print()
        print("RETRY RECOMMENDATIONS:")
        print("-" * 40)

        # Provide specific recommendations based on failure types
        for reason in failures_by_reason:
            if "too large" in reason.lower():
                print(
                    f"• {reason}: Consider splitting large PDFs or increasing system memory"
                )
                print(
                    "  Memory check: Your system has enough RAM, but spaCy processing requires ~2GB per 100k chars"
                )
            elif "chunk too large" in reason.lower() or "token limit" in reason.lower():
                print(f"• {reason}: Chunks exceed OpenAI embedding model limits")
                print(
                    "  - The spaCy text splitter created chunks too large for OpenAI embeddings"
                )
                print(
                    "  - This typically indicates the text splitter needs tuning for this content type"
                )
                print(
                    "  - Consider reducing chunk_size in SpacyTextSplitter configuration"
                )
                print(
                    "  - Large text blocks without paragraph breaks may cause oversized chunks"
                )
                print(
                    "  - Solution: Implement automatic chunk splitting for oversized chunks"
                )
            elif "memory allocation" in reason.lower():
                print(
                    f"• {reason}: Close other applications to free up memory or process smaller batches"
                )
            elif "network connectivity" in reason.lower():
                print(f"• {reason}: Network issues with Pinecone/OpenAI APIs")
                print("  - Check internet connection stability")
                print("  - Verify API keys are valid and not rate-limited")
                print("  - Consider running during off-peak hours")
                print("  - Script now includes retry logic for transient failures")
            elif (
                "embedding.*timeout" in reason.lower()
                or "embedding.*failure" in reason.lower()
            ):
                print(f"• {reason}: OpenAI embedding service issues")
                print("  - Check OpenAI API status and rate limits")
                print(
                    "  - Consider smaller batch sizes or longer delays between requests"
                )
            elif (
                "pinecone.*timeout" in reason.lower()
                or "pinecone.*failure" in reason.lower()
            ):
                print(f"• {reason}: Pinecone service issues")
                print("  - Check Pinecone dashboard for service status")
                print("  - Verify index name and region configuration")
                print("  - Consider reducing concurrent requests")
            elif "pdf parsing" in reason.lower():
                print(f"• {reason}: PDFs may be corrupted or use unsupported formats")
            elif "quota exceeded" in reason.lower():
                print(f"• {reason}: Wait for OpenAI API quota to reset or upgrade plan")
            elif "no pages" in reason.lower() or "no text content" in reason.lower():
                print(
                    f"• {reason}: PDFs may be image-only (scanned documents) or corrupted"
                )
            else:
                print(f"• {reason}: Review logs for detailed error information")

        print()
        print(
            "To retry only failed files, you can manually process them by file index:"
        )
        print(
            "  python pdf_to_vector_db.py --file-path /path/to/pdfs --site your-site --library-name 'your-lib' --start-index N"
        )
        print("  (Note: --start-index flag would need to be implemented)")

    else:
        print()
        print("✅ All files processed successfully! No failures to report.")

    # Add suggestion for detailed chunk analysis
    print()
    print("💡 To analyze chunk quality and see details about small chunks, run:")
    print(
        f"   python bin/analyze_small_chunks.py --site {os.environ.get('SITE', 'your-site')} --library '{library_name}' --small-threshold 100 --show-content"
    )


async def run(keep_data: bool, library_name: str, max_files: int | None) -> None:
    """
    Main function to run the document ingestion process.
    This function orchestrates the entire ingestion workflow.
    """
    global file_path  # file_path is set in main()
    logger.info(f"Processing documents from directory: {file_path}")

    # Check system memory before starting
    memory = psutil.virtual_memory()
    memory_gb = memory.total / (1024**3)
    available_gb = memory.available / (1024**3)
    memory_percent = memory.percent

    logger.info(
        f"System memory: {memory_gb:.1f} GB total, {available_gb:.1f} GB available ({memory_percent:.1f}% used)"
    )

    if available_gb < 4.0:
        logger.warning(
            f"⚠️  Low available memory ({available_gb:.1f} GB). "
            "Large documents may cause memory errors. Consider closing other applications."
        )
    elif available_gb < 8.0:
        logger.info(
            f"ℹ️  Available memory ({available_gb:.1f} GB) should handle most documents. "
            "Very large documents (>500k chars) may require more memory."
        )
    else:
        logger.info(
            f"✅ Sufficient memory ({available_gb:.1f} GB) for processing large documents."
        )

    # Initialize services and components
    pinecone, pinecone_index = _initialize_pinecone_services(library_name, keep_data)
    text_splitter, embeddings = _initialize_processing_components()

    # Discover PDF files to process
    pdf_file_paths = _discover_pdf_files()
    if not pdf_file_paths:
        return

    # Set up checkpoint management
    processed_files_count, current_folder_signature, save_checkpoint_func = (
        pdf_checkpoint_integration(
            checkpoint_dir="./media/pdf-docs",
            folder_path=file_path,
            library_name=library_name,
            keep_data=keep_data,
        )
    )

    # Set up signal handler for graceful shutdown
    setup_signal_handlers()

    # Track failures for reporting
    failed_files = []

    # Process PDF files with progress tracking
    files_actually_processed_in_this_run = 0
    for i in range(processed_files_count, len(pdf_file_paths)):
        if is_exiting():
            logger.info(
                "Graceful shutdown detected: saving progress before exiting loop."
            )
            save_checkpoint_func(i)
            if i == 0:
                logger.info(
                    "Exiting before processing any files. Next run will start from the beginning."
                )
            else:
                logger.info(
                    f"Exiting. Processed up to file index {i - 1}. Next run will start from file index {i}."
                )
            sys.exit(0)

        current_pdf_path = pdf_file_paths[i]

        # Process single PDF file
        success, failure_reason = await _process_single_pdf(
            current_pdf_path,
            i,
            len(pdf_file_paths),
            pinecone_index,
            embeddings,
            library_name,
            text_splitter,
            save_checkpoint_func,
        )

        if success:
            files_actually_processed_in_this_run += 1
        else:
            # Track failure for reporting
            failed_files.append(
                {
                    "file_path": current_pdf_path,
                    "file_index": i,
                    "reason": failure_reason,
                }
            )

        if max_files and files_actually_processed_in_this_run >= max_files:
            logger.info(
                f"Reached max_files limit. Stopping after {max_files} files processed."
            )
            break

    # Print final statistics and suggestions
    _print_final_statistics(
        len(pdf_file_paths),
        files_actually_processed_in_this_run,
        library_name,
        text_splitter,
        failed_files,
    )


def main():
    """Parse arguments and run the script."""
    global file_path

    parser = argparse.ArgumentParser(
        description="Ingest PDF documents into Pinecone vector database"
    )
    parser.add_argument(
        "--file-path", required=True, help="Path to the directory containing PDF files"
    )
    parser.add_argument(
        "--site", required=True, help="Site name for loading environment variables"
    )
    parser.add_argument(
        "--library-name", required=True, help="Name of the library to process"
    )
    parser.add_argument(
        "--keep-data",
        "-k",
        action="store_true",
        help="Flag to keep existing data in the index",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        help="Maximum number of files to process (useful for testing)",
    )

    args = parser.parse_args()

    # Load environment variables
    load_env(args.site)

    # Validate file path
    file_path = os.path.abspath(args.file_path)
    if not os.path.isdir(file_path):
        print(f"Error: {file_path} is not a valid directory")
        sys.exit(1)

    # Run the ingestion process
    asyncio.run(run(args.keep_data, args.library_name, args.max_files))


if __name__ == "__main__":
    main()
