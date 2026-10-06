"""Read-only Notion API client for the family wiki ingest."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

import requests

NOTION_VERSION = "2022-06-28"
NOTION_API_BASE = "https://api.notion.com/v1"
_CHILD_BLOCK_TYPES = frozenset({"child_page", "child_database"})
_PROGRESS_EVERY_REQUESTS = 25

logger = logging.getLogger(__name__)

Transport = Callable[..., Any]


class NotionWikiError(RuntimeError):
    """The Notion API refused a wiki read."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        transient: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.transient = transient


# Timeouts and dropped connections. Retry these. Do not retry a bad token.
_TRANSIENT_REQUEST_ERRORS = (
    requests.Timeout,
    requests.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
)


class NotionWikiClient:
    """Paginated reader for pages, blocks, and child databases."""

    def __init__(
        self,
        api_key: str,
        *,
        transport: Transport | None = None,
        min_interval_seconds: float = 0.34,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._api_key = api_key
        self._transport = transport or requests.request
        self._min_interval_seconds = min_interval_seconds
        self._sleeper = sleeper
        self._next_request_at = 0.0
        self._request_count = 0

    def get_page(self, page_id: str) -> dict:
        """Fetch one page object."""
        payload = self._request("GET", f"/pages/{page_id}")
        if not isinstance(payload, dict):
            raise NotionWikiError(f"Notion page {page_id} returned no object")
        return payload

    def list_block_children(self, block_id: str) -> list[dict]:
        """Fetch every child block, following the cursor."""
        return self._collect_list("GET", f"/blocks/{block_id}/children")

    def query_database(self, database_id: str) -> list[dict]:
        """Fetch every page in a child database."""
        return self._collect_list("POST", f"/databases/{database_id}/query")

    def block_tree(self, block_id: str) -> list[dict]:
        """Fetch blocks and attach nested children. Child pages stay as refs."""
        blocks = self.list_block_children(block_id)
        for block in blocks:
            block_type = block.get("type")
            if block.get("has_children") and block_type not in _CHILD_BLOCK_TYPES:
                block["children"] = self.block_tree(block["id"])
            else:
                block["children"] = []
        return blocks

    def _collect_list(self, method: str, path: str) -> list[dict]:
        results: list[dict] = []
        cursor: str | None = None
        while True:
            payload = self._request(method, path, cursor=cursor)
            batch = payload.get("results") or []
            results.extend(item for item in batch if isinstance(item, dict))
            if not payload.get("has_more"):
                return results
            cursor = payload.get("next_cursor")
            if not cursor:
                return results

    def _request(self, method: str, path: str, *, cursor: str | None = None) -> dict:
        params: dict[str, Any] | None = {"page_size": 100}
        json_body: dict[str, Any] | None = None
        if method == "POST":
            json_body = {"page_size": 100}
            params = None
            if cursor:
                json_body["start_cursor"] = cursor
        elif cursor:
            params = {"page_size": 100, "start_cursor": cursor}

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        }
        url = f"{NOTION_API_BASE}{path}"
        last_status = 0
        for attempt in range(5):
            self._pace()
            self._note_request(path)
            try:
                response = self._transport(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=json_body,
                    timeout=30,
                )
            except _TRANSIENT_REQUEST_ERRORS as error:
                last_status = 0
                logger.warning(
                    "Notion request failed for %s (%s). Attempt %s of 5.",
                    path,
                    type(error).__name__,
                    attempt + 1,
                )
                self._sleeper(min(8.0, 0.5 * (2**attempt)))
                continue
            last_status = getattr(response, "status_code", 0)
            if last_status == 429 or last_status >= 500:
                self._sleeper(self._retry_delay(response, attempt))
                continue
            if last_status >= 400:
                detail = _response_text(response)[:500]
                raise NotionWikiError(
                    f"Notion API {last_status} for {path}: {detail}",
                    status_code=last_status,
                )
            try:
                payload = response.json()
            except ValueError:
                logger.warning(
                    "Notion returned invalid JSON for %s. Attempt %s of 5.",
                    path,
                    attempt + 1,
                )
                self._sleeper(min(8.0, 0.5 * (2**attempt)))
                continue
            if not isinstance(payload, dict):
                raise NotionWikiError(f"Notion API returned a non-object for {path}")
            return payload
        raise NotionWikiError(
            f"Notion API {last_status or 'network'} for {path} persisted after retries",
            status_code=last_status or None,
            transient=True,
        )

    def _note_request(self, path: str) -> None:
        self._request_count += 1
        count = self._request_count
        if count == 1 or count % _PROGRESS_EVERY_REQUESTS == 0:
            logger.info("Notion API requests: %s latest %s", count, path)

    def _pace(self) -> None:
        now = time.monotonic()
        if now < self._next_request_at:
            self._sleeper(self._next_request_at - now)
        self._next_request_at = time.monotonic() + self._min_interval_seconds

    def _retry_delay(self, response: Any, attempt: int) -> float:
        header = ""
        headers = getattr(response, "headers", None) or {}
        if hasattr(headers, "get"):
            header = str(headers.get("Retry-After") or "")
        try:
            return max(float(header), 0.34)
        except ValueError:
            return min(8.0, 0.5 * (2**attempt))


def _response_text(response: Any) -> str:
    text = getattr(response, "text", "")
    return text if isinstance(text, str) else ""
