#!/usr/bin/env python3
# This script cancels all building or queued Vercel deployments except for a specified project.
# It includes a safety check for recent commits from other users and provides detailed feedback.

import argparse
import datetime
import getpass
import os
import re
import shlex
import subprocess
import sys


def strip_ansi_codes(text):
    """Remove ANSI escape codes from text."""
    return re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", text)


def run_command(cmd, debug=False):
    """Run a shell command and return its output.

    Critical security fix - never use shell=True with variable interpolation.
    Safely parse command string into list using shlex.split().
    """
    env = os.environ.copy()
    env["FORCE_COLOR"] = "1"
    env["TERM"] = "xterm-256color"

    # Critical security fix - parse command string safely into list
    # shlex.split() handles quoted arguments correctly
    cmd_list = shlex.split(cmd) if isinstance(cmd, str) else cmd

    result = subprocess.run(
        cmd_list, capture_output=True, text=True, env=env, shell=False
    )
    output = result.stdout + result.stderr

    if debug:
        print(f"DEBUG: Command: {cmd}")
        print(f"DEBUG: Command list: {cmd_list}")
        print(f"DEBUG: Return code: {result.returncode}")

    return {
        "output": output,
        "stripped_output": strip_ansi_codes(output),
        "return_code": result.returncode,
    }


def check_recent_commits(force=False, debug=False):
    """Check if there are recent commits from other users in the last hour."""
    if force:
        return True

    # Get current user info
    git_user_result = run_command("git config user.name", debug)
    if git_user_result["return_code"] != 0:
        print("⚠️  Unable to get Git username. You may not be in a Git repository.")
        return True

    git_username = git_user_result["stripped_output"].strip()
    system_username = getpass.getuser()

    if debug:
        print(f"DEBUG: Git username: {git_username}")
        print(f"DEBUG: System username: {system_username}")

    # Get commits from the last hour
    one_hour_ago = (datetime.datetime.now() - datetime.timedelta(hours=1)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    commit_result = run_command(f'git log --since="{one_hour_ago}" --format=%an', debug)

    if commit_result["return_code"] != 0:
        print("⚠️  Unable to check recent commits. Continuing...")
        return True

    # Extract committer names
    committers = [
        name.strip()
        for name in commit_result["stripped_output"].split("\n")
        if name.strip()
    ]
    unique_committers = set(committers)

    # Identify other committers
    other_committers = []
    for committer in unique_committers:
        if (
            committer.lower() != git_username.lower()
            and committer.lower() != system_username.lower()
        ):
            other_committers.append(committer)

    if other_committers:
        print("⚠️  WARNING! Other users have committed code in the last hour:")
        for committer in other_committers:
            print(f"   - {committer}")

        response = input("Do you want to continue anyway? (y/n): ").strip().lower()
        return response == "y"

    return True


def get_vercel_projects(debug=False):
    """Get list of Vercel projects."""
    result = run_command("vercel projects ls", debug)

    if debug:
        print("DEBUG: Full vercel projects ls output:")
        print(result["stripped_output"])

    # Parse project names
    lines = result["stripped_output"].split("\n")
    projects = []

    for line in lines:
        # Skip empty lines and header lines
        if (
            not line.strip()
            or "Fetching projects" in line
            or "Project Name" in line
            or "Vercel CLI" in line
            or "----" in line
            or "Updated" in line
            or "Projects found" in line
        ):
            continue

        # Extract the project name (first column)
        parts = line.strip().split()
        if parts:
            projects.append(parts[0])

    if not projects:
        print("❌ Error: Could not detect Vercel projects")
        sys.exit(1)

    return projects


def cancel_deployment(project, skip_project, debug=False):
    """Cancel building or queued deployments for a project."""
    if project == skip_project:
        print(f"🟢 Skipping project: {project} (protected)")
        return

    # List deployments
    list_result = run_command(f"vercel ls {project}", debug)

    if debug:
        print(f"DEBUG: Full vercel ls output for {project}:")
        print(list_result["stripped_output"])

    # Parse output to find building/queued deployments
    lines = list_result["stripped_output"].split("\n")
    deployments_to_cancel = []
    latest_deployment_url = None

    for line in lines:
        # Skip header lines
        if "Vercel CLI" in line or "Deployment" in line or "Age" in line or ">" in line:
            continue

        # Check if building or queued
        if "Building" in line or "Queued" in line:
            url_match = re.search(r"(https://[^\s]+)", line)
            if url_match:
                deployments_to_cancel.append(url_match.group(1))

        # Save the first URL as the latest deployment
        if not latest_deployment_url:
            url_match = re.search(r"(https://[^\s]+)", line)
            if url_match:
                latest_deployment_url = url_match.group(1)

    # If no building/queued deployments found, check the latest deployment
    if not deployments_to_cancel and latest_deployment_url:
        inspect_result = run_command(f"vercel inspect {latest_deployment_url}", debug)

        if debug:
            print("DEBUG: Inspect result:")
            print(inspect_result["stripped_output"])

        status_text = inspect_result["stripped_output"].lower()
        if "building" in status_text or "queued" in status_text:
            deployments_to_cancel.append(latest_deployment_url)

    # Cancel deployments
    if deployments_to_cancel:
        for url in deployments_to_cancel:
            print(f"🗑️ {project}: Canceling deployment: {url}")

            # First attempt - cancel by URL
            cancel_result = run_command(f"vercel remove --yes {url}", debug)

            if cancel_result["return_code"] == 0:
                print("✅ Successfully canceled")
            else:
                print("⚠️ First attempt failed, trying with project name...")

                # Second attempt - cancel by project name
                alt_cancel_result = run_command(
                    f"vercel remove --safe --yes {project}", debug
                )

                if alt_cancel_result["return_code"] == 0:
                    print("✅ Successfully canceled with alternative method")
                else:
                    print("❌ Failed to cancel deployment")
    else:
        print(f"⚪ {project}: No current deployment building or queued")


def main():
    parser = argparse.ArgumentParser(
        description="Cancel Vercel deployments except for a specified project"
    )
    parser.add_argument(
        "project_to_skip",
        help="Name of the Vercel project to skip (don't cancel its deployments)",
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Skip the check for recent commits from other users",
    )
    parser.add_argument(
        "-d",
        "--debug",
        action="store_true",
        help="Enable debug mode for verbose output",
    )

    args = parser.parse_args()

    # Check for recent commits from other users
    if not check_recent_commits(args.force, args.debug):
        print("Operation canceled by user.")
        sys.exit(0)

    # Get list of Vercel projects
    projects = get_vercel_projects(args.debug)
    if args.debug:
        print(f"📄 Processing {len(projects)} projects: {', '.join(projects)}")

    # Process each project
    for project in projects:
        cancel_deployment(project, args.project_to_skip, args.debug)
        if args.debug:
            print("-------------------------------------")


if __name__ == "__main__":
    main()
