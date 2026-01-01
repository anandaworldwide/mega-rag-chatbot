#!/usr/bin/env python3
"""
Email operations utilities for sending operational alerts via AWS SES.

This module provides utilities for sending operational alerts via email.
It uses AWS SES for email delivery and supports multiple recipient addresses.

Usage:
    from pyutil.email_ops import send_ops_alert

    await send_ops_alert(
        subject="Crawler Alert",
        message="Crawler has been wedged for 90 minutes",
        error_details={
            "error": exception_object,
            "context": {"site_id": "ananda-public", "minutes_since_activity": 90},
            "stack": traceback_string
        }
    )
"""

import asyncio
import json
import logging
import os
import traceback
from datetime import datetime
from typing import Any

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    AWS_AVAILABLE = True
except ImportError:
    AWS_AVAILABLE = False

logger = logging.getLogger(__name__)


def _validate_email_config() -> list[str] | None:
    """Validate email configuration and return recipient list."""
    ops_email = os.getenv("OPS_ALERT_EMAIL")
    if not ops_email:
        logger.error("OPS_ALERT_EMAIL environment variable is not set")
        return None

    # Split multiple email addresses by semicolon
    recipient_emails = [
        email.strip() for email in ops_email.split(";") if email.strip()
    ]

    if not recipient_emails:
        logger.error("No valid email addresses found in OPS_ALERT_EMAIL")
        return None

    return recipient_emails


def _should_suppress_alert(subject: str) -> bool:
    """Check if alert should be suppressed (test mode)."""
    if os.getenv("NODE_ENV") == "test" or os.getenv("PYTEST_CURRENT_TEST"):
        logger.info(f"[TEST MODE] Suppressing ops alert: {subject}")
        return True
    return False


def _build_email_body(message: str, error_details: dict[str, Any] | None) -> str:
    """Build complete email body with error details and system info."""
    email_body = message

    if error_details:
        email_body += "\n\n--- Error Details ---\n"

        if error_details.get("error"):
            error = error_details["error"]
            email_body += f"Error: {str(error)}\n"
            email_body += f"Type: {type(error).__name__}\n"

        if error_details.get("stack"):
            email_body += f"Stack Trace:\n{error_details['stack']}\n"

        if error_details.get("context"):
            email_body += f"Context: {json.dumps(error_details['context'], indent=2)}\n"

    # Add timestamp and environment info
    email_body += "\n\n--- System Info ---\n"
    email_body += f"Timestamp: {datetime.now().isoformat()}\n"
    email_body += f"Environment: {os.getenv('NODE_ENV', 'unknown')}\n"
    email_body += f"Site ID: {os.getenv('SITE_ID', 'unknown')}\n"
    email_body += f"Python Version: {os.sys.version}\n"

    return email_body


def _format_subject_line(subject: str) -> str:
    """Format subject line with environment and site prefix."""
    # If subject already starts with '[', assume it's already formatted (e.g., from crawler)
    if subject.startswith("["):
        return subject

    environment = "prod" if os.getenv("NODE_ENV") == "production" else "dev"
    site_name = os.getenv("SITE_ID", "unknown")
    return f"[{environment.upper()}-{site_name}] {subject}"


async def send_ops_alert(
    subject: str, message: str, error_details: dict[str, Any] | None = None
) -> bool:
    """
    Sends an operational alert email to the configured ops team.

    Args:
        subject: Email subject line
        message: Email body content
        error_details: Optional error details to include in the email
            - error: Exception object
            - context: Dict with additional context information
            - stack: Stack trace string

    Returns:
        bool: True if email was sent successfully, false otherwise
    """
    try:
        # Validate configuration
        recipient_emails = _validate_email_config()
        if not recipient_emails:
            return False

        # Check for test mode suppression
        if _should_suppress_alert(subject):
            return True

        if not AWS_AVAILABLE:
            logger.error("boto3 not available - cannot send email alerts")
            return False

        # Build email content
        email_body = _build_email_body(message, error_details)
        formatted_subject = _format_subject_line(subject)

        # Create SES client
        ses_client = boto3.client(
            "ses",
            region_name=os.getenv("AWS_REGION", "us-east-1"),
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )

        # Send email to all recipients
        response = ses_client.send_email(
            Source=os.getenv("CONTACT_EMAIL", "noreply@ananda.org"),
            Destination={"ToAddresses": recipient_emails},
            Message={
                "Subject": {"Data": formatted_subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": email_body, "Charset": "UTF-8"}},
            },
        )

        message_id = response.get("MessageId")
        logger.info(f"Ops alert sent successfully. MessageId: {message_id}")
        logger.info(f"Recipients: {', '.join(recipient_emails)}")

        return True

    except (BotoCoreError, ClientError) as aws_error:
        logger.error(f"AWS SES error sending ops alert: {aws_error}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error sending ops alert: {e}")
        logger.error(f"Stack trace: {traceback.format_exc()}")
        return False


def send_ops_alert_sync(
    subject: str, message: str, error_details: dict[str, Any] | None = None
) -> bool:
    """
    Synchronous wrapper for send_ops_alert.

    This is useful when calling from synchronous code that can't use async/await.

    Args:
        subject: Email subject line
        message: Email body content
        error_details: Optional error details to include in the email

    Returns:
        bool: True if email was sent successfully, false otherwise
    """
    try:
        # Create new event loop if none exists
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        # Run the async function
        return loop.run_until_complete(send_ops_alert(subject, message, error_details))
    except Exception as e:
        logger.error(f"Error in synchronous ops alert wrapper: {e}")
        return False


if __name__ == "__main__":
    # Test script - only runs if executed directly
    import sys

    if len(sys.argv) < 2:
        print("Usage: python email_ops.py <test_message>")
        sys.exit(1)

    test_message = sys.argv[1]

    # Test sending an alert
    success = send_ops_alert_sync(
        subject="Test Alert from Python",
        message=test_message,
        error_details={
            "context": {"test": True, "timestamp": datetime.now().isoformat()}
        },
    )

    if success:
        print("Test alert sent successfully")
    else:
        print("Failed to send test alert")
        sys.exit(1)
