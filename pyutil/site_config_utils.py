#!/usr/bin/env python
"""
Site Configuration Utilities

This module provides utilities for loading and processing site configuration
from the centralized config.json file. It includes functions for:

1. Loading site-specific configuration
2. Resolving configured access level keys and numeric values
3. Managing site-specific settings across the application

Usage:
    from pyutil.site_config_utils import load_site_config, get_required_access_level_for_key

    config = load_site_config("ananda")
    access_level = get_required_access_level_for_key("kriyaban", config)
"""

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def load_site_config(site_id: str) -> dict[str, Any]:
    """
    Load site configuration from web/site-config/config.json

    Args:
        site_id: Site identifier (e.g., 'ananda', 'crystal', 'jairam', 'ananda-public')

    Returns:
        Site configuration dictionary containing site-specific settings

    Raises:
        FileNotFoundError: If config.json file is not found
        KeyError: If site_id is not found in configuration
    """
    try:
        # Navigate from pyutil/ to web/site-config/config.json
        config_path = os.path.join(
            os.path.dirname(__file__), "..", "web", "site-config", "config.json"
        )
        config_path = os.path.normpath(config_path)

        with open(config_path, encoding="utf-8") as f:
            all_configs = json.load(f)

        if site_id not in all_configs:
            logger.warning(f"Site ID '{site_id}' not found in configuration")
            return {}

        return all_configs[site_id]

    except FileNotFoundError:
        logger.error(f"Site configuration file not found at {config_path}")
        return {}
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in site configuration file: {e}")
        return {}
    except Exception as e:
        logger.warning(f"Could not load site config for {site_id}: {e}")
        return {}


def get_required_access_level_for_key(
    access_level_key: str, site_config: dict[str, Any]
) -> int:
    """
    Convert an access-level key/label/legacy value to its numeric required level.

    Sites without accessControl stay public-compatible and return 0.
    """
    if not access_level_key:
        return 0

    access_control = site_config.get("accessControl", {})
    if not access_control.get("enabled") or not isinstance(
        access_control.get("levels"), list
    ):
        return 0

    normalized_access_key = _normalize_access_level_key(access_level_key)
    for level in access_control["levels"]:
        if not isinstance(level, dict):
            continue
        accepted_values = [
            level.get("key"),
            level.get("label"),
        ]
        normalized_values = {
            _normalize_access_level_key(str(value))
            for value in accepted_values
            if value is not None
        }
        if normalized_access_key in normalized_values:
            try:
                return int(level.get("value", 0))
            except (TypeError, ValueError):
                logger.warning(
                    "Invalid numeric value for access level '%s'", level.get("key")
                )
                return 0

    return 0


def get_access_level_key_for_required_level(
    required_access_level: int, site_config: dict[str, Any]
) -> str:
    """
    Convert a numeric required access level to its configured key.

    Unknown values default to public for the legacy string metadata field.
    Retrieval authorization uses required_access_level.
    """
    access_control = site_config.get("accessControl", {})
    if not access_control.get("enabled") or not isinstance(
        access_control.get("levels"), list
    ):
        return "public"

    for level in access_control["levels"]:
        if not isinstance(level, dict):
            continue
        try:
            level_value = int(level.get("value", 0))
        except (TypeError, ValueError):
            continue
        if level_value == required_access_level:
            return str(level.get("key", "public"))

    return "public"


def get_excluded_access_levels(site_config: dict[str, Any]) -> list:
    """
    Get the list of access levels that should be excluded from queries.

    Args:
        site_config: Site configuration dictionary

    Returns:
        List of access levels to exclude (e.g., ['kriyaban', 'admin'])
        Returns empty list if no exclusions are configured
    """
    return site_config.get("excludedAccessLevels", [])


def _normalize_access_level_key(value: str) -> str:
    normalized = value.strip().lower().replace("&", "and")
    chars = [char if char.isalnum() else "_" for char in normalized]
    return "_".join(filter(None, "".join(chars).split("_")))


def validate_site_config(site_config: dict[str, Any]) -> bool:
    """
    Validate that a site configuration has the required structure.

    Args:
        site_config: Site configuration dictionary to validate

    Returns:
        True if configuration is valid, False otherwise
    """
    if not isinstance(site_config, dict):
        logger.error("Site configuration must be a dictionary")
        return False

    # Check if excludedAccessLevels is properly structured
    excluded_levels = site_config.get("excludedAccessLevels", [])
    if excluded_levels and not isinstance(excluded_levels, list):
        logger.error("excludedAccessLevels must be a list")
        return False

    return True
