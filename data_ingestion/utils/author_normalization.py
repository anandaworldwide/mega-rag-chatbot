"""
Author name normalization utility for consistent author metadata across ingestion pipelines.

Provides canonical mapping for author name variants and normalization functions to ensure
consistent author metadata in Pinecone and other storage systems.

Author mappings are loaded from site-specific configuration files.
"""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

# Cache for loaded author mappings per site
_author_mapping_cache: dict[str, dict[str, str]] = {}

# Crawler Docker image (see data_ingestion/crawler/Dockerfile)
_CONTAINER_MAPPINGS_PATH = "/app/web/site-config/author_mappings.json"


def _module_relative_mappings_path() -> str:
    return os.path.normpath(
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "web",
            "site-config",
            "author_mappings.json",
        )
    )


def resolve_author_mappings_path() -> str:
    """
    Resolve path to author_mappings.json for monorepo dev or crawler container.

    Search order:
    1. AUTHOR_MAPPINGS_PATH env var (if file exists)
    2. Crawler container path (/app/web/site-config/...)
    3. Monorepo path relative to this module (web/site-config/...)
    """
    env_path = os.environ.get("AUTHOR_MAPPINGS_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    module_relative = _module_relative_mappings_path()

    for candidate in (_CONTAINER_MAPPINGS_PATH, module_relative):
        if os.path.isfile(candidate):
            return candidate

    return module_relative


def _debug_mappings_resolution() -> str:
    """
    Build a diagnostic string describing every candidate path considered by
    resolve_author_mappings_path(), whether each exists, and directory listings
    of their parent dirs. Used to debug production path-resolution failures.
    """
    env_value = os.environ.get("AUTHOR_MAPPINGS_PATH")
    module_relative = _module_relative_mappings_path()

    candidates = [
        ("AUTHOR_MAPPINGS_PATH env", env_value),
        ("container path", _CONTAINER_MAPPINGS_PATH),
        ("module-relative path", module_relative),
    ]

    lines = [
        f"__file__={os.path.abspath(__file__)}",
        f"cwd={os.getcwd()}",
    ]

    for label, candidate in candidates:
        if not candidate:
            lines.append(f"{label}: <unset>")
            continue
        exists = os.path.isfile(candidate)
        lines.append(f"{label}: {candidate} (exists={exists})")
        if not exists:
            parent = os.path.dirname(candidate)
            try:
                listing = sorted(os.listdir(parent))
            except OSError as e:
                listing = [f"<listdir failed: {e}>"]
            lines.append(f"  parent dir {parent} contents: {listing}")

    return " | ".join(lines)


def _load_author_mappings(site_id: str) -> dict[str, str]:
    """
    Load author mappings for a specific site from web/site-config/author_mappings.json.

    Args:
        site_id: Site identifier (e.g., 'ananda', 'crystal', 'jairam')

    Returns:
        Dictionary mapping author variants to canonical names
    """
    # Check cache first
    if site_id in _author_mapping_cache:
        return _author_mapping_cache[site_id]

    try:
        config_path = resolve_author_mappings_path()

        with open(config_path, encoding="utf-8") as f:
            all_mappings = json.load(f)

        if site_id not in all_mappings:
            logger.warning(
                f"Author mappings not found for site '{site_id}', using empty mapping"
            )
            _author_mapping_cache[site_id] = {}
            return {}

        mappings = all_mappings[site_id]
        _author_mapping_cache[site_id] = mappings
        return mappings

    except FileNotFoundError:
        config_path = resolve_author_mappings_path()
        logger.warning(
            f"Author mappings file not found at {config_path}, "
            f"using empty mapping for site '{site_id}'. "
            f"Debug: {_debug_mappings_resolution()}"
        )
        _author_mapping_cache[site_id] = {}
        return {}
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in author mappings file: {e}")
        _author_mapping_cache[site_id] = {}
        return {}
    except Exception as e:
        logger.warning(f"Could not load author mappings for {site_id}: {e}")
        _author_mapping_cache[site_id] = {}
        return {}


def _lookup_in_mapping(author: str, author_mapping: dict[str, str]) -> str | None:
    """
    Look up author name in mapping (exact match, then case-insensitive).

    Args:
        author: Author name to look up
        author_mapping: Dictionary mapping variants to canonical names

    Returns:
        Canonical name if found, None otherwise
    """
    # Check direct mapping first (case-sensitive for exact matches)
    if author in author_mapping:
        return author_mapping[author]

    # Try case-insensitive lookup
    author_lower = author.lower()
    for variant, canonical in author_mapping.items():
        if variant.lower() == author_lower:
            return canonical

    return None


def _try_cleaned_lookup(
    author: str, pattern: str, author_mapping: dict[str, str]
) -> str | None:
    """
    Try to find mapping after cleaning author name with a regex pattern.

    Args:
        author: Original author name
        pattern: Regex pattern to remove unwanted parts
        author_mapping: Dictionary mapping variants to canonical names

    Returns:
        Canonical name if found after cleaning, None otherwise
    """
    cleaned = re.sub(pattern, "", author).strip()
    if cleaned and cleaned != author:
        return _lookup_in_mapping(cleaned, author_mapping)
    return None


def normalize_author(author: str | None, site_id: str | None = None) -> str:
    """
    Normalize an author name to its canonical form using site-specific mappings.

    Handles:
    - Direct mapping lookups from site-specific configuration
    - Whitespace normalization
    - Case-insensitive matching for common variants
    - Removal of trailing numbers/parentheses (e.g., "Author(92)" -> "Author")

    Args:
        author: Author name string (may be None)
        site_id: Site identifier for loading site-specific mappings (optional)

    Returns:
        Canonical author name string, or "Unknown" if input is None/empty

    Examples:
        >>> normalize_author("Swami Kriyanananda", "ananda")
        "Swami Kriyananda"
        >>> normalize_author("Swami Kriyananda(92)", "ananda")
        "Swami Kriyananda"
        >>> normalize_author("  Nayaswami Kriyananda  ", "ananda")
        "Swami Kriyananda"
        >>> normalize_author(None, "ananda")
        "Unknown"
    """
    if not author:
        return "Unknown"

    # Strip whitespace
    author = author.strip()

    if not author:
        return "Unknown"

    # Load site-specific mappings if site_id provided
    author_mapping: dict[str, str] = {}
    if site_id:
        author_mapping = _load_author_mappings(site_id)

    # Try direct lookup first
    result = _lookup_in_mapping(author, author_mapping)
    if result:
        return result

    # Handle trailing numbers/parentheses pattern (e.g., "Swami Kriyananda(92)")
    result = _try_cleaned_lookup(author, r"\s*\([0-9]+\)\s*$", author_mapping)
    if result:
        return result

    # Handle malformed parentheses/braces (e.g., "Swami Kriyananda {J. Donald Walters)")
    result = _try_cleaned_lookup(author, r"\s*[{(].*[)}]\s*$", author_mapping)
    if result:
        return result

    # If no mapping found, return cleaned original (preserving case)
    return author.strip()
