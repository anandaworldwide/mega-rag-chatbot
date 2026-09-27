#!/usr/bin/env python3
"""
Processes a WordPress MySQL dump file for import into a new, dated database.

This script takes a MySQL dump file from a WordPress installation, modifies it
to use a new database name (generated based on the current date), adds specific
SQL commands for character set conversion and table modifications, and then
imports the processed data into a new MySQL database using the mysql command-line
tool. It is intended as an optional preparatory step before ingesting WordPress
content into the main application's vector store using other scripts.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime


def print_usage():
    """Prints usage instructions and exits."""
    print("Usage: process_anandalib_dump.py [-u username] <sql_dump_file>")
    sys.exit(1)


def get_new_db_name() -> str:
    """Generates a unique database name based on the current date.

    Returns:
        str: A database name string in the format 'anandalib_YYYY_MM_DD'.
    """
    # Generate database name with format anandalib-YYYY-DD-MM
    today = datetime.now()
    return f"anandalib_{today.year}_{today.month:02d}_{today.day:02d}"


def process_sql_file(input_file: str, new_db_name: str) -> str:
    """Processes the input SQL dump file for import.

    Reads the input SQL file line by line, replaces references to the old
    database name with the new one, adds header SQL commands (like setting
    SQL mode and altering the database character set), and appends footer
    SQL commands (like altering table structures and adding columns).

    Args:
        input_file (str): Path to the original SQL dump file.
        new_db_name (str): The new database name to use.

    Returns:
        str: The path to the temporary file containing the processed SQL.
    """
    # Create temp file for processed SQL
    with tempfile.NamedTemporaryFile(
        mode="w", delete=False, suffix=".sql"
    ) as temp_file:
        temp_filename = temp_file.name

        # Add header configurations to ensure UTF8 compatibility and set SQL mode
        header = f"""-- turn off strict dates and switch to UTF8
SET sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
ALTER DATABASE {new_db_name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

use {new_db_name};

"""
        temp_file.write(header)

        # Process the input file line by line
        with open(input_file, encoding="utf-8") as infile:
            for line in infile:
                # Replace old database name references (USE and CREATE DATABASE)
                line = re.sub(r"USE `anandalib[^`]*`", f"USE `{new_db_name}`", line)
                line = re.sub(
                    r"CREATE DATABASE .*anandalib[^`]*`",
                    f"CREATE DATABASE `{new_db_name}`",
                    line,
                )
                temp_file.write(line)

        # Add footer modifications for the wp_posts table
        # These convert character sets, modify date columns, drop unused columns,
        # and add new columns needed for later processing (permalink, author_name).
        footer = """
ALTER TABLE wp_posts
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE wp_posts
  MODIFY post_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Get rid of columns we don't need that have problematic data
ALTER TABLE wp_posts
DROP COLUMN post_date_gmt,
DROP COLUMN post_modified,
DROP COLUMN post_modified_gmt;

-- Add the new columns
ALTER TABLE wp_posts
  ADD COLUMN permalink VARCHAR(400),
  ADD COLUMN author_name VARCHAR(255);
"""
        temp_file.write(footer)

    return temp_filename


def _mysql_option_value(value: str) -> str:
    """Quote a client option so #, quotes, and newlines stay inside the value."""
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _write_mysql_defaults(username: str, password: str, host: str, port: int) -> str:
    """Write a 0600 client defaults file so mysql does not prompt for a password."""
    fd, path = tempfile.mkstemp(prefix="anandalib-mysql-", text=True)
    os.chmod(path, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(
            "\n".join(
                [
                    "[client]",
                    f"user={_mysql_option_value(username)}",
                    f"password={_mysql_option_value(password)}",
                    f"host={_mysql_option_value(host)}",
                    f"port={port}",
                    "",
                ]
            )
        )
    return path


def import_database(
    sql_file: str,
    db_name: str,
    username: str,
    *,
    password: str | None = None,
    host: str = "127.0.0.1",
    port: int = 3306,
    runner=subprocess.run,
):
    """Imports the processed SQL file into a new MySQL database.

    Creates the target database if it doesn't exist and then uses the
    mysql command-line tool to import the data from the processed SQL file.
    A password uses a defaults file. Without one, mysql prompts via ``-p``.

    Args:
        sql_file (str): Path to the processed SQL file.
        db_name (str): Name of the database to import into.
        username (str): MySQL username for authentication.
        password: MySQL password. Omit to prompt interactively.
        host: MySQL host.
        port: MySQL port.
        runner: Command runner, defaulting to subprocess.run.

    Raises:
        RuntimeError: If database creation or import fails.
    """
    defaults_path = None
    if password is None:
        mysql_base = ["mysql", "-u", username, "-h", host, "-P", str(port), "-p"]
    else:
        defaults_path = _write_mysql_defaults(username, password, host, port)
        mysql_base = ["mysql", f"--defaults-extra-file={defaults_path}"]
    try:
        runner(
            [
                *mysql_base,
                "-e",
                f"CREATE DATABASE IF NOT EXISTS `{db_name}`",
            ],
            check=True,
        )
        with open(sql_file, encoding="utf-8") as sql_handle:
            runner([*mysql_base, db_name], stdin=sql_handle, check=True, text=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"MySQL import failed: {exc}") from exc
    finally:
        if defaults_path is not None:
            os.unlink(defaults_path)


def import_ananda_library_dump(
    sql_file: str,
    username: str,
    *,
    password: str | None,
    host: str = "127.0.0.1",
    port: int = 3306,
    db_name: str | None = None,
    runner=subprocess.run,
) -> str:
    """Process a dump and import it. Returns the dated database name."""
    database_name = db_name or get_new_db_name()
    processed_file = process_sql_file(sql_file, database_name)
    try:
        import_database(
            processed_file,
            database_name,
            username,
            password=password,
            host=host,
            port=port,
            runner=runner,
        )
    finally:
        os.unlink(processed_file)
    return database_name


def main():
    """Main execution function.

    Parses command-line arguments, validates the input file, generates the
    new database name, calls functions to process the SQL file and import it,
    and cleans up the temporary file.
    """
    # Set up argument parser for command-line options
    parser = argparse.ArgumentParser(
        description="Process and import Ananda library SQL dump"
    )
    parser.add_argument(
        "-u", "--user", default="root", help="MySQL username (default: root)"
    )
    parser.add_argument("sql_file", help="SQL dump file to process")

    # Parse arguments provided by the user
    args = parser.parse_args()

    input_file = args.sql_file
    username = args.user

    # Verify input file exists before proceeding
    if not os.path.exists(input_file):
        print(f"Error: File '{input_file}' not found")
        sys.exit(1)

    password = os.environ.get("DB_PASSWORD")
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = int(os.environ.get("DB_PORT", "3306"))

    print(f"Processing SQL dump file: {input_file}")
    print(f"Using MySQL username: {username}")
    print(f"Using MySQL host: {host}:{port}")
    if password:
        print("Using DB_PASSWORD from the environment.")
    else:
        print("DB_PASSWORD is not set. mysql will prompt.")

    try:
        print("Importing processed SQL file...")
        new_db_name = import_ananda_library_dump(
            input_file,
            username,
            password=password,
            host=host,
            port=port,
        )
        print(f"Successfully imported database as: {new_db_name}")

    except Exception as e:
        # Catch any other unexpected errors during processing or import
        print(f"Error processing database: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
