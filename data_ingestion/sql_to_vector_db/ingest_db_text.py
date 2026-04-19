#!/usr/bin/env python
"""
Ingests text content directly from a WordPress MySQL database into a Pinecone vector index.

This script connects to a specified MySQL database, fetches published posts/pages
based on site-specific configurations (post types, taxonomies), cleans the HTML content,
calculates metadata (like author, permalink, categories), splits the text into chunks,
generates embeddings using OpenAI, and upserts the resulting vectors into a specified
Pinecone index. It includes features for checkpointing to resume interrupted ingestions
and options to clear existing data for a specific library before starting.

Configuration:
    The script supports optional content exclusion rules via an S3-hosted JSON configuration
    file located at: s3://{S3_BUCKET_NAME}/site-config/data_ingestion/sql_to_vector_db/exclusion_rules.json

    This configuration file can contain site-specific exclusion rules in the following format:
    {
      "site_name": {
        "exclude_categories": ["category1", "category2"],
        "exclude_combinations": [
          {"category": "Letters", "author": "Author Name"}
        ],
        "exclude_post_hierarchies": [
          {"parent_id": 1234, "description": "Optional description"}
        ],
        "exclude_specific_posts": [
          {"post_id": 5678, "description": "Optional description"}
        ]
      }
    }

Command Line Arguments:
    --site: Required. Site name (e.g., ananda, jairam) for config and env loading.
    --database: Required. Name of the MySQL database to connect to.
    --library-name: Required. Name of the library for Pinecone metadata.
    --keep-data: Optional. Keep existing data in Pinecone (resume from checkpoint).
    --batch-size: Optional. Number of documents to process in parallel for embeddings/upserts (default: 50).
    --max-records: Optional. Maximum number of records to process (useful for testing or incremental processing).
    --dry-run: Optional. Perform all steps except Pinecone index creation, deletion, and upsertion.
    --no-pinecone: Optional. Skip Pinecone operations but still generate and upload PDFs to S3.
    --overwrite-pdfs: Optional. Force regeneration and upload of PDFs even if they already exist in S3.
    --no-pdf-uploads: Optional. Disable PDF generation and S3 uploads.
    --debug-pdfs: Optional. Enable debug mode for PDF generation.

Example Usage:
    python ingest_db_text.py --site ananda --database wp_ananda --library-name "Ananda Library" --keep-data
    python ingest_db_text.py --site ananda --database wp_ananda --library-name "Ananda Library" --max-records 100 --dry-run
    python ingest_db_text.py --site ananda --database wp_ananda --library-name "Ananda Library" --no-pinecone
    python ingest_db_text.py --site ananda --database wp_ananda --library-name "Ananda Library" --no-pinecone --overwrite-pdfs
    python ingest_db_text.py --site ananda --database wp_ananda --library-name "Ananda Library" --no-pdf-uploads
"""

import argparse
import hashlib
import json
import logging
import math
import os
import re
import secrets
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime
from io import BytesIO

import pymysql
from bs4 import BeautifulSoup
from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings
from pinecone import NotFoundException, Pinecone, ServerlessSpec
from reportlab.lib.pagesizes import letter
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

from data_ingestion.utils.pinecone_utils import generate_vector_id
from data_ingestion.utils.progress_utils import (
    ProgressConfig,
    ProgressTracker,
    is_exiting,
    setup_signal_handlers,
)
from data_ingestion.utils.s3_utils import (
    get_bucket_name,
    get_s3_client,
)
from data_ingestion.utils.text_processing import remove_html_tags, replace_smart_quotes
from data_ingestion.utils.text_splitter_utils import SpacyTextSplitter
from pyutil.env_utils import load_env
from pyutil.logging_utils import configure_logging

# Configure logging
configure_logging(debug=True)
logger = logging.getLogger(__name__)

# Constants
DEFAULT_BATCH_SIZE = (
    10  # Number of documents to process in parallel for embeddings/upserting
)


# --- Failure Tracking System ---
class DocumentFailure:
    """Represents a document processing failure with detailed error information."""

    def __init__(
        self,
        document_id: int,
        title: str,
        error_type: str,
        error_message: str,
        traceback_info: str = None,
        stage: str = None,
    ):
        self.document_id = document_id
        self.title = title
        self.error_type = error_type
        self.error_message = error_message
        self.traceback_info = traceback_info
        self.stage = stage  # e.g., "chunking", "embedding", "pdf_generation", "upsert"
        self.timestamp = datetime.now().isoformat()

    def __str__(self):
        stage_info = f" [{self.stage}]" if self.stage else ""
        return f"Doc {self.document_id}: {self.title[:50]}...{stage_info} - {self.error_type}: {self.error_message}"


class FailureTracker:
    """Tracks and reports document processing failures."""

    def __init__(self):
        self.failures: list[DocumentFailure] = []
        self.failure_counts_by_type: dict[str, int] = defaultdict(int)
        self.failure_counts_by_stage: dict[str, int] = defaultdict(int)

    def add_failure(
        self,
        document_id: int,
        title: str,
        error: Exception,
        stage: str = None,
        include_traceback: bool = True,
    ):
        """Add a document failure to the tracker."""
        error_type = type(error).__name__
        error_message = str(error)
        traceback_info = traceback.format_exc() if include_traceback else None

        failure = DocumentFailure(
            document_id=document_id,
            title=title,
            error_type=error_type,
            error_message=error_message,
            traceback_info=traceback_info,
            stage=stage,
        )

        self.failures.append(failure)
        self.failure_counts_by_type[error_type] += 1
        if stage:
            self.failure_counts_by_stage[stage] += 1

        logger.error(f"Document failure recorded: {failure}")

    def get_failure_count(self) -> int:
        """Get total number of failures."""
        return len(self.failures)

    def get_failures_by_type(self) -> dict[str, list[DocumentFailure]]:
        """Group failures by error type."""
        failures_by_type = defaultdict(list)
        for failure in self.failures:
            failures_by_type[failure.error_type].append(failure)
        return dict(failures_by_type)

    def print_summary(self):
        """Print a comprehensive failure summary."""
        if not self.failures:
            logger.info("✅ No document processing failures occurred")
            return

        logger.error(
            f"\n❌ Document Processing Failures Summary ({len(self.failures)} total failures)"
        )
        logger.error("=" * 80)

        # Summary by error type
        logger.error("\n📊 Failures by Error Type:")
        for error_type, count in sorted(
            self.failure_counts_by_type.items(), key=lambda x: x[1], reverse=True
        ):
            logger.error(f"  {error_type}: {count} documents")

        # Summary by stage
        if any(self.failure_counts_by_stage.values()):
            logger.error("\n🔄 Failures by Processing Stage:")
            for stage, count in sorted(
                self.failure_counts_by_stage.items(), key=lambda x: x[1], reverse=True
            ):
                logger.error(f"  {stage}: {count} documents")

        # Detailed failure list (first 100 failures)
        logger.error("\n📋 Detailed Failure List (first 100):")
        for i, failure in enumerate(self.failures[:100]):
            logger.error(f"  {i + 1}. {failure}")

        if len(self.failures) > 100:
            logger.error(f"  ... and {len(self.failures) - 100} more failures")

        # Most common error details
        failures_by_type = self.get_failures_by_type()
        most_common_type = max(self.failure_counts_by_type.items(), key=lambda x: x[1])[
            0
        ]
        logger.error(f"\n🔍 Most Common Error Type: {most_common_type}")

        # Show first few instances of most common error
        common_failures = failures_by_type[most_common_type][:3]
        for failure in common_failures:
            logger.error(
                f"  Example: Doc {failure.document_id} - {failure.error_message}"
            )


# Global failure tracker instance
failure_tracker = FailureTracker()

# --- Helper Functions ---

# Directory to store checkpoint files
CHECKPOINT_DIR = os.path.join(os.path.dirname(__file__), "ingestion_checkpoints")

# Template for naming checkpoint files, specific to each site
CHECKPOINT_FILE_TEMPLATE = os.path.join(
    CHECKPOINT_DIR, "db_text_ingestion_checkpoint_{site}.json"
)

# S3 location for exclusion rules
EXCLUSION_RULES_S3_PATH = (
    "site-config/data_ingestion/sql_to_vector_db/exclusion_rules.json"
)


# --- Exclusion Rules Functions ---
def download_exclusion_rules_from_s3(site: str) -> dict:
    """Download exclusion rules from S3 for the specified site."""
    try:
        s3_client = get_s3_client()
        bucket_name = get_bucket_name()

        logger.info(
            f"🔍 Downloading exclusion rules from S3: s3://{bucket_name}/{EXCLUSION_RULES_S3_PATH}"
        )

        response = s3_client.get_object(Bucket=bucket_name, Key=EXCLUSION_RULES_S3_PATH)
        rules_data = json.loads(response["Body"].read().decode("utf-8"))

        if site not in rules_data:
            logger.warning(
                f"⚠️  No exclusion rules found for site '{site}' in S3 config"
            )
            return {}

        site_rules = rules_data[site]

        # Convert the user-friendly format to internal format
        converted_rules = []
        total_rule_count = 0

        # Process exclude_categories
        if "exclude_categories" in site_rules:
            for category in site_rules["exclude_categories"]:
                converted_rules.append(
                    {
                        "name": f"Exclude category '{category}'",
                        "type": "category",
                        "category": category,
                    }
                )
                total_rule_count += 1

        # Process exclude_combinations
        if "exclude_combinations" in site_rules:
            for combo in site_rules["exclude_combinations"]:
                converted_rules.append(
                    {
                        "name": f"Exclude category '{combo['category']}' + author '{combo['author']}'",
                        "type": "category_author_combination",
                        "category": combo["category"],
                        "author": combo["author"],
                    }
                )
                total_rule_count += 1

        # Process exclude_post_hierarchies
        if "exclude_post_hierarchies" in site_rules:
            for hierarchy in site_rules["exclude_post_hierarchies"]:
                converted_rules.append(
                    {
                        "name": f"Exclude hierarchy under post {hierarchy['parent_id']}",
                        "type": "post_hierarchy",
                        "parent_post_id": hierarchy["parent_id"],
                        "description": hierarchy.get("description", ""),
                    }
                )
                total_rule_count += 1

        # Process exclude_specific_posts
        if "exclude_specific_posts" in site_rules:
            for post in site_rules["exclude_specific_posts"]:
                converted_rules.append(
                    {
                        "name": f"Exclude specific post {post['post_id']}",
                        "type": "specific_post_ids",
                        "post_ids": [post["post_id"]],
                        "description": post.get("description", ""),
                    }
                )
                total_rule_count += 1

        logger.info(
            f"✅ Successfully loaded {total_rule_count} exclusion rules for site '{site}'"
        )

        # Debug: Print rule summary
        for rule in converted_rules:
            logger.info(f"   📋 Rule: {rule['name']} ({rule['type']})")

        return {"rules": converted_rules}

    except Exception as e:
        logger.error(f"❌ Failed to download exclusion rules from S3: {e}")
        logger.warning(
            "⚠️  Proceeding without exclusion rules - all content will be ingested"
        )
        return {}


def _extract_post_categories(row: dict) -> list[str]:
    """Extracts and processes categories from post row data."""
    categories = []
    if row.get("categories"):
        categories = [
            cat.strip() for cat in row["categories"].split("|||") if cat.strip()
        ]
    return categories


def _extract_post_authors(row: dict) -> list[str]:
    """Extracts and processes authors from post row data."""
    authors = []
    if row.get("authors_list"):
        authors = [
            auth.strip() for auth in row["authors_list"].split("|||") if auth.strip()
        ]
    return authors


def _check_category_rule(rule: dict, categories: list[str]) -> tuple[bool, str]:
    """Checks if a post should be excluded based on category rule."""
    if rule["category"] in categories:
        return True, f"Rule '{rule['name']}': Has category '{rule['category']}'"
    return False, ""


def _check_category_author_rule(
    rule: dict, categories: list[str], authors: list[str]
) -> tuple[bool, str]:
    """Checks if a post should be excluded based on category+author combination rule."""
    if rule["category"] in categories and rule["author"] in authors:
        return (
            True,
            f"Rule '{rule['name']}': Has category '{rule['category']}' AND author '{rule['author']}'",
        )
    return False, ""


def _check_post_hierarchy_rule(rule: dict, post_id: int, row: dict) -> tuple[bool, str]:
    """Checks if a post should be excluded based on post hierarchy rule."""
    parent_id = rule["parent_post_id"]
    if post_id == parent_id:
        if rule.get("include_parent", True):
            return True, f"Rule '{rule['name']}': Is parent post (ID: {parent_id})"
    elif row.get("post_parent") == parent_id:
        return (
            True,
            f"Rule '{rule['name']}': Is child of parent post (ID: {parent_id})",
        )
    return False, ""


def _check_specific_post_rule(rule: dict, post_id: int) -> tuple[bool, str]:
    """Checks if a post should be excluded based on specific post ID rule."""
    if post_id in rule["post_ids"]:
        return True, f"Rule '{rule['name']}': Specific post ID ({post_id})"
    return False, ""


def should_exclude_post(row: dict, exclusion_rules: dict) -> tuple[bool, str]:
    """
    Check if a post should be excluded based on exclusion rules.

    Returns:
        tuple: (should_exclude: bool, reason: str)
    """
    if not exclusion_rules or "rules" not in exclusion_rules:
        return False, ""

    post_id = row["ID"]
    categories = _extract_post_categories(row)
    authors = _extract_post_authors(row)

    for rule in exclusion_rules["rules"]:
        rule_type = rule["type"]

        if rule_type == "category":
            should_exclude, reason = _check_category_rule(rule, categories)
            if should_exclude:
                return True, reason

        elif rule_type == "category_author_combination":
            should_exclude, reason = _check_category_author_rule(
                rule, categories, authors
            )
            if should_exclude:
                return True, reason

        elif rule_type == "post_hierarchy":
            should_exclude, reason = _check_post_hierarchy_rule(rule, post_id, row)
            if should_exclude:
                return True, reason

        elif rule_type == "specific_post_ids":
            should_exclude, reason = _check_specific_post_rule(rule, post_id)
            if should_exclude:
                return True, reason

    return False, ""


# --- PDF Generation Functions ---
MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024  # 200 MB limit


def generate_document_hash(
    title: str, content: str, author: str, permalink: str
) -> str:
    """Generate a consistent hash for a document based on its core content."""
    # Create a string that uniquely identifies this document
    unique_string = f"{title}|{author}|{permalink}|{content[:1000]}"  # Use first 1000 chars for consistency
    return hashlib.sha256(unique_string.encode("utf-8")).hexdigest()[
        :16
    ]  # 16 character hash


def _process_content_for_pdf(content: str, debug_mode: bool = False) -> str:
    """
    Process content for PDF generation by converting HTML paragraphs to newlines and cleaning HTML.

    Converts HTML paragraph tags to double newlines while preserving inline formatting tags.
    This ensures proper paragraph splitting while maintaining emphasis tags for PDFs.

    Args:
        content: Raw content string
        debug_mode: Whether to log debug information

    Returns:
        str: Processed content suitable for PDF generation
    """
    import re

    # STEP 0: Normalize line endings - convert Windows (\r\n) and Mac (\r) to Unix (\n)
    # This is critical for MySQL content which often uses \r\n line endings
    content = content.replace("\r\n", "\n").replace("\r", "\n")

    # STEP 1: Convert paragraph tags to double newlines using regex
    # This approach is more reliable than BeautifulSoup tree manipulation
    # Replace opening <p> tags with double newline prefix
    content = re.sub(r"<p[^>]*>", "\n\n", content)
    # Replace closing </p> tags with double newline suffix
    content = re.sub(r"</p>", "\n\n", content)

    # Parse HTML content for attribute cleaning
    soup = BeautifulSoup(content, "html.parser")

    # STEP 2: Remove problematic tags that cause ReportLab paraparser failures
    # Remove <img> tags entirely - they cause paraparser errors and aren't needed for text PDFs
    for img_tag in soup.find_all("img"):
        img_tag.decompose()  # Completely remove the tag and its contents

    # STEP 3: Remove only problematic attributes that cause ReportLab issues
    # Keep all remaining tags (like <em>, <strong>) but clean attributes that might cause parsing errors
    for tag in soup.find_all():
        # Remove problematic attributes that ReportLab's paraparser rejects
        attrs_to_remove = []
        for attr in tag.attrs:
            if (
                attr
                in [
                    "id",
                    "class",
                    "style",
                    "href",
                    "onclick",
                    "onload",
                    "name",
                    "rel",
                    "target",
                    "alt",
                    "height",
                    "width",
                    "src",  # Add specific problematic attributes
                    "title",
                    "lang",
                    "dir",
                    "tabindex",
                    "accesskey",
                    "contenteditable",
                    "draggable",
                    "hidden",
                    "spellcheck",
                    "translate",
                ]
                or attr.startswith("data-")
                or attr.startswith("on")
                or attr.startswith(
                    "aria-"
                )  # Remove ARIA attributes that can cause issues
            ):
                attrs_to_remove.append(attr)

        for attr in attrs_to_remove:
            del tag.attrs[attr]

    # Convert back to string, preserving remaining HTML structure (emphasis, etc.)
    cleaned_content = str(soup)

    # STEP 4: Clean up excessive newlines that may have been created
    # Normalize multiple newlines to double newlines (paragraph breaks)
    cleaned_content = re.sub(r"\n{3,}", "\n\n", cleaned_content)

    # Remove leading/trailing whitespace
    cleaned_content = cleaned_content.strip()

    if debug_mode:
        logger.info(
            f"DEBUG: HTML processing - Original length: {len(content)}, Processed length: {len(cleaned_content)}"
        )
        logger.info(
            "DEBUG: HTML paragraph tags converted to newlines, attributes cleaned"
        )
        # Show first 300 chars to see paragraph structure
        logger.info(
            f"DEBUG: First 300 chars after processing: '{cleaned_content[:300]}...'"
        )

    return cleaned_content


def _split_into_paragraphs(content: str) -> list[str]:
    """
    Intelligently split content into paragraphs using multiple strategies.

    Args:
        content: Processed content string

    Returns:
        list[str]: List of paragraph strings
    """

    # Split on double newlines - this is the standard WordPress paragraph separator
    paragraphs = content.split("\n\n")

    # Note: Do NOT split on single newlines - WordPress treats those as spaces within paragraphs

    # Strategy 3: If paragraphs are too long (>500 words), try to split them further
    final_paragraphs = []
    for para in paragraphs:
        if len(para.split()) > 500:  # If paragraph is very long
            # Try to split on sentence boundaries with double spaces
            sentences = re.split(r"\.  +", para)
            if len(sentences) > 1:
                # Group sentences into smaller paragraphs
                current_para = ""
                for sentence in sentences:
                    if sentence.strip():
                        sentence = sentence.strip()
                        if not sentence.endswith("."):
                            sentence += "."

                        if len((current_para + " " + sentence).split()) <= 250:
                            current_para = (current_para + " " + sentence).strip()
                        else:
                            if current_para:
                                final_paragraphs.append(current_para)
                            current_para = sentence

                if current_para:
                    final_paragraphs.append(current_para)
            else:
                final_paragraphs.append(para)
        else:
            final_paragraphs.append(para)

    return [p.strip() for p in final_paragraphs if p.strip()]


def _clean_paragraph_for_pdf(paragraph: str) -> str:
    """
    Clean and format a paragraph for PDF display.

    Args:
        paragraph: Raw paragraph text

    Returns:
        str: Cleaned paragraph text
    """

    # Strip whitespace
    clean = paragraph.strip()

    if not clean:
        return ""

    # IMPORTANT: Replace ALL single newlines and carriage returns with spaces within a paragraph
    # This matches WordPress behavior where line breaks within paragraphs are treated as spaces
    clean = re.sub(r"[\r\n]", " ", clean)

    # Clean up multiple spaces
    clean = re.sub(r" {2,}", " ", clean)

    # Don't add periods automatically - this was causing the issue with "Abell,." etc
    clean = clean.strip()

    return clean


def create_pdf_from_content(
    title: str,
    content: str,
    author: str,
    categories: list,
    permalink: str,
    debug_mode: bool = False,
) -> bytes:
    """
    Generate a simple PDF from text content using ReportLab.

    Args:
        title: Document title
        content: Main content text
        author: Document author
        categories: List of categories
        permalink: Source URL

    Returns:
        bytes: PDF content as bytes

    Raises:
        Exception: If PDF generation fails or exceeds size limit
    """
    buffer = BytesIO()

    try:
        # Configure PDF encryption to disable text copying while allowing viewing
        # Use an empty user password for seamless opening, with a strong owner password

        owner_password = os.getenv("PDF_OWNER_PASSWORD") or secrets.token_urlsafe(24)
        encryption = StandardEncryption(
            userPassword="",
            ownerPassword=owner_password,
            canPrint=1,
            canModify=0,
            canCopy=0,  # Disable text copying
            canAnnotate=1,
            strength=128,
        )
        # Create PDF document
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=18,
            encrypt=encryption,
        )

        # Get styles
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            "CustomTitle",
            parent=styles["Heading1"],
            fontSize=18,
            spaceAfter=12,
            textColor="black",
        )
        author_style = ParagraphStyle(
            "CustomAuthor",
            parent=styles["Normal"],
            fontSize=12,
            spaceAfter=6,
            textColor="gray",
        )
        body_style = ParagraphStyle(
            "CustomBody",
            parent=styles["Normal"],
            fontSize=11,
            spaceAfter=12,
            alignment=0,  # Left alignment
        )

        # Build story (content elements)
        story = []

        # Add title
        story.append(Paragraph(title, title_style))
        story.append(Spacer(1, 12))

        # Add author
        if author:
            story.append(Paragraph(f"Author: {author}", author_style))
            story.append(Spacer(1, 6))

        # Add categories
        if categories:
            categories_text = f"Categories: {', '.join(categories)}"
            story.append(Paragraph(categories_text, author_style))
            story.append(Spacer(1, 6))

        # Add source URL
        story.append(Paragraph(f"Source: {permalink}", author_style))
        story.append(Spacer(1, 12))

        # Add horizontal line
        story.append(Spacer(1, 6))

        # Process content for better paragraph formatting
        processed_content = _process_content_for_pdf(content, debug_mode)

        # DEBUG: Log processed content analysis (only in debug mode)
        if debug_mode:
            logger.info(f"DEBUG: Original content length: {len(content)} chars")
            logger.info(
                f"DEBUG: First 200 chars of processed content: '{processed_content[:200]}...'"
            )
            logger.info(
                f"DEBUG: Processed content length: {len(processed_content)} chars"
            )
            logger.info(
                f"DEBUG: First 200 chars of processed content: '{processed_content[:200]}...'"
            )

        # Split into paragraphs using multiple possible separators
        content_paragraphs = _split_into_paragraphs(processed_content)

        # DEBUG: Log paragraph analysis (only in debug mode)
        if debug_mode:
            logger.info(
                f"DEBUG: Found {len(content_paragraphs)} paragraphs after intelligent splitting"
            )
            non_empty_paragraphs = [p for p in content_paragraphs if p.strip()]
            logger.info(f"DEBUG: {len(non_empty_paragraphs)} non-empty paragraphs")

            # Show first few paragraphs for analysis
            for i, para in enumerate(content_paragraphs[:3]):
                logger.info(
                    f"DEBUG: Paragraph {i + 1} (length {len(para)}): '{para[:150]}...'"
                )

        for i, paragraph in enumerate(content_paragraphs):
            if paragraph.strip():
                # Clean up the paragraph text while preserving structure
                clean_paragraph = _clean_paragraph_for_pdf(paragraph)
                if clean_paragraph:  # Only add non-empty paragraphs
                    story.append(Paragraph(clean_paragraph, body_style))

                    # Add appropriate spacing between paragraphs
                    story.append(Spacer(1, 6))

                    # DEBUG: Log paragraph processing (only in debug mode)
                    if (
                        debug_mode and i < 5
                    ):  # Only log first 5 paragraphs to avoid spam
                        logger.info(
                            f"DEBUG: Added paragraph {i + 1}, length: {len(clean_paragraph)} chars"
                        )

        # Build PDF
        doc.build(story)

        # Get PDF bytes
        pdf_bytes = buffer.getvalue()

        # Check size limit
        if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
            raise Exception(
                f"Generated PDF size ({len(pdf_bytes)} bytes) exceeds limit ({MAX_PDF_SIZE_BYTES} bytes)"
            )

        return pdf_bytes

    except Exception as e:
        logger.error(f"Error generating PDF: {e}")
        raise
    finally:
        buffer.close()


def generate_and_upload_pdf(
    post_data: dict,
    site: str,
    library_name: str,
    no_pdf_uploads: bool = False,
    debug_pdfs: bool = False,
    overwrite_pdfs: bool = False,
) -> str | None:
    """
    Generate PDF from post content and upload to S3.

    Args:
        post_data: Dictionary containing post information
        site: Site name for S3 prefix
        library_name: Library name for S3 path
        no_pdf_uploads: If True, skip PDF generation and upload
        debug_pdfs: If True, save PDFs locally for debugging
        overwrite_pdfs: If True, force upload even if PDF already exists in S3

    Returns:
        str | None: S3 key or local path if successful, None if skipped

    Raises:
        Exception: If PDF generation or upload fails (will be tracked by caller)
    """
    if no_pdf_uploads:
        return None

    # Generate document hash
    doc_hash = generate_document_hash(
        post_data["title"],
        post_data["content"],
        post_data["author"],
        post_data["permalink"],
    )

    # Generate PDF content
    pdf_bytes = create_pdf_from_content(
        post_data["title"],
        post_data["content"],
        post_data["author"],
        post_data.get("categories", []),
        post_data["permalink"],
        debug_mode=debug_pdfs,
    )

    if debug_pdfs:
        # Store PDFs locally for debugging
        debug_pdf_dir = "debug_pdfs"
        os.makedirs(debug_pdf_dir, exist_ok=True)

        # Create safe filename from title (first 50 chars, replace invalid chars)
        safe_title = "".join(
            c for c in post_data["title"][:50] if c.isalnum() or c in (" ", "-", "_")
        ).strip()
        safe_title = safe_title.replace(" ", "_")
        local_pdf_path = os.path.join(debug_pdf_dir, f"{safe_title}_{doc_hash[:8]}.pdf")

        # Save PDF locally for debugging
        with open(local_pdf_path, "wb") as f:
            f.write(pdf_bytes)

        logger.info(f"DEBUG: Saved PDF locally for debugging: {local_pdf_path}")
        logger.info(f"PDF size: {len(pdf_bytes)} bytes")
        logger.info(f"Title: {post_data['title']}")
        logger.info(f"Content length: {len(post_data['content'])} characters")

        # Return the local path instead of S3 key for debugging
        return local_pdf_path
    else:
        # Normal S3 upload path
        import contextlib
        import tempfile

        from data_ingestion.utils.s3_utils import upload_to_s3

        # Create S3 key (without bucket name - that's handled by upload_to_s3)
        s3_key = f"public/pdf/{library_name}/{doc_hash}.pdf"

        # Create temporary file for upload
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_file:
            temp_file.write(pdf_bytes)
            temp_file_path = temp_file.name

        try:
            # Upload to S3 with retry logic
            uploaded = upload_to_s3(temp_file_path, s3_key, overwrite=overwrite_pdfs)
            if uploaded:
                logger.info(f"Successfully uploaded PDF to S3: {s3_key}")
            else:
                logger.info(f"PDF already exists in S3: {s3_key}")

            # Return S3 key regardless of whether file was uploaded or already existed
            return s3_key

        finally:
            # Clean up temporary file
            with contextlib.suppress(OSError):
                os.unlink(temp_file_path)


# --- Argument Parsing ---
def parse_arguments():
    """Parses command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Ingest text data directly from MySQL DB to Pinecone."
    )
    parser.add_argument(
        "--site",
        "-s",
        required=True,
        help="Site name (e.g., ananda, jairam) for config and env loading.",
    )
    parser.add_argument(
        "--database",
        "-d",
        required=True,
        help="Name of the MySQL database to connect to.",
    )
    parser.add_argument(
        "--library-name",
        "-l",
        required=True,
        help="Name of the library for Pinecone metadata.",
    )
    parser.add_argument(
        "--keep-data",
        "-k",
        action="store_true",
        help="Keep existing data in Pinecone (resume from checkpoint).",
    )
    parser.add_argument(
        "--batch-size",
        "-b",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Number of documents to process in parallel for embeddings/upserts (default: {DEFAULT_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--max-records",
        "-m",
        type=int,
        help="Maximum number of records to process (useful for testing or incremental processing).",
    )
    parser.add_argument(
        "--dry-run",
        "-n",
        action="store_true",
        help="Perform all steps except Pinecone index creation, deletion, and upsertion.",
    )
    parser.add_argument(
        "--no-pinecone",
        action="store_true",
        help="Skip Pinecone operations but still generate and upload PDFs to S3.",
    )
    parser.add_argument(
        "--overwrite-pdfs",
        action="store_true",
        help="Force regeneration and upload of PDFs even if they already exist in S3.",
    )
    parser.add_argument(
        "--no-pdf-uploads",
        "-p",
        action="store_true",
        help="Disable PDF generation and S3 uploads.",
    )
    parser.add_argument(
        "--debug-pdfs",
        action="store_true",
        help="Store PDFs locally for debugging instead of uploading to S3.",
    )
    return parser.parse_args()


# --- Environment Loading ---
def load_environment(site_name: str) -> dict:
    """
    Load environment variables for a specific site and return a dictionary of database connection details.
    Uses the load_env utility to load environment variables with the site name as a prefix.
    """
    load_env(f"{site_name.upper()}")
    logger.info(f"Loaded environment for site: {site_name} using load_env utility.")

    required_vars = [
        "DB_USER",
        "DB_PASSWORD",
        "DB_HOST",
        "PINECONE_API_KEY",
        "OPENAI_API_KEY",
        "PINECONE_INGEST_INDEX_NAME",
    ]
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    if missing_vars:
        raise SystemExit(
            f"Missing required environment variables: {', '.join(missing_vars)}"
        )

    return {
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
        "host": os.getenv("DB_HOST"),
        "raise_on_warnings": True,
    }


# --- Database Utilities ---
def get_db_config(args):
    """Constructs the database connection configuration dictionary from environment variables."""
    # Loads DB config from environment variables, similar to db_to_pdfs.py
    # Ensure DB_CHARSET and DB_COLLATION are set in your .env file if needed
    return {
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
        "host": os.getenv("DB_HOST"),
        "database": args.database,
        "charset": os.getenv("DB_CHARSET", "utf8mb4"),
        "collation": os.getenv("DB_COLLATION", "utf8mb4_unicode_ci"),
        "cursorclass": pymysql.cursors.DictCursor,  # Use DictCursor for easier row access by column name
    }


def get_db_connection(db_config):
    """Establishes and returns a database connection with retry logic."""
    # Establishes DB connection, similar to db_to_pdfs.py
    max_retries = 5
    attempt = 0
    while attempt < max_retries:
        try:
            connection = pymysql.connect(**db_config)
            logger.info("Successfully connected to the database.")
            return connection
        except pymysql.MySQLError as err:
            logger.warning(
                f"Error connecting to MySQL (Attempt {attempt + 1}/{max_retries}): {err}"
            )
            if attempt == max_retries - 1:
                logger.error("Max retries reached. Exiting.")
                sys.exit(1)
            # Exponential backoff
            time.sleep(2**attempt)
            attempt += 1
    return None  # Should not be reached if exit occurs


def close_db_connection(connection):
    """Closes the database connection if it's open."""
    if connection and connection.open:
        connection.close()
        logger.info("Database connection closed.")


# --- Pinecone Utilities ---
def get_pinecone_client() -> Pinecone:
    """Initializes and returns a Pinecone client instance."""
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable not set.")
    # Environment might not be needed for serverless initialization
    # return Pinecone(api_key=api_key, environment=environment)
    return Pinecone(api_key=api_key)


def _get_index_configuration() -> tuple[int, str, ServerlessSpec]:
    """Gets Pinecone index configuration from environment variables."""
    dimension_str = os.getenv("OPENAI_INGEST_EMBEDDINGS_DIMENSION")
    if not dimension_str:
        raise ValueError(
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION environment variable not set"
        )

    dimension = int(dimension_str)
    metric = "cosine"
    spec = ServerlessSpec(
        cloud=os.getenv("PINECONE_CLOUD", "aws"),
        region=os.getenv("PINECONE_REGION", "us-west-2"),
    )

    return dimension, metric, spec


def _wait_for_index_ready(pinecone: Pinecone, index_name: str) -> None:
    """Waits for Pinecone index to become ready with timeout."""
    logger.info(
        f"Waiting for index '{index_name}' to be created (this may take a moment)..."
    )
    start_wait_time = time.time()
    wait_timeout = 300  # 5 minutes timeout for index creation

    while not pinecone.describe_index(index_name).status["ready"]:
        time.sleep(5)
        if time.time() - start_wait_time > wait_timeout:
            logger.error(
                f"Error: Timeout waiting for index '{index_name}' to become ready."
            )
            sys.exit(1)

    logger.info(f"Index '{index_name}' created successfully.")


def _create_pinecone_index(pinecone: Pinecone, index_name: str) -> None:
    """Creates a Pinecone index with standard configuration."""
    try:
        dimension, metric, spec = _get_index_configuration()

        pinecone.create_index(
            name=index_name, dimension=dimension, metric=metric, spec=spec
        )

        _wait_for_index_ready(pinecone, index_name)

    except Exception as create_error:
        logger.error(f"Error creating Pinecone index '{index_name}': {create_error}")
        sys.exit(1)


def _handle_dry_run_index_creation(pinecone: Pinecone, index_name: str) -> None:
    """Handles index creation confirmation and execution in dry run mode."""
    logger.info(f"Dry run: Index '{index_name}' does not exist.")

    confirm = input(
        f"Would you like to create the index '{index_name}' even in dry run mode? (Y/n): "
    )

    # Default to yes if user just presses enter or enters anything starting with Y/y
    if confirm.lower() not in ["n", "no"]:
        logger.info(f"Creating index '{index_name}' in dry run mode...")
        _create_pinecone_index(pinecone, index_name)
    else:
        # User declined to create the index
        logger.error(
            "Index creation declined. Cannot proceed in dry run mode without an existing index."
        )
        sys.exit(1)


def create_pinecone_index_if_not_exists(
    pinecone: Pinecone, index_name: str, dry_run: bool = False
):
    """Checks if the specified Pinecone index exists, creates it if not, respecting dry_run."""
    # Adapted from ingest-text-data.ts
    try:
        logger.info(f"Checking status of index '{index_name}'...")
        pinecone.describe_index(index_name)
        logger.info(f"Index '{index_name}' already exists.")
        return

    except NotFoundException:
        # This is the expected exception when the index does not exist
        if dry_run:
            _handle_dry_run_index_creation(pinecone, index_name)
        else:
            logger.info(f"Index '{index_name}' does not exist. Creating...")
            _create_pinecone_index(pinecone, index_name)

    except Exception as e:
        # Catch any other unexpected errors during description
        logger.error(
            f"Unexpected error checking Pinecone index status for '{index_name}': {e}"
        )
        sys.exit(1)


# --- Checkpoint Utilities ---
def get_checkpoint_file_path(site: str) -> str:
    """Constructs the full path for the site's checkpoint file."""
    return CHECKPOINT_FILE_TEMPLATE.format(site=site)


def load_checkpoint(checkpoint_file: str) -> dict | None:
    """Loads checkpoint data from a JSON file if it exists and is valid."""
    if not os.path.exists(checkpoint_file):
        return None

    try:
        with open(checkpoint_file, encoding="utf-8") as f:
            checkpoint_data = json.load(f)
            # Basic validation of checkpoint structure
            if isinstance(
                checkpoint_data.get("processed_doc_ids"), list
            ) and isinstance(checkpoint_data.get("last_processed_id"), int):
                logger.info(f"Loaded checkpoint from {checkpoint_file}")
                return checkpoint_data
            else:
                logger.info(
                    f"Invalid checkpoint format in {checkpoint_file}. Ignoring."
                )
                return None
    except json.JSONDecodeError as e:
        logger.warning(
            f"Invalid JSON in checkpoint file {checkpoint_file}: {e}. Ignoring."
        )
        return None


def save_checkpoint(
    checkpoint_file: str, processed_doc_ids: list[int], last_processed_id: int
):
    """Saves the current ingestion state (processed IDs) to a checkpoint file."""
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    # Store unique, sorted IDs for consistency
    checkpoint_data = {
        "processed_doc_ids": sorted(list(set(processed_doc_ids))),
        "last_processed_id": last_processed_id,
        "timestamp": datetime.now().isoformat(),
    }
    with open(checkpoint_file, "w", encoding="utf-8") as f:
        json.dump(checkpoint_data, f, indent=2)
    # Frequent saving can be noisy, uncomment if needed for debugging
    # print(f"Checkpoint saved to {checkpoint_file} (Last ID: {last_processed_id})")


# --- Site Configuration ---
def get_config(site):
    """Loads site-specific configuration details."""
    config = {
        "ananda": {
            "base_url": "https://www.anandalibrary.org/",  # Base URL for constructing permalinks
            "post_types": ["content"],  # WordPress post types to ingest
            "category_taxonomy": "library-category",  # The WP taxonomy name used for categories
        },
        "test": {
            "base_url": "https://test.anandalibrary.org/",  # Test base URL for constructing permalinks
            "post_types": ["content"],  # WordPress post types to ingest
            "category_taxonomy": "library-category",  # The WP taxonomy name used for categories
        },
    }
    if site not in config:
        logger.error(f"Error: Site configuration for '{site}' not found.")
        sys.exit(1)
    logger.info(f"Using configuration for site: {site}")
    return config[site]


# --- Data Fetching Logic ---
def fetch_authors(db_connection) -> dict[int, str]:
    """Fetches user IDs and display names from the wp_users table."""
    authors = {}
    try:
        with db_connection.cursor() as cursor:
            cursor.execute("SELECT ID, display_name FROM wp_users")
            results = cursor.fetchall()
            for row in results:
                authors[row["ID"]] = row["display_name"]
        logger.info(f"Fetched {len(authors)} authors from wp_users.")
        return authors
    except pymysql.MySQLError as e:
        logger.error(f"Error fetching authors: {e}")
        # Treat this as a critical error, as author info is important metadata
        sys.exit(1)


def calculate_permalink(
    base_url: str,
    post_type: str,
    post_date: datetime,
    post_name: str,
    parent_slug_1: str | None,
    parent_slug_2: str | None,
    parent_slug_3: str | None,
    site: str = None,
) -> str:
    """Calculates the likely permalink based on WP structure and site-specific configurations, including multiple parent slugs."""

    if site in ["ananda", "test"] and post_type == "content":
        # Build the ancestor path by filtering out None slugs and joining them
        ancestor_slugs = [
            slug for slug in [parent_slug_3, parent_slug_2, parent_slug_1] if slug
        ]
        # Join slugs in the correct order: great-grandparent/grandparent/parent
        ancestor_path = "/".join(ancestor_slugs)

        if ancestor_path:
            path_part = f"content/{ancestor_path}/{post_name}/"
        else:
            # Fallback if no parent slugs are found
            path_part = f"content/{post_name}/"
    elif post_type == "page":
        # Pages typically use just the slug
        path_part = f"{post_name}/"
    else:
        # Default: Posts typically use year/month/slug structure
        path_part = f"{post_date.year}/{post_date.month:02d}/{post_name}/"

    # Ensure base_url ends with a slash and path_part doesn't start with one for clean joining
    if not base_url.endswith("/"):
        base_url += "/"
    if path_part.startswith("/"):
        path_part = path_part[1:]

    return base_url + path_part


def _construct_sql_query(
    post_types: list[str],
    category_taxonomy: str,
    author_taxonomy: str,
    max_records: int = None,
) -> tuple[str, list]:
    """Constructs the main SQL query and parameters for fetching posts."""
    # Create placeholders for the SQL query IN clauses
    placeholders = ", ".join(["%s"] * len(post_types))

    # Construct the main SQL query to fetch posts, their parent titles (up to 3 levels),
    # associated categories, and associated authors from the specified taxonomies.
    query = f"""
        SELECT
            child.ID,
            child.post_content,
            child.post_name,
            child.post_parent,                     -- Add post_parent for hierarchy filtering
            parent.post_title AS PARENT_TITLE_1,  -- Immediate parent
            parent.post_name AS PARENT_SLUG_1,    -- Immediate parent slug
            parent2.post_title AS PARENT_TITLE_2, -- Grandparent
            parent2.post_name AS PARENT_SLUG_2,   -- Grandparent slug
            parent3.post_title AS PARENT_TITLE_3, -- Great-grandparent
            parent3.post_name AS PARENT_SLUG_3,   -- Great-grandparent slug
            parent3.post_author AS PARENT3_AUTHOR_ID, -- Great-grandparent User ID (might be unused now)
            child.post_title AS CHILD_TITLE,      -- The post's own title
            child.post_author,                     -- Child User ID (might be unused now)
            child.post_date,
            child.post_type,
            -- Concatenate distinct category names using a unique separator
            GROUP_CONCAT(DISTINCT cat_terms.name SEPARATOR '|||') AS categories,
            -- Concatenate distinct author names using a unique separator
            GROUP_CONCAT(DISTINCT author_terms.name SEPARATOR '|||') AS authors_list
        FROM
            wp_posts AS child
            -- Joins for parent hierarchy
            LEFT JOIN wp_posts AS parent ON child.post_parent = parent.ID AND parent.post_type IN ({placeholders})
            LEFT JOIN wp_posts AS parent2 ON parent.post_parent = parent2.ID AND parent2.post_type IN ({placeholders})
            LEFT JOIN wp_posts AS parent3 ON parent2.post_parent = parent3.ID AND parent3.post_type IN ({placeholders})
            -- Joins for Categories
            LEFT JOIN wp_term_relationships AS cat_tr ON child.ID = cat_tr.object_id
            LEFT JOIN wp_term_taxonomy AS cat_tt ON cat_tr.term_taxonomy_id = cat_tt.term_taxonomy_id AND cat_tt.taxonomy = %s
            LEFT JOIN wp_terms AS cat_terms ON cat_tt.term_id = cat_terms.term_id
            -- Joins for Authors (using assumed 'author' taxonomy)
            LEFT JOIN wp_term_relationships AS author_tr ON child.ID = author_tr.object_id
            LEFT JOIN wp_term_taxonomy AS author_tt ON author_tr.term_taxonomy_id = author_tt.term_taxonomy_id AND author_tt.taxonomy = %s
            LEFT JOIN wp_terms AS author_terms ON author_tt.term_id = author_terms.term_id
        WHERE
            child.post_status = 'publish'           -- Only published posts
            AND child.post_type IN ({placeholders}) -- Only desired post types
        GROUP BY
            -- Group by all selected post fields to ensure one row per post
            child.ID, child.post_content, child.post_name, child.post_parent, PARENT_TITLE_1, PARENT_TITLE_2, PARENT_TITLE_3, PARENT3_AUTHOR_ID,
            CHILD_TITLE, child.post_author, child.post_date, child.post_type
        ORDER BY
            child.ID -- Order by ID for potentially easier debugging/checkpointing
        """

    # Add LIMIT clause if max_records is specified
    if max_records:
        query += f" LIMIT {max_records}"
        logger.info(f"Note: Limiting query to {max_records} records as requested.")

    query += ";"

    # Parameters: post_types for parents, category taxonomy, author taxonomy, post_types for child WHERE clause
    params = post_types * 3 + [category_taxonomy, author_taxonomy] + post_types

    return query, params


def _build_full_title(row: dict) -> str:
    """Builds hierarchical title from parent titles and post title."""
    titles = [
        title
        for title in [
            row.get(
                "PARENT_TITLE_3"
            ),  # Use .get for safety if columns might be missing
            row.get("PARENT_TITLE_2"),
            row.get("PARENT_TITLE_1"),
            row.get("CHILD_TITLE"),
        ]
        if title  # Filter out None or empty titles
    ]
    return ":: ".join(titles)  # Use ':: ' as a separator


def _process_categories(row: dict) -> list[str]:
    """Processes and returns the list of categories for a post."""
    category_list = []
    if row.get("categories"):
        # Split by the '|||' separator used in GROUP_CONCAT and strip whitespace
        category_list = [
            cat.strip() for cat in row["categories"].split("|||") if cat.strip()
        ]
    return category_list


def _determine_author_name(row: dict) -> str:
    """Determines the author name from taxonomy data."""
    author_name = "Unknown"  # Default author
    authors_list_str = row.get("authors_list")
    if authors_list_str:
        # Split the concatenated string, take the first author, strip whitespace
        potential_authors = [
            name.strip() for name in authors_list_str.split("|||") if name.strip()
        ]
        if potential_authors:
            author_name = potential_authors[0]  # Use the first author found
    return author_name


def _build_processed_data_entry(
    row: dict,
    full_title: str,
    author_name: str,
    permalink: str,
    cleaned_content: str,
    category_list: list[str],
    library_name: str,
) -> dict:
    """Builds the processed data dictionary for a single post."""
    return {
        "id": row["ID"],  # Original WordPress Post ID
        "title": full_title,
        "author": author_name,  # Now using the name from taxonomy
        "permalink": permalink,  # URL source
        "content": cleaned_content,  # The main text content for embedding
        "categories": category_list,  # Associated categories
        "library": library_name,  # Library name for Pinecone metadata filtering
    }


def _log_exclusion_summary(
    exclusion_rules: dict,
    total_excluded: int,
    exclusion_stats: dict,
    processed_data: list,
):
    """Logs the exclusion summary statistics."""
    if exclusion_rules and exclusion_rules.get("rules"):
        logger.info("📊 EXCLUSION SUMMARY:")
        logger.info(f"   🚫 Total posts excluded: {total_excluded}")
        logger.info(f"   ✅ Total posts prepared for ingestion: {len(processed_data)}")

        if exclusion_stats:
            logger.info("   📋 Exclusions by rule:")
            for rule_name, count in sorted(exclusion_stats.items()):
                logger.info(f"      • {rule_name}: {count} posts")
        else:
            logger.info("   ℹ️  No posts were excluded by any rules")
    else:
        logger.info("📊 No exclusion rules active - all content processed normally")


def fetch_data(
    db_connection,
    site_config: dict,
    library_name: str,
    authors: dict,
    site: str,
    max_records: int = None,
) -> list[dict]:
    """Fetches, cleans, and prepares post data from the database for ingestion."""

    # Download exclusion rules from S3
    logger.info(f"🔍 Loading exclusion rules for site '{site}'...")
    exclusion_rules = download_exclusion_rules_from_s3(site)

    # Initialize exclusion tracking
    exclusion_stats = {}
    total_excluded = 0

    post_types = site_config["post_types"]
    category_taxonomy = site_config["category_taxonomy"]
    # Use the confirmed taxonomy slug for authors
    author_taxonomy = "library-author"
    base_url = site_config["base_url"]

    # Construct SQL query and parameters
    query, params = _construct_sql_query(
        post_types, category_taxonomy, author_taxonomy, max_records
    )

    processed_data = []
    try:
        with db_connection.cursor() as cursor:
            if max_records:
                logger.info(
                    f"Executing main data fetching query (limited to {max_records} records)..."
                )
            else:
                logger.info("Executing main data fetching query (including authors)...")
            start_time = time.time()
            cursor.execute(query, params)
            results = cursor.fetchall()  # Fetch all results at once
            end_time = time.time()
            logger.info(
                f"Query executed in {end_time - start_time:.2f} seconds. Found {len(results)} posts matching criteria."
            )

            logger.info("Processing fetched rows to prepare for ingestion...")

            # Create progress configuration for data preparation
            data_prep_config = ProgressConfig(
                description="Preparing Data",
                unit="row",
                total=len(results),
            )

            # Iterate through fetched rows with progress tracking
            with ProgressTracker(data_prep_config) as progress:
                for row in results:
                    # Check exclusion rules first
                    should_exclude, exclusion_reason = should_exclude_post(
                        row, exclusion_rules
                    )
                    if should_exclude:
                        total_excluded += 1
                        rule_name = (
                            exclusion_reason.split(":")[0]
                            .replace("Rule '", "")
                            .replace("'", "")
                        )
                        exclusion_stats[rule_name] = (
                            exclusion_stats.get(rule_name, 0) + 1
                        )

                        # Debug: Log excluded posts (but not too verbosely)
                        if total_excluded <= 10:  # Only log first 10 for debugging
                            logger.info(
                                f"🚫 EXCLUDED Post ID {row['ID']} ({row.get('CHILD_TITLE', 'No Title')}): {exclusion_reason}"
                            )
                        elif total_excluded == 11:
                            logger.info(
                                "🚫 ... (additional exclusions will be counted but not logged individually)"
                            )
                        progress.update(1)
                        continue

                    # Build hierarchical title
                    full_title = _build_full_title(row)

                    # Skip processing if any part of the title indicates it should be excluded
                    # This is a convention used in the Ananda Library data
                    if "DO NOT USE" in full_title:
                        progress.update(1)
                        continue

                    # Clean smart quotes but preserve HTML for PDF processing
                    cleaned_content = replace_smart_quotes(row["post_content"])
                    # Skip if content becomes empty after cleaning (e.g., posts with only shortcodes/HTML)
                    if not cleaned_content:
                        progress.update(1)
                        continue

                    # Process categories and author
                    category_list = _process_categories(row)
                    author_name = _determine_author_name(row)

                    # Calculate the permalink
                    permalink = calculate_permalink(
                        base_url=base_url,
                        post_type=row["post_type"],
                        post_date=row["post_date"],
                        post_name=row["post_name"],
                        parent_slug_1=row.get("PARENT_SLUG_1"),
                        parent_slug_2=row.get("PARENT_SLUG_2"),
                        parent_slug_3=row.get("PARENT_SLUG_3"),
                        site=site,
                    )

                    # Build processed data entry
                    processed_entry = _build_processed_data_entry(
                        row,
                        full_title,
                        author_name,
                        permalink,
                        cleaned_content,
                        category_list,
                        library_name,
                    )
                    processed_data.append(processed_entry)
                    progress.update(1)

        # Log exclusion summary at the end
        _log_exclusion_summary(
            exclusion_rules, total_excluded, exclusion_stats, processed_data
        )

        logger.info(
            f"Finished processing rows. {len(processed_data)} posts prepared for ingestion."
        )
        return processed_data

    except pymysql.MySQLError as e:
        logger.error(f"Database error during data fetching or processing: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Unexpected error during data preparation: {e}")
        import traceback

        traceback.print_exc()  # Print traceback for unexpected errors
        sys.exit(1)


# --- Pinecone Vector Deletion ---
def clear_library_vectors(
    pinecone_index, library_name: str, dry_run: bool = False
) -> bool:
    """Deletes all vectors associated with a specific library name prefix, respecting dry_run."""
    if dry_run:
        logger.info(
            f"Dry run: Skipping vector deletion check for library '{library_name}'."
        )
        return True  # Simulate successful skipping

    # Construct the prefix used for vectors belonging to this library
    prefix = f"text||{library_name}||"
    logger.info(
        f"Listing existing vectors with prefix '{prefix}' for potential deletion..."
    )
    vector_ids = []
    total_listed = 0
    # batch_limit is not directly used by the generator, but list() might use it internally.
    # Keeping it for clarity or potential future API changes, but removing explicit pagination.
    batch_limit = 100

    # Iterate directly over the generator returned by list()
    list_response_generator = pinecone_index.list(prefix=prefix, limit=batch_limit)

    # The generator yields lists of IDs per batch
    for id_batch in list_response_generator:
        if is_exiting():
            logger.info(
                "Shutdown signal received during vector listing. Aborting deletion."
            )
            return False

        # Check if the yielded item is a list (expected format)
        if isinstance(id_batch, list):
            # Add all IDs from the current batch to our main list
            vector_ids.extend(id_batch)
            total_listed += len(id_batch)
        else:
            # Handle potential variations in response format or log a warning
            logger.warning(
                f"Warning: Vector info format unexpected, skipping: {id_batch}"
            )

        # Print progress periodically
        if total_listed > 0 and total_listed % 1000 == 0:
            logger.info(f"Listed {total_listed} vectors so far...")

    logger.info(
        f"Finished listing. Found a total of {len(vector_ids)} vectors for library '{library_name}'"
    )

    if not vector_ids:
        logger.info("No existing vectors found for this library. Nothing to delete.")
        return True  # Indicate success (nothing needed to be done)

    logger.info(
        f"\nFound {len(vector_ids)} existing vectors for library '{library_name}'."
    )
    # Get user confirmation before deleting
    confirm = input(
        "Proceed with deleting ALL these vectors? This cannot be undone. (y/N): "
    )
    if confirm.lower() != "y":
        logger.info("Deletion aborted by user.")
        return False  # Indicate aborted by user

    logger.info("Deleting vectors in batches...")
    # Pinecone delete operation can handle up to 1000 IDs per call
    delete_batch_size = 1000
    total_deleted = 0

    # Create progress bar for deletion
    delete_config = ProgressConfig(
        description="Deleting Batches",
        unit="batch",
        total=math.ceil(len(vector_ids) / delete_batch_size),
    )

    # Iterate through the vector IDs in batches with progress tracking
    with ProgressTracker(delete_config) as progress:
        for i in range(0, len(vector_ids), delete_batch_size):
            if is_exiting():
                logger.info(
                    "Shutdown signal received during deletion. Deletion may be incomplete."
                )
                # Saving checkpoint here might be misleading as deletion wasn't fully confirmed complete
                return False  # Indicate incomplete deletion

            batch_ids = vector_ids[i : i + delete_batch_size]
            pinecone_index.delete(ids=batch_ids)
            total_deleted += len(batch_ids)  # Assuming success if no exception
            progress.update(1)

    logger.info(f"Successfully deleted {total_deleted} vectors.")
    return True  # Indicate successful deletion


# --- Processing & Upsertion ---


def _initialize_batch_processing():
    """Initializes batch processing variables and counters."""
    vectors_to_upsert = []
    errors_in_batch = 0
    total_chunks_in_batch = 0
    processed_ids_in_batch = []

    # Add counter for total chunks processed across all batches (as a list for mutability)
    if not hasattr(process_and_upsert_batch, "total_chunks_processed"):
        process_and_upsert_batch.total_chunks_processed = [0]

    return (
        vectors_to_upsert,
        errors_in_batch,
        total_chunks_in_batch,
        processed_ids_in_batch,
    )


def _process_document_chunks(post_data: dict, text_splitter) -> tuple[list, int]:
    """Processes a document by splitting into chunks and preparing chunk data."""
    post_id = post_data.get("id", "N/A")

    # Create document metadata for SpacyTextSplitter
    document_metadata = {
        "id": f"wp_{post_id}",
        "title": post_data["title"],
        "source": post_data["permalink"],
        "wp_id": post_id,
    }

    # Strip HTML tags from content for Pinecone chunking
    # This ensures clean text for embeddings while preserving original HTML for PDF generation
    content_for_chunking = remove_html_tags(post_data["content"])

    if not content_for_chunking or not content_for_chunking.split():
        logger.info(
            f"Skipping zero-word document: {post_data.get('permalink', post_id)} "
            f"(title: {post_data.get('title', 'N/A')})"
        )
        return [], 0

    # Create Langchain document and split into chunks
    langchain_doc = Document(
        page_content=content_for_chunking, metadata=document_metadata
    )
    docs = text_splitter.split_documents([langchain_doc])

    if not docs:
        logger.warning(
            f"Warning: Post ID {post_id} resulted in zero chunks after splitting. Skipping."
        )
        return [], 0

    return docs, len(docs)


def _prepare_vector_data(
    docs: list,
    post_data: dict,
    site: str,
    library_name: str,
    no_pdf_uploads: bool = False,
    debug_pdfs: bool = False,
    overwrite_pdfs: bool = False,
) -> list[dict]:
    """Prepares vector data for each chunk including IDs and metadata."""
    prepared_vectors_data = []
    post_id = post_data.get("id", "N/A")
    post_title = post_data.get("title", "Unknown Title")

    # Generate PDF and get S3 key (once per document, not per chunk)
    pdf_s3_key = None
    if not no_pdf_uploads:
        try:
            pdf_s3_key = generate_and_upload_pdf(
                post_data,
                site,
                library_name,
                no_pdf_uploads,
                debug_pdfs,
                overwrite_pdfs,
            )
        except Exception as e:
            # Track PDF generation failures but allow processing to continue
            failure_tracker.add_failure(
                document_id=post_id,
                title=post_title,
                error=e,
                stage="pdf_generation",
                include_traceback=True,
            )
            pdf_s3_key = None  # Continue without PDF

    for i, doc in enumerate(docs):
        # Update total chunk count
        process_and_upsert_batch.total_chunks_processed[0] += 1

        # Generate unique vector ID for this chunk
        pinecone_id = generate_vector_id(
            library_name=post_data["library"],
            title=post_data["title"],
            chunk_index=i,
            source_location="db",
            source_identifier=post_data["permalink"],
            content_type="text",
            author=post_data["author"],
            chunk_text=doc.page_content,
        )

        # Construct metadata dictionary
        metadata = {
            "library": post_data["library"],
            "type": "text",
            "author": post_data["author"],
            "source": post_data["permalink"],
            "title": post_data["title"],
            "categories": post_data["categories"],
            "text": doc.page_content,
            "wp_id": post_id,
            "chunk_index": i + 1,
        }

        # Add PDF S3 key if available
        if pdf_s3_key:
            metadata["pdf_s3_key"] = pdf_s3_key

        prepared_vectors_data.append(
            {
                "id": pinecone_id,
                "metadata": metadata,
                "page_content": doc.page_content,
            }
        )

    return prepared_vectors_data


def _combine_embeddings_and_metadata(
    prepared_vectors_data: list, embeddings: list, post_id
) -> tuple[list, int]:
    """Combines embeddings with prepared vector data for Pinecone upsert."""
    vectors_to_upsert = []
    embedding_errors = 0

    for i, vec_data in enumerate(prepared_vectors_data):
        if i < len(embeddings):
            vectors_to_upsert.append(
                {
                    "id": vec_data["id"],
                    "values": embeddings[i],
                    "metadata": vec_data["metadata"],
                }
            )
        else:
            logger.warning(
                f"Error: Mismatch between prepared vector data and embeddings for post {post_id}, chunk {i}. Skipping chunk."
            )
            embedding_errors += 1

    return vectors_to_upsert, embedding_errors


def _upsert_vectors_to_pinecone(
    vectors_to_upsert: list,
    pinecone_index,
    processed_ids_in_batch: list,
    total_chunks_in_batch: int,
    dry_run: bool,
) -> bool:
    """Upserts vectors to Pinecone or simulates in dry run mode."""
    if not vectors_to_upsert:
        return False

    if not dry_run:
        logger.info(
            f"Upserting {len(vectors_to_upsert)} vectors from {len(processed_ids_in_batch)} successfully processed posts ({total_chunks_in_batch} chunks) in this batch..."
        )

        # Upsert in smaller batches for optimal performance
        max_upsert_batch_size = 100
        total_upserted = 0

        for j in range(0, len(vectors_to_upsert), max_upsert_batch_size):
            upsert_batch = vectors_to_upsert[j : j + max_upsert_batch_size]
            upsert_response = pinecone_index.upsert(vectors=upsert_batch)
            batch_upserted = getattr(
                upsert_response, "upserted_count", len(upsert_batch)
            )
            total_upserted += batch_upserted

        return False  # No errors

    else:
        # Dry run: Simulate upsert
        logger.info(
            f"Dry run: Skipping Pinecone upsert for {len(vectors_to_upsert)} vectors from {len(processed_ids_in_batch)} posts."
        )
        return False  # No errors in dry run


def process_and_upsert_batch(
    batch_data: list[dict],
    pinecone_index,
    embeddings_model,
    text_splitter,
    site: str,
    library_name: str,
    dry_run: bool = False,
    no_pdf_uploads: bool = False,
    debug_pdfs: bool = False,
    overwrite_pdfs: bool = False,
) -> tuple[bool, list[int]]:
    """Processes a batch of documents: splits, embeds, and upserts to Pinecone, respecting dry_run.

    Returns:
        tuple[bool, list[int]]: A tuple containing:
            - bool: True if any processing errors occurred during the batch, False otherwise.
            - list[int]: A list of post IDs successfully processed in this batch.
    """
    # Initialize batch processing variables
    (
        vectors_to_upsert,
        errors_in_batch,
        total_chunks_in_batch,
        processed_ids_in_batch,
    ) = _initialize_batch_processing()

    # Process each document in the batch
    for post_data in batch_data:
        post_id = post_data.get("id", "N/A")
        post_title = post_data.get("title", "Unknown Title")

        if is_exiting():
            logger.info("Exiting batch processing due to shutdown signal.")
            return True, []

        try:
            # Process document chunks - let specific exceptions bubble up
            docs, chunk_count = _process_document_chunks(post_data, text_splitter)
            if not docs:
                continue

            total_chunks_in_batch += chunk_count

            # Prepare vector data for chunks - now catches PDF and other errors
            prepared_vectors_data = _prepare_vector_data(
                docs,
                post_data,
                site,
                library_name,
                no_pdf_uploads,
                debug_pdfs,
                overwrite_pdfs,
            )

            # Generate embeddings for all chunks in this post - let API errors bubble up
            batch_chunk_texts = [doc.page_content for doc in docs]
            embeddings = embeddings_model.embed_documents(batch_chunk_texts)

            # Combine embeddings with metadata
            post_vectors, embedding_errors = _combine_embeddings_and_metadata(
                prepared_vectors_data, embeddings, post_id
            )
            vectors_to_upsert.extend(post_vectors)
            errors_in_batch += embedding_errors

            # Mark post as successfully processed
            processed_ids_in_batch.append(post_id)

            # Simple completion log without percentage
            logger.info(
                f"✓ Completed document ID {post_id} - {post_title[:50]}{'...' if len(post_title) > 50 else ''} "
                f"({chunk_count} chunks)"
            )

        except Exception as e:
            # Use the failure tracking system for individual document errors
            failure_tracker.add_failure(
                document_id=post_id,
                title=post_title,
                error=e,
                stage="document_processing",
                include_traceback=True,
            )
            errors_in_batch += 1

            # Simple error log without percentage
            logger.error(
                f"✗ Failed document ID {post_id} - {post_title[:50]}{'...' if len(post_title) > 50 else ''} "
                f"Error: {str(e)[:100]}{'...' if len(str(e)) > 100 else ''}"
            )
            continue

    # Upsert vectors to Pinecone - now catches Pinecone errors specifically
    try:
        upsert_had_errors = _upsert_vectors_to_pinecone(
            vectors_to_upsert,
            pinecone_index,
            processed_ids_in_batch,
            total_chunks_in_batch,
            dry_run,
        )

        if upsert_had_errors:
            # If upsert fails, consider all posts in batch as errored
            errors_in_batch += len(processed_ids_in_batch)
            return True, []

    except Exception as e:
        # Pinecone upsert failed - log failures for all documents in this batch
        logger.error(f"Pinecone upsert failed for entire batch: {e}")
        for post_data in batch_data:
            if post_data.get("id") in processed_ids_in_batch:
                failure_tracker.add_failure(
                    document_id=post_data.get("id", "N/A"),
                    title=post_data.get("title", "Unknown Title"),
                    error=e,
                    stage="pinecone_upsert",
                    include_traceback=True,
                )
        return True, []

    # Return error status and processed IDs
    return errors_in_batch > 0, processed_ids_in_batch


# --- Setup Functions ---
def setup_connections_and_index(
    args: argparse.Namespace, dry_run: bool, no_pinecone: bool = False
) -> tuple[pymysql.Connection, Pinecone.Index]:
    """Establishes database and Pinecone connections and ensures the index exists."""
    logger.info("Establishing connections...")
    db_config = get_db_config(args)
    db_connection = get_db_connection(db_config)

    if no_pinecone:
        logger.info("Skipping Pinecone setup due to --no-pinecone flag.")
        return db_connection, None

    pinecone_client = get_pinecone_client()
    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        logger.error("Error: PINECONE_INGEST_INDEX_NAME not set in environment.")
        sys.exit(1)
    logger.info(f"Ensuring Pinecone index '{index_name}' exists...")
    create_pinecone_index_if_not_exists(pinecone_client, index_name, dry_run=dry_run)
    pinecone_index = pinecone_client.Index(index_name)
    logger.info("Connections and index ready.")
    return db_connection, pinecone_index


def handle_checkpoint_or_clear_data(
    args: argparse.Namespace,
    pinecone_index,
    checkpoint_file: str,
    dry_run: bool,
    no_pinecone: bool = False,
) -> set[int]:
    """Loads checkpoint or clears existing library data based on args."""
    processed_doc_ids = set()
    if args.keep_data:
        checkpoint = load_checkpoint(checkpoint_file)
        if checkpoint:
            loaded_ids = checkpoint.get("processed_doc_ids", [])
            processed_doc_ids = set(loaded_ids)
            last_processed_id = checkpoint.get("last_processed_id", 0)
            logger.info(
                f"Resuming ingestion. Found {len(processed_doc_ids)} documents previously processed (last highest ID: {last_processed_id})."
            )
        else:
            logger.info(
                "No valid checkpoint found. Starting ingestion from the beginning for this library."
            )
    else:
        if no_pinecone:
            logger.info(
                "Keep data set to False, but skipping vector deletion due to --no-pinecone flag."
            )
        else:
            logger.info(
                "Keep data set to False. Attempting to clear existing vectors for this library..."
            )
            try:
                if not clear_library_vectors(
                    pinecone_index, args.library_name, dry_run=dry_run
                ):
                    logger.error(
                        "Exiting due to issues or user cancellation during vector deletion (or skipped in dry run)."
                    )
                    sys.exit(1)
            except Exception as e:
                logger.error(f"Error during vector deletion: {e}")
                logger.error("Exiting due to vector deletion failure.")
                sys.exit(1)
    return processed_doc_ids


def fetch_all_data(
    db_connection,
    site_config: dict,
    library_name: str,
    site: str,
    max_records: int = None,
) -> list[dict]:
    """Fetches author and main post data."""
    logger.info("Fetching author data...")
    authors = fetch_authors(db_connection)
    logger.info("Fetching and preparing main post data...")
    all_rows = fetch_data(
        db_connection, site_config, library_name, authors, site, max_records
    )
    if not all_rows:
        logger.info("No data fetched from the database matching criteria.")
    return all_rows


# --- Processing Loop Functions ---
def run_pdf_only_loop(
    all_rows: list[dict],
    args: argparse.Namespace,
) -> tuple[int, int, int, int]:
    """Runs a PDF-only processing loop for --no-pinecone mode."""
    logger.info(f"Starting PDF-only processing for {len(all_rows)} documents...")
    processed_count_session = 0
    error_count_session = 0

    # Create progress configuration
    progress_config = ProgressConfig(
        description="Generating PDFs",
        unit="doc",
        total=len(all_rows),
        show_progress=True,
        enable_eta=True,
        bar_format="{desc}: {percentage:3.0f}%|{bar}| {n_fmt}/{total_fmt} docs [{elapsed}<{remaining}, {rate_fmt}]",
    )

    with ProgressTracker(progress_config) as progress:
        for i, post_data in enumerate(all_rows, 1):
            if is_exiting():
                logger.info("Shutdown signal received, stopping PDF generation...")
                break

            post_id = post_data.get("id", "N/A")
            post_title = post_data.get("title", "Unknown Title")

            try:
                # Generate and upload PDF
                pdf_s3_key = generate_and_upload_pdf(
                    post_data,
                    args.site,
                    args.library_name,
                    args.no_pdf_uploads,
                    args.debug_pdfs,
                    args.overwrite_pdfs,
                )

                if pdf_s3_key:
                    logger.info(
                        f"✓ {i}/{len(all_rows)}: Generated PDF for '{post_title[:50]}...' -> {pdf_s3_key}"
                    )
                else:
                    logger.info(
                        f"⚠ {i}/{len(all_rows)}: Skipped PDF for '{post_title[:50]}...' (no-pdf-uploads flag)"
                    )

                processed_count_session += 1
                progress.update(1)
                progress.increment_success(1)

            except Exception as e:
                failure_tracker.add_failure(
                    document_id=post_id,
                    title=post_title,
                    error=e,
                    stage="pdf_generation",
                    include_traceback=True,
                )
                error_count_session += 1
                progress.update(1)
                progress.increment_error(1)
                logger.error(
                    f"✗ {i}/{len(all_rows)}: Failed PDF for '{post_title[:50]}...' - {str(e)[:100]}"
                )

    return (
        processed_count_session,
        0,
        error_count_session,
        0,
    )  # skipped=0, last_id=0 for PDF-only mode


# --- Main Processing Loop Function ---
def run_ingestion_loop(
    all_rows: list[dict],
    processed_doc_ids: set[int],
    args: argparse.Namespace,
    pinecone_index,
    embeddings_model,
    text_splitter,
    checkpoint_file: str,
    dry_run: bool,
) -> tuple[int, int, int, int]:
    """Runs the main batch processing loop, handles checkpoints, and returns session stats."""
    logger.info(f"Starting processing loop for {len(all_rows)} fetched documents...")
    processed_count_session = 0
    skipped_count_session = 0
    error_count_session = 0
    last_processed_id_session = (
        max(processed_doc_ids) if processed_doc_ids else 0
    )  # Start with highest ID from checkpoint

    # Calculate total unprocessed documents for overall progress tracking
    total_unprocessed_docs = sum(
        1 for post_data in all_rows if post_data.get("id") not in processed_doc_ids
    )

    num_batches = math.ceil(len(all_rows) / args.batch_size)
    logger.info(
        f"Processing {len(all_rows)} documents in {num_batches} batches of size {args.batch_size}."
    )
    logger.info(
        f"Total unprocessed documents: {total_unprocessed_docs} "
        f"(skipping {len(all_rows) - total_unprocessed_docs} already processed)"
    )

    # Create progress configuration for batch processing
    progress_config = ProgressConfig(
        description="Processing Batches",
        unit="batch",
        total=num_batches,
        checkpoint_interval=1,  # Save checkpoint after each batch
    )

    # Create overall document progress configuration
    overall_doc_progress_config = ProgressConfig(
        description="Overall Document Progress",
        unit="doc",
        total=total_unprocessed_docs,
        show_progress=True,
        enable_eta=True,
        bar_format="{desc}: {percentage:3.0f}%|{bar}| {n_fmt}/{total_fmt} docs [{elapsed}<{remaining}, {rate_fmt}]",
    )

    def checkpoint_callback(current_progress: int, data: dict):
        """Callback to save checkpoint during progress tracking"""
        try:
            save_checkpoint(
                checkpoint_file, list(processed_doc_ids), last_processed_id_session
            )
        except (OSError, json.JSONEncodeError) as e:
            logger.warning(f"Failed to save checkpoint: {e}")
        except Exception as e:
            logger.error(f"Unexpected error saving checkpoint: {e}")

    # Use ProgressTracker for comprehensive progress tracking
    with (
        ProgressTracker(
            progress_config,
            checkpoint_callback=checkpoint_callback,
            checkpoint_data={"processed_doc_ids": processed_doc_ids},
        ) as progress,
        ProgressTracker(overall_doc_progress_config) as overall_progress,
    ):
        for i in range(num_batches):
            if is_exiting():
                logger.info(
                    "\nShutdown signal received, stopping batch processing loop..."
                )
                break

            batch_start_index = i * args.batch_size
            batch_end_index = min(batch_start_index + args.batch_size, len(all_rows))
            current_batch_data_full = all_rows[batch_start_index:batch_end_index]

            current_batch_data_unprocessed = []
            batch_skipped_count = 0
            for post_data in current_batch_data_full:
                post_id = post_data.get("id")
                if post_id in processed_doc_ids:
                    batch_skipped_count += 1
                else:
                    current_batch_data_unprocessed.append(post_data)

            skipped_count_session += batch_skipped_count

            if not current_batch_data_unprocessed:
                progress.update(1)  # Still update progress even if skipping
                continue

            # Log batch start with overall progress
            overall_completed = processed_count_session + skipped_count_session
            overall_percentage = (
                (overall_completed / len(all_rows)) * 100 if len(all_rows) > 0 else 0
            )

            logger.info(
                f"\n📦 Starting Batch {i + 1}/{num_batches} "
                f"({len(current_batch_data_unprocessed)} documents) "
                f"- Overall Progress: {overall_completed}/{len(all_rows)} ({overall_percentage:.1f}%)"
            )

            batch_had_errors, processed_ids_this_batch = process_and_upsert_batch(
                current_batch_data_unprocessed,
                pinecone_index,
                embeddings_model,
                text_splitter,
                site=args.site,
                library_name=args.library_name,
                dry_run=dry_run,
                no_pdf_uploads=args.no_pdf_uploads,
                debug_pdfs=args.debug_pdfs,
                overwrite_pdfs=args.overwrite_pdfs,
            )

            if not batch_had_errors:
                processed_doc_ids.update(processed_ids_this_batch)
                if processed_ids_this_batch:
                    last_processed_id_session = max(
                        last_processed_id_session, max(processed_ids_this_batch)
                    )
                processed_count_session += len(processed_ids_this_batch)
                progress.increment_success(len(processed_ids_this_batch))

                # Update overall document progress
                overall_progress.update(len(processed_ids_this_batch))
                overall_progress.increment_success(len(processed_ids_this_batch))

            else:
                logger.warning(
                    f"Batch {i + 1} encountered errors. Checkpoint not advanced for this batch's documents."
                )
                error_count_session += len(current_batch_data_unprocessed)
                progress.increment_error(len(current_batch_data_unprocessed))

                # Update overall document progress for errors
                overall_progress.update(len(current_batch_data_unprocessed))
                overall_progress.increment_error(len(current_batch_data_unprocessed))

            # Update batch progress tracker
            progress.update(1)

            # Log batch completion with overall progress
            overall_completed_after = processed_count_session + skipped_count_session
            overall_percentage_after = (
                (overall_completed_after / len(all_rows)) * 100
                if len(all_rows) > 0
                else 0
            )

            logger.info(
                f"✓ Batch {i + 1}/{num_batches} completed "
                f"- Overall Progress: {overall_completed_after}/{len(all_rows)} ({overall_percentage_after:.1f}%)"
            )

    return (
        processed_count_session,
        skipped_count_session,
        error_count_session,
        last_processed_id_session,
    )


# --- Main Execution ---
def _validate_flag_combinations(dry_run: bool, no_pinecone: bool) -> None:
    """Validate mutually exclusive CLI flags.

    Exits the process if an invalid combination is detected.
    """
    if dry_run and no_pinecone:
        logger.error(
            "Error: Cannot use both --dry-run and --no-pinecone flags together."
        )
        sys.exit(1)


def _log_startup_info(args: argparse.Namespace) -> None:
    """Log initial startup information and mode flags."""
    logger.info("--- Starting DB Text Ingestion ---")
    logger.info(f"Site: {args.site}")
    logger.info(f"Database: {args.database}")
    logger.info(f"Target Library Name: {args.library_name}")
    logger.info(f"Keep Existing Data: {args.keep_data}")
    logger.info(f"Batch Size: {args.batch_size}")
    logger.info(f"Max Records: {args.max_records}")

    if args.dry_run:
        logger.info("\n*** DRY RUN MODE ENABLED ***")
        logger.info(
            "No data will be sent to Pinecone (index creation, deletion, upserts skipped)."
        )
    elif args.no_pinecone:
        logger.info("\n*** NO-PINECONE MODE ENABLED ***")
        logger.info(
            "Pinecone operations skipped, but PDFs will be generated and uploaded to S3."
        )


def _prepare_models_and_splitter(no_pinecone: bool):
    """Prepare embedding model and text splitter unless Pinecone is disabled.

    Returns a tuple of (embeddings_model, text_splitter).
    """
    embeddings_model = None
    text_splitter = None
    if not no_pinecone:
        model_name = os.getenv("OPENAI_INGEST_EMBEDDINGS_MODEL")
        if not model_name:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set"
            )
        embeddings_model = OpenAIEmbeddings(model=model_name, chunk_size=500)
        # Historical SQL/database processing used 1000 chars (~250 tokens) with 200 chars (~50 tokens) overlap (20%)
        text_splitter = SpacyTextSplitter(
            chunk_size=250, chunk_overlap=50, log_summary_on_split=False
        )

    return embeddings_model, text_splitter


def _print_session_summary(
    processed_count_session: int,
    skipped_count_session: int,
    error_count_session: int,
    processed_doc_ids: set[int],
    last_processed_id_session: int,
    text_splitter,
) -> None:
    """Print a consolidated session summary, including splitter metrics and failures."""
    logger.info("\n--- Ingestion Session Summary ---")
    logger.info(
        f"Total documents processed successfully in this session: {processed_count_session}"
    )
    logger.info(
        f"Total documents skipped (already processed in previous runs): {skipped_count_session}"
    )
    logger.info(
        f"Total documents skipped or failed due to errors in this session: {error_count_session}"
    )
    logger.info(
        f"Total unique documents processed overall (including previous runs): {len(processed_doc_ids)}"
    )
    if last_processed_id_session > 0:
        logger.info(
            f"Highest document ID processed overall: {last_processed_id_session}"
        )

    if text_splitter is not None:
        logger.info("")
        text_splitter.metrics.print_summary()

    logger.info("")
    failure_tracker.print_summary()


def _attempt_save_checkpoint(
    checkpoint_file: str,
    processed_doc_ids: set[int],
    last_processed_id_session: int,
) -> None:
    """Attempt to save a checkpoint; log but ignore any errors."""
    try:
        save_checkpoint(
            checkpoint_file, list(processed_doc_ids), last_processed_id_session
        )
    except Exception as cp_err:  # noqa: BLE001 — log and continue on best-effort checkpoint
        logger.error(f"Could not save checkpoint: {cp_err}")


def _handle_rows(
    all_rows: list[dict],
    args: argparse.Namespace,
    processed_doc_ids: set[int],
    pinecone_index,
    dry_run: bool,
    no_pinecone: bool,
    checkpoint_file: str,
) -> tuple[int, int, int, int, object | None]:
    """Process fetched rows using either PDF-only or full ingestion loop.

    Returns (processed_count_session, skipped_count_session, error_count_session, last_processed_id_session, text_splitter)
    """
    embeddings_model, text_splitter = _prepare_models_and_splitter(no_pinecone)

    if no_pinecone:
        (
            processed_count_session,
            skipped_count_session,
            error_count_session,
            last_processed_id_session,
        ) = run_pdf_only_loop(
            all_rows,
            args,
        )
        return (
            processed_count_session,
            skipped_count_session,
            error_count_session,
            last_processed_id_session,
            text_splitter,
        )

    (
        processed_count_session,
        skipped_count_session,
        error_count_session,
        last_processed_id_session,
    ) = run_ingestion_loop(
        all_rows,
        processed_doc_ids,
        args,
        pinecone_index,
        embeddings_model,
        text_splitter,
        checkpoint_file,
        dry_run,
    )

    return (
        processed_count_session,
        skipped_count_session,
        error_count_session,
        last_processed_id_session,
        text_splitter,
    )


def _run_ingestion(args: argparse.Namespace) -> None:
    """Execute the ingestion flow with setup, processing, and teardown."""
    load_environment(args.site)
    site_config = get_config(args.site)

    db_connection = None
    pinecone_index = None
    processed_doc_ids: set[int] = set()
    processed_count_session = 0
    last_processed_id_session = 0

    try:
        db_connection, pinecone_index = setup_connections_and_index(
            args, args.dry_run, args.no_pinecone
        )
        checkpoint_file = get_checkpoint_file_path(args.site)
        processed_doc_ids = handle_checkpoint_or_clear_data(
            args, pinecone_index, checkpoint_file, args.dry_run, args.no_pinecone
        )

        all_rows = fetch_all_data(
            db_connection, site_config, args.library_name, args.site, args.max_records
        )

        if all_rows:
            (
                processed_count_session,
                skipped_count_session,
                error_count_session,
                last_processed_id_session,
                text_splitter,
            ) = _handle_rows(
                all_rows,
                args,
                processed_doc_ids,
                pinecone_index,
                args.dry_run,
                args.no_pinecone,
                checkpoint_file,
            )

            _print_session_summary(
                processed_count_session,
                skipped_count_session,
                error_count_session,
                processed_doc_ids,
                last_processed_id_session,
                text_splitter,
            )
        else:
            logger.info("Exiting as no data was fetched.")

    except KeyboardInterrupt:
        logger.info("\nKeyboardInterrupt received. Attempting final checkpoint save...")
        if (
            "checkpoint_file" in locals()
            and processed_doc_ids
            and processed_count_session > 0
        ):
            _attempt_save_checkpoint(
                checkpoint_file, processed_doc_ids, last_processed_id_session
            )

        # Print chunking statistics before exiting
        if "text_splitter" in locals() and text_splitter is not None:
            logger.info("")
            text_splitter.metrics.print_summary()

        logger.info("Exiting due to KeyboardInterrupt.")
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 — top-level handler logs and exits
        logger.error("\n--- An unexpected error occurred during the main process ---")
        logger.error(f"Error: {e}")
        import traceback

        traceback.print_exc()
        if (
            "checkpoint_file" in locals()
            and "processed_doc_ids" in locals()
            and "last_processed_id_session" in locals()
            and processed_count_session > 0
        ):
            logger.info("Attempting to save checkpoint on error...")
            _attempt_save_checkpoint(
                checkpoint_file, processed_doc_ids, last_processed_id_session
            )

        # Print chunking statistics before exiting
        if "text_splitter" in locals() and text_splitter is not None:
            logger.info("")
            text_splitter.metrics.print_summary()

        sys.exit(1)
    finally:
        logger.info("Closing database connection...")
        close_db_connection(db_connection)
        logger.info("Ingestion process finished.")


def main():
    """Main function to orchestrate the data ingestion process."""
    args = parse_arguments()
    _validate_flag_combinations(args.dry_run, args.no_pinecone)
    _log_startup_info(args)

    # Setup signal handlers using shared utilities
    setup_signal_handlers()
    _run_ingestion(args)


if __name__ == "__main__":
    main()
