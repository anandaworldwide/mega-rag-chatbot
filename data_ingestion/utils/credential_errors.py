"""Stop the process when an API key is rejected.

A bad OpenAI or Pinecone key fails every later call. Retrying chunks only
repeats the same 401.
"""

import logging
import os

logger = logging.getLogger(__name__)

_CREDENTIAL_MARKERS = (
    "incorrect api key",
    "invalid api key",
    "invalid_api_key",
    "unauthenticated",
)


def is_credential_error(error: BaseException) -> bool:
    """True when OpenAI or Pinecone rejected the API key."""
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(error, "status", None)
    if status == 401:
        return True
    if type(error).__name__ in {"UnauthorizedException", "AuthenticationError"}:
        return True
    text = str(error).lower()
    return any(marker in text for marker in _CREDENTIAL_MARKERS)


def abort_on_credential_error(error: BaseException) -> None:
    """Log a rejected API key and end the process. Other errors return."""
    if not is_credential_error(error):
        return
    logger.error("Stopping. API credentials were rejected: %s", error)
    os._exit(1)
