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


def import_database(sql_file: str, db_name: str, username: str):
    """Imports the processed SQL file into a new MySQL database.

    Creates the target database if it doesn't exist and then uses the
    mysql command-line tool to import the data from the processed SQL file.
    Requires the user to enter their MySQL password when prompted.

    Args:
        sql_file (str): Path to the processed SQL file.
        db_name (str): Name of the database to import into.
        username (str): MySQL username for authentication.

    Raises:
        SystemExit: If database creation or import fails.
    """
    # Create database using mysql command line
    # Critical security fix - never use shell=True with variable interpolation
    create_db_cmd = [
        "mysql",
        "-u",
        username,
        "-p",
        "-e",
        f"CREATE DATABASE IF NOT EXISTS `{db_name}`",
    ]
    try:
        # Run the command, checking for errors
        subprocess.run(create_db_cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error creating database: {e}")
        sys.exit(1)

    # Import processed SQL file using mysql command line
    # Critical security fix - use stdin instead of shell redirection
    import_cmd = ["mysql", "-u", username, "-p", db_name]
    try:
        # Run the command with SQL file as stdin, checking for errors
        with open(sql_file, encoding="utf-8") as f:
            subprocess.run(import_cmd, stdin=f, check=True, text=True)
    except subprocess.CalledProcessError as e:
        print(f"Error importing database: {e}")
        sys.exit(1)


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

    # Generate new database name based on current date
    new_db_name = get_new_db_name()

    print(f"Processing SQL dump file: {input_file}")
    print(f"Creating new database: {new_db_name}")
    print(f"Using MySQL username: {username}")

    try:
        # Process the SQL file, creating a temporary processed file
        processed_file = process_sql_file(input_file, new_db_name)

        # Import the processed file into the new database
        print("Importing processed SQL file...")
        import_database(processed_file, new_db_name, username)

        # Clean up by removing the temporary processed SQL file
        os.unlink(processed_file)

        print(f"Successfully imported database as: {new_db_name}")

    except Exception as e:
        # Catch any other unexpected errors during processing or import
        print(f"Error processing database: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
