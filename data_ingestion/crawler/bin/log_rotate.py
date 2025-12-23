#!/usr/bin/env python
"""
Log rotation script for Ananda Crawler logs
Compresses and removes old log files to prevent disk space issues
"""

import argparse
import gzip
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path


class LogRotator:
    """Handles log rotation for crawler logs."""

    def __init__(self, log_dir: str, max_age_days: int = 30, compress: bool = True):
        self.log_dir = Path(log_dir)
        self.max_age_days = max_age_days
        self.compress = compress
        self.logger = logging.getLogger(__name__)

        # Setup basic logging to console
        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
        )

    def get_log_files(self):
        """Get all log files in the directory."""
        if not self.log_dir.exists():
            self.logger.warning(f"Log directory does not exist: {self.log_dir}")
            return []

        return list(self.log_dir.glob("*.log"))

    def should_rotate_file(self, file_path: Path) -> bool:
        """Check if a file should be rotated based on age."""
        try:
            stat = file_path.stat()
            file_age = datetime.now() - datetime.fromtimestamp(stat.st_mtime)
            return file_age.days > self.max_age_days
        except OSError as e:
            self.logger.warning(f"Could not check age of {file_path}: {e}")
            return False

    def rotate_file(self, file_path: Path):
        """Rotate a single log file."""
        try:
            # Create timestamp for the rotated file
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            rotated_name = f"{file_path.stem}_{timestamp}.log"

            if self.compress:
                rotated_name += ".gz"
                rotated_path = file_path.parent / rotated_name

                # Compress the file
                with (
                    open(file_path, "rb") as f_in,
                    gzip.open(rotated_path, "wb") as f_out,
                ):
                    shutil.copyfileobj(f_in, f_out)

                self.logger.info(f"Compressed {file_path} to {rotated_path}")
            else:
                rotated_path = file_path.parent / rotated_name
                shutil.move(file_path, rotated_path)
                self.logger.info(f"Moved {file_path} to {rotated_path}")

            # Remove the original file
            if file_path.exists():
                file_path.unlink()

        except Exception as e:
            self.logger.error(f"Failed to rotate {file_path}: {e}")

    def cleanup_old_rotated_files(self, max_files: int = 10):
        """Clean up old rotated files, keeping only the most recent ones."""
        try:
            # Get all rotated log files (compressed and uncompressed)
            rotated_files = []
            for pattern in ["*.log.gz", "*_*.log"]:
                rotated_files.extend(list(self.log_dir.glob(pattern)))

            # Group by base name
            file_groups = {}
            for f in rotated_files:
                base_name = f.name.split("_")[0] if "_" in f.name else f.stem
                if base_name not in file_groups:
                    file_groups[base_name] = []
                file_groups[base_name].append(f)

            # Sort and cleanup each group
            for files in file_groups.values():
                # Sort by modification time (newest first)
                files.sort(key=lambda x: x.stat().st_mtime, reverse=True)

                # Remove old files beyond the limit
                for old_file in files[max_files:]:
                    try:
                        old_file.unlink()
                        self.logger.info(f"Removed old rotated file: {old_file}")
                    except Exception as e:
                        self.logger.warning(f"Failed to remove {old_file}: {e}")

        except Exception as e:
            self.logger.error(f"Failed to cleanup old rotated files: {e}")

    def rotate_logs(self):
        """Main log rotation function."""
        self.logger.info(f"Starting log rotation in {self.log_dir}")
        self.logger.info(
            f"Max age: {self.max_age_days} days, Compress: {self.compress}"
        )

        log_files = self.get_log_files()
        if not log_files:
            self.logger.info("No log files found")
            return

        rotated_count = 0
        for log_file in log_files:
            if self.should_rotate_file(log_file):
                self.rotate_file(log_file)
                rotated_count += 1

        self.logger.info(f"Rotated {rotated_count} log files")

        # Cleanup old rotated files
        self.cleanup_old_rotated_files()

        self.logger.info("Log rotation completed")


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="Rotate Ananda Crawler logs")
    parser.add_argument(
        "--log-dir",
        default="~/Library/Logs/AnandaCrawler",
        help="Log directory to rotate (default: ~/Library/Logs/AnandaCrawler)",
    )
    parser.add_argument(
        "--max-age-days",
        type=int,
        default=30,
        help="Maximum age in days for log files before rotation (default: 30)",
    )
    parser.add_argument(
        "--no-compress", action="store_true", help="Don't compress rotated files"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without actually rotating files",
    )

    return parser.parse_args()


def main():
    args = parse_arguments()

    # Expand user path
    log_dir = os.path.expanduser(args.log_dir)

    rotator = LogRotator(
        log_dir=log_dir, max_age_days=args.max_age_days, compress=not args.no_compress
    )

    if args.dry_run:
        print("DRY RUN - Would rotate files in:", log_dir)
        files = rotator.get_log_files()
        print(f"Found {len(files)} log files:")
        for f in files:
            should_rotate = rotator.should_rotate_file(f)
            status = "WOULD ROTATE" if should_rotate else "KEEP"
            print(f"  {f.name}: {status}")
    else:
        rotator.rotate_logs()


if __name__ == "__main__":
    main()
