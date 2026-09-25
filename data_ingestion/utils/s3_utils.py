import logging
import os
import random
import tempfile
import time
from collections import defaultdict

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


class S3UploadError(Exception):
    """Custom exception for S3 upload errors."""

    pass


class S3DownloadError(Exception):
    """Custom exception for S3 download errors."""

    pass


def get_s3_client():
    return boto3.client("s3")


def get_bucket_name():
    return os.getenv("S3_BUCKET_NAME")


def exponential_backoff(attempt):
    return min(5, (2**attempt) + random.uniform(0, 1))


def file_exists_with_same_size(s3_client, bucket_name, s3_key, local_file_path):
    """
    Check if file exists in S3 with the same size as local file.

    Args:
        s3_client: Boto3 S3 client
        bucket_name: S3 bucket name
        s3_key: S3 object key
        local_file_path: Path to local file

    Returns:
        bool: True if file exists in S3 with same size, False otherwise
    """
    try:
        # Get local file size
        local_size = os.path.getsize(local_file_path)

        # Check if object exists in S3 and get its size
        response = s3_client.head_object(Bucket=bucket_name, Key=s3_key)
        s3_size = response["ContentLength"]

        if local_size == s3_size:
            return True
        else:
            logger.info(
                f"File {s3_key} exists in S3 but size differs (local: {local_size}, S3: {s3_size} bytes)"
            )
            return False

    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            # File doesn't exist in S3
            return False
        else:
            # Other error occurred
            logger.warning(f"Error checking S3 file {s3_key}: {e}")
            return False
    except OSError as e:
        logger.error(f"Error getting local file size for {local_file_path}: {e}")
        return False


def upload_to_s3(file_path, s3_key, max_attempts=5, overwrite=False):
    """
    Upload file to S3, skipping if file already exists with same size (unless overwrite=True).

    Args:
        file_path: Path to local file
        s3_key: S3 object key
        max_attempts: Maximum retry attempts
        overwrite: If True, upload even if file already exists

    Returns:
        bool: True if file was uploaded, False if skipped (already exists with same size)

    Raises:
        S3UploadError: If upload fails after all attempts
        ValueError: If s3_key is not provided
    """
    if not s3_key:
        raise ValueError("s3_key must be provided")

    s3_client = get_s3_client()
    bucket_name = get_bucket_name()

    # Check if file already exists with same size (unless overwrite is True)
    if not overwrite and file_exists_with_same_size(
        s3_client, bucket_name, s3_key, file_path
    ):
        return False

    for attempt in range(max_attempts):
        try:
            s3_client.upload_file(file_path, bucket_name, s3_key)
            logger.info(f"Successfully uploaded {file_path} to {bucket_name}/{s3_key}")
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "RequestTimeTooSkewed":
                if attempt < max_attempts - 1:
                    wait_time = exponential_backoff(attempt)
                    logger.info(
                        f"RequestTimeTooSkewed error. Retrying in {wait_time:.2f} seconds..."
                    )
                    time.sleep(wait_time)
                else:
                    error_message = f"Failed to upload {file_path} after {max_attempts} attempts: {str(e)}"
                    logger.error(error_message)
                    raise S3UploadError(error_message) from e
            else:
                error_message = f"Error uploading {file_path}: {str(e)}"
                logger.error(error_message)
                raise S3UploadError(error_message) from e


def download_s3_object_to_file(s3_key, dest_path, max_attempts=5):
    """Download an S3 object to dest_path."""
    if not s3_key:
        raise ValueError("s3_key must be provided")

    s3_client = get_s3_client()
    bucket_name = get_bucket_name()
    if not bucket_name:
        raise S3DownloadError("S3_BUCKET_NAME is not set")

    parent = os.path.dirname(os.path.abspath(dest_path))
    if parent:
        os.makedirs(parent, exist_ok=True)

    for attempt in range(max_attempts):
        try:
            s3_client.download_file(bucket_name, s3_key, dest_path)
            logger.info(f"Downloaded s3://{bucket_name}/{s3_key} to {dest_path}")
            return dest_path
        except ClientError as e:
            if (
                e.response["Error"]["Code"] == "RequestTimeTooSkewed"
                and attempt < max_attempts - 1
            ):
                wait_time = exponential_backoff(attempt)
                logger.info(
                    f"RequestTimeTooSkewed error. Retrying in {wait_time:.2f} seconds..."
                )
                time.sleep(wait_time)
                continue
            error_message = f"Error downloading {s3_key}: {str(e)}"
            logger.error(error_message)
            raise S3DownloadError(error_message) from e

    raise S3DownloadError(f"Failed to download {s3_key} after {max_attempts} attempts")


def download_s3_object_to_temp(s3_key):
    """Download an S3 object to a temporary file. Caller must delete it."""
    suffix = os.path.splitext(s3_key)[1] or ".mp3"
    fd, temp_path = tempfile.mkstemp(prefix="ingest-audio-", suffix=suffix)
    os.close(fd)
    try:
        download_s3_object_to_file(s3_key, temp_path)
    except Exception:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise
    return temp_path


def check_unique_filenames(directory_path):  # noqa: C901
    s3_client = get_s3_client()
    bucket_name = get_bucket_name()
    local_files = defaultdict(list)
    s3_files = set()
    conflicts = defaultdict(list)

    # Collect local files
    for root, _, files in os.walk(directory_path):
        for file in files:
            if file.lower().endswith((".mp3", ".wav", ".flac", ".mp4", ".avi", ".mov")):
                local_files[file].append(os.path.join(root, file))

    # Collect S3 files
    try:
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket_name, Prefix="public/"):
            for obj in page.get("Contents", []):
                s3_files.add(os.path.basename(obj["Key"]))
    except ClientError as e:
        logger.error(f"Error accessing S3 bucket: {e}")
        return {}

    # Check for conflicts with S3
    for file in local_files:
        if file in s3_files:
            file_type = (
                "audio" if file.lower().endswith((".mp3", ".wav", ".flac")) else "video"
            )
            conflicts[file].append(f"S3: public/{file_type}/{file}")

    # Check for local conflicts
    for file, paths in local_files.items():
        if len(paths) > 1:
            conflicts[file].extend(paths)

    return conflicts
