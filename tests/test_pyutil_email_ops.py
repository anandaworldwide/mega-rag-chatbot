#!/usr/bin/env python3
"""
Tests for pyutil.email_ops module.

This module tests the email operations functionality including:
- Basic email sending
- Error handling
- Test environment suppression
- Rate limiting
- Convenience functions
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Add project root to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_ingestion.crawler.crawler_alerts import send_crawler_wedged_alert
from pyutil.email_ops import send_ops_alert_sync


class TestEmailOps(unittest.TestCase):
    """Test cases for email operations functionality."""

    def setUp(self):
        """Set up test environment."""
        # Clear any existing environment variables that might interfere
        self.original_env = {}
        env_vars = [
            "OPS_ALERT_EMAIL",
            "NODE_ENV",
            "PYTEST_CURRENT_TEST",
            "AWS_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "CONTACT_EMAIL",
            "SITE_ID",
        ]

        for var in env_vars:
            self.original_env[var] = os.getenv(var)
            if var in os.environ:
                del os.environ[var]

    def tearDown(self):
        """Clean up test environment."""
        # Restore original environment variables
        for var, value in self.original_env.items():
            if value is not None:
                os.environ[var] = value
            elif var in os.environ:
                del os.environ[var]

    def test_missing_ops_email_env_var(self):
        """Test that missing OPS_ALERT_EMAIL returns False."""
        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertFalse(result)

    def test_empty_ops_email_env_var(self):
        """Test that empty OPS_ALERT_EMAIL returns False."""
        os.environ["OPS_ALERT_EMAIL"] = ""
        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertFalse(result)

    def test_invalid_ops_email_format(self):
        """Test that invalid email format in OPS_ALERT_EMAIL returns False."""
        os.environ["OPS_ALERT_EMAIL"] = ";;;"
        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertFalse(result)

    def test_test_mode_suppression_node_env(self):
        """Test that test mode suppresses emails when NODE_ENV=test."""
        os.environ["OPS_ALERT_EMAIL"] = "test@example.com"
        os.environ["NODE_ENV"] = "test"

        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertTrue(result)  # Should return True but not actually send

    def test_test_mode_suppression_pytest(self):
        """Test that test mode suppresses emails when PYTEST_CURRENT_TEST is set."""
        os.environ["OPS_ALERT_EMAIL"] = "test@example.com"
        os.environ["PYTEST_CURRENT_TEST"] = (
            "test_email_ops.py::TestEmailOps::test_something"
        )

        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertTrue(result)  # Should return True but not actually send

    @patch("pyutil.email_ops.AWS_AVAILABLE", False)
    def test_missing_boto3_dependency(self):
        """Test that missing boto3 returns False."""
        os.environ["OPS_ALERT_EMAIL"] = "test@example.com"

        result = send_ops_alert_sync("Test Subject", "Test Message")
        self.assertFalse(result)

    @patch("pyutil.email_ops.AWS_AVAILABLE", True)
    @patch("pyutil.email_ops.boto3")
    def test_successful_email_send(self, mock_boto3):
        """Test successful email sending."""
        # Set up environment
        os.environ["OPS_ALERT_EMAIL"] = "ops@example.com"
        os.environ["AWS_REGION"] = "us-east-1"
        os.environ["AWS_ACCESS_KEY_ID"] = "test_key"
        os.environ["AWS_SECRET_ACCESS_KEY"] = "test_secret"
        os.environ["CONTACT_EMAIL"] = "noreply@example.com"
        os.environ["SITE_ID"] = "test-site"

        # Mock SES client
        mock_ses_client = MagicMock()
        mock_ses_client.send_email.return_value = {"MessageId": "test-message-id"}
        mock_boto3.client.return_value = mock_ses_client

        result = send_ops_alert_sync(
            "Test Alert",
            "This is a test message",
            {"context": {"test": True}, "error": ValueError("Test error")},
        )

        self.assertTrue(result)

        # Verify SES client was created correctly
        mock_boto3.client.assert_called_once_with(
            "ses",
            region_name="us-east-1",
            aws_access_key_id="test_key",
            aws_secret_access_key="test_secret",
        )

        # Verify email was sent
        mock_ses_client.send_email.assert_called_once()
        call_args = mock_ses_client.send_email.call_args[1]

        self.assertEqual(call_args["Source"], "noreply@example.com")
        self.assertEqual(call_args["Destination"]["ToAddresses"], ["ops@example.com"])
        self.assertIn(
            "[DEV-test-site] Test Alert", call_args["Message"]["Subject"]["Data"]
        )

        # Check that error details are included in body
        email_body = call_args["Message"]["Body"]["Text"]["Data"]
        self.assertIn("This is a test message", email_body)
        self.assertIn("--- Error Details ---", email_body)
        self.assertIn("Test error", email_body)
        self.assertIn("ValueError", email_body)
        self.assertIn("Context:", email_body)
        self.assertIn('"test": true', email_body)

    @patch("data_ingestion.crawler.crawler_alerts.send_ops_alert_sync")
    def test_crawler_wedged_alert_convenience_function(self, mock_send):
        """Test the crawler wedged alert convenience function."""
        mock_send.return_value = True

        result = send_crawler_wedged_alert("test-site", 90)

        self.assertTrue(result)
        mock_send.assert_called_once()

        # Check the call arguments
        call_args = mock_send.call_args
        self.assertEqual(call_args[1]["subject"], "🔴 Crawler Wedged")
        self.assertIn("test-site", call_args[1]["message"])
        self.assertIn("90 minutes", call_args[1]["message"])

        # Check error details context
        error_details = call_args[1]["error_details"]
        self.assertEqual(error_details["context"]["site_id"], "test-site")
        self.assertEqual(error_details["context"]["minutes_since_activity"], 90)


if __name__ == "__main__":
    # Run tests
    unittest.main(verbosity=2)
