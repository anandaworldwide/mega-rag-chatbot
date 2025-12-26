"""Process cleanup utilities for Firefox/Playwright/Node.js orphaned processes."""

import logging
import os
import signal
import time

# Optional imports (may not be available in all environments)
try:
    import psutil
except ImportError:
    psutil = None

# Import from crawler submodules (support both module and direct execution)
try:
    from .config import CLEANUP_AGE_SECONDS, MAX_PLAYWRIGHT_FIREFOX_PROCS
except ImportError:
    from config import (  # type: ignore[import-not-found]
        CLEANUP_AGE_SECONDS,
        MAX_PLAYWRIGHT_FIREFOX_PROCS,
    )


def _collect_firefox_processes() -> list:
    """Collect Firefox processes with memory information."""
    if psutil is None:
        return []
    firefox_processes = []
    for proc in psutil.process_iter(["pid", "name", "cmdline", "memory_info"]):
        try:
            if proc.info["name"] and "firefox" in proc.info["name"].lower():
                firefox_processes.append(
                    {
                        "pid": proc.info["pid"],
                        "name": proc.info["name"],
                        "cmdline": proc.info["cmdline"][:3]
                        if proc.info["cmdline"]
                        else [],  # First 3 args only
                        "memory_mb": proc.info["memory_info"].rss / 1024 / 1024
                        if proc.info["memory_info"]
                        else 0,
                    }
                )
        except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
            continue
    return firefox_processes


def _log_firefox_processes(firefox_processes: list) -> None:
    """Log Firefox process information, highlighting problematic ones."""
    if not firefox_processes:
        logging.info("No Firefox processes found")
        return

    # Only warn about potentially problematic Firefox processes
    problematic_processes = [
        proc
        for proc in firefox_processes
        if proc["memory_mb"] > 1000  # Over 1GB memory usage
    ]

    if problematic_processes:
        logging.warning(
            f"Found {len(problematic_processes)} potentially problematic Firefox processes:"
        )
        for proc in problematic_processes[:3]:  # Show first 3 problematic ones
            logging.warning(
                f"  PID {proc['pid']}: High memory usage "
                f"(Memory: {proc['memory_mb']:.1f}MB) "
                f"CMD: {' '.join(proc['cmdline'][:2])}"
            )
    else:
        # Normal Firefox processes - log at INFO level
        logging.info(f"Found {len(firefox_processes)} Firefox processes (normal):")
        for proc in firefox_processes[:3]:  # Show first 3
            logging.info(
                f"  PID {proc['pid']}: {proc['name']} "
                f"(Memory: {proc['memory_mb']:.1f}MB)"
            )


def _collect_playwright_processes() -> list:
    """Collect Playwright and Node.js process PIDs."""
    if psutil is None:
        return []
    playwright_processes = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if proc.info["name"] and (
                "playwright" in proc.info["name"].lower()
                or "node" in proc.info["name"].lower()
            ):
                playwright_processes.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
            continue
    return playwright_processes


def _log_playwright_processes(playwright_processes: list) -> None:
    """Log Playwright/Node process information."""
    if not playwright_processes:
        return

    logging.info(
        f"Found {len(playwright_processes)} Playwright/Node processes before cleanup: {playwright_processes[:10]}"
    )
    if len(playwright_processes) > 5:
        logging.warning(
            f"High number of Playwright/Node processes detected ({len(playwright_processes)}). "
            "This may indicate cleanup issues or high crawler activity. "
            f"PIDs: {playwright_processes[:10]}{'...' if len(playwright_processes) > 10 else ''}"
        )


def _log_process_diagnostics() -> None:
    """Log detailed process diagnostics, especially Firefox-related processes."""
    try:
        # Log Firefox processes
        firefox_processes = _collect_firefox_processes()
        _log_firefox_processes(firefox_processes)

        # Log Playwright processes
        playwright_processes = _collect_playwright_processes()
        _log_playwright_processes(playwright_processes)

    except ImportError:
        logging.debug("psutil not available for process diagnostics")
    except Exception as e:
        logging.debug(f"Error in process diagnostics: {e}")


def _should_skip_process(proc, current_pid: int) -> bool:
    """Check if a process should be skipped from cleanup."""
    return (
        proc.info["pid"] == current_pid
        or not (proc.info["name"] and "firefox" in proc.info["name"].lower())
        or not proc.info["cmdline"]
    )


def _is_playwright_firefox_process(cmdline_str: str) -> bool:
    """Check if command line indicates a Playwright Firefox process."""
    # Must be headless (automated)
    if "-headless" not in cmdline_str:
        return False

    # Must have Playwright-specific arguments
    playwright_indicators = [
        "-juggler-pipe",  # Playwright's communication pipe
        "playwright",  # Direct Playwright reference
        "sync_playwright",  # Playwright's sync API
    ]

    if not any(indicator in cmdline_str for indicator in playwright_indicators):
        return False

    # Must have a temporary profile (not user's permanent profile)
    has_temp_profile = (
        "/tmp/" in cmdline_str
        or "/var/folders/" in cmdline_str  # macOS temp dirs
        or "-profile" in cmdline_str
        and (
            "playwright" in cmdline_str.lower()
            or "tmp" in cmdline_str.lower()
            or "temp" in cmdline_str.lower()
        )
    )

    return has_temp_profile


def _is_process_old_enough(proc) -> tuple[bool, float]:
    """Check if process is old enough to be considered orphaned."""
    if not proc.info["create_time"]:
        return False, 0

    process_age = time.time() - proc.info["create_time"]

    if process_age <= CLEANUP_AGE_SECONDS:  # 10 minutes
        return False, process_age

    return True, process_age


def _is_resource_usage_high(proc) -> tuple[bool, float, float]:
    """Check if process has high resource usage indicating it's problematic."""
    if psutil is None:
        return False, 0.0, 0.0
    try:
        cpu_percent = proc.cpu_percent(interval=0.1)
        memory_mb = proc.memory_info().rss / 1024 / 1024

        is_high_usage = cpu_percent > 50 or memory_mb > 500
        return is_high_usage, cpu_percent, memory_mb
    except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
        return False, 0, 0


def _terminate_process_safely(proc) -> bool:
    """Safely terminate a process with SIGTERM then SIGKILL if needed."""
    try:
        proc.send_signal(signal.SIGTERM)
        time.sleep(2)  # Give more time to terminate gracefully

        if proc.is_running():
            logging.warning(
                f"Process {proc.info['pid']} didn't respond to SIGTERM, using SIGKILL"
            )
            proc.kill()

        return True
    except Exception as kill_e:
        logging.debug(f"Error killing process {proc.info['pid']}: {kill_e}")
        return False


def _collect_playwright_firefox_processes(current_pid: int) -> list:
    """Collect all Playwright Firefox processes for analysis.

    Returns:
        List of process dictionaries with metadata for analysis.
    """
    if psutil is None:
        return []
    playwright_firefox_procs = []
    for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            # Skip our own process and non-Firefox processes
            if _should_skip_process(proc, current_pid):
                continue

            cmdline_str = " ".join(proc.info["cmdline"])

            # Check if this is a Playwright Firefox process
            if not _is_playwright_firefox_process(cmdline_str):
                continue

            # Collect this Playwright Firefox process for analysis
            is_old_enough, process_age = _is_process_old_enough(proc)
            is_high_usage, cpu_percent, memory_mb = _is_resource_usage_high(proc)

            playwright_firefox_procs.append(
                {
                    "proc": proc,
                    "pid": proc.info["pid"],
                    "age": process_age,
                    "is_old": is_old_enough,
                    "is_high_usage": is_high_usage,
                    "cpu_percent": cpu_percent,
                    "memory_mb": memory_mb,
                }
            )

        except (psutil.NoSuchProcess, psutil.AccessDenied, AttributeError):
            continue

    return playwright_firefox_procs


def _select_processes_to_kill(playwright_firefox_procs: list) -> list:
    """Select which Playwright Firefox processes should be terminated.

    Args:
        playwright_firefox_procs: List of process dictionaries from collection phase.

    Returns:
        List of processes that should be terminated.
    """
    processes_to_kill = []

    # Kill processes that are old enough OR have high resource usage
    for pf_proc in playwright_firefox_procs:
        if pf_proc["is_old"] or pf_proc["is_high_usage"]:
            processes_to_kill.append(pf_proc)

    # If we still have too many Playwright Firefox processes, kill the oldest ones
    if len(playwright_firefox_procs) > MAX_PLAYWRIGHT_FIREFOX_PROCS:
        # Sort by age (oldest first) and add excess processes to kill list
        sorted_procs = sorted(
            playwright_firefox_procs, key=lambda x: x["age"], reverse=True
        )
        excess_count = len(playwright_firefox_procs) - MAX_PLAYWRIGHT_FIREFOX_PROCS

        for pf_proc in sorted_procs[:excess_count]:
            if pf_proc not in processes_to_kill:
                processes_to_kill.append(pf_proc)
                logging.warning(
                    f"Adding Firefox process to kill list due to soft cap exceeded: "
                    f"PID {pf_proc['pid']} (age: {pf_proc['age']:.0f}s)"
                )

    return processes_to_kill


def _terminate_selected_processes(processes_to_kill: list) -> int:
    """Terminate the selected processes and return count of successful terminations.

    Args:
        processes_to_kill: List of process dictionaries to terminate.

    Returns:
        Number of successfully terminated processes.
    """
    orphaned_count = 0

    for pf_proc in processes_to_kill:
        if pf_proc["is_high_usage"]:
            logging.warning(
                f"Killing high-usage Playwright Firefox process (PID: {pf_proc['pid']}) - "
                f"CPU: {pf_proc['cpu_percent']:.1f}%, Memory: {pf_proc['memory_mb']:.1f}MB, "
                f"Age: {pf_proc['age']:.0f}s"
            )
        else:
            logging.warning(
                f"Killing old/excess Playwright Firefox process (PID: {pf_proc['pid']}, "
                f"age: {pf_proc['age']:.0f}s, CPU: {pf_proc['cpu_percent']:.1f}%, "
                f"Memory: {pf_proc['memory_mb']:.1f}MB)"
            )

        if _terminate_process_safely(pf_proc["proc"]):
            orphaned_count += 1
            logging.info(f"Successfully terminated Firefox process {pf_proc['pid']}")

    return orphaned_count


def _is_nodejs_process_eligible_for_cleanup(
    proc_info, current_pid: int, min_age_override: int | None = None
) -> tuple[bool, str]:
    """Check if a Node.js process should be cleaned up.

    Returns (should_cleanup, cmdline_str) tuple.
    """
    if proc_info["pid"] == current_pid:
        return False, ""  # Skip our own process

    if not proc_info["name"] or "node" not in proc_info["name"].lower():
        return False, ""  # Only Node.js processes

    # Check if process is old enough (reduced from 10 to 5 minutes for more aggressive cleanup)
    age_seconds = time.time() - proc_info["create_time"]
    min_age_seconds = (
        min_age_override if min_age_override else 300
    )  # Use override or default to 5 minutes
    if age_seconds < min_age_seconds:
        return False, ""  # Too young, might be legitimate

    # Check command line for Playwright indicators
    cmdline_str = " ".join(proc_info["cmdline"] or [])
    playwright_indicators = [
        "playwright",
        "juggler",
        "sync_playwright",
        "playwright-core",
    ]

    is_playwright_related = any(
        indicator in cmdline_str for indicator in playwright_indicators
    )

    return is_playwright_related, cmdline_str


def _terminate_nodejs_process(proc, pid: int, cmdline_str: str) -> bool:
    """Terminate a Node.js process, returning True if successful."""
    try:
        age_seconds = time.time() - proc.create_time()
        logging.info(
            f"Killing orphaned Node.js process (PID: {pid}, "
            f"age: {age_seconds:.0f}s, cmd: {cmdline_str[:100]}...)"
        )
        proc.terminate()
        # Give it 5 seconds to terminate gracefully
        proc.wait(timeout=5.0)
        return True
    except psutil.TimeoutExpired:  # type: ignore
        # Force kill if it doesn't terminate gracefully
        proc.kill()
        logging.warning(f"Force-killed stubborn Node.js process {pid}")
        return True
    except Exception as kill_error:
        logging.warning(f"Error killing Node.js process {pid}: {kill_error}")
        return False


def _cleanup_orphaned_nodejs_processes(current_pid: int) -> int:
    """Clean up orphaned Node.js processes that appear to be Playwright-related.

    This is more aggressive than Firefox cleanup since Node.js processes are harder to identify.
    We target processes that are:
    1. Named 'node' or 'nodejs'
    2. Old enough (10+ minutes) to be considered orphaned
    3. Have command lines suggesting Playwright usage

    Returns the number of processes cleaned up.
    """
    try:
        orphaned_count = 0

        # First, check if we have too many Playwright processes
        playwright_procs = _collect_playwright_processes()
        if len(playwright_procs) > 5:  # Lower threshold for aggressive cleanup
            logging.warning(
                f"Found {len(playwright_procs)} Playwright/Node processes - "
                f"performing aggressive cleanup"
            )
            # Be more aggressive with cleanup when we have too many processes
            # Kill ALL playwright processes except the most recent ones
            min_age_override = 30  # Kill processes older than 30 seconds
        else:
            min_age_override = None

        if psutil is not None:
            for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
                try:
                    should_cleanup, cmdline_str = (
                        _is_nodejs_process_eligible_for_cleanup(
                            proc.info, current_pid, min_age_override
                        )
                    )

                    if should_cleanup and _terminate_nodejs_process(
                        proc, proc.info["pid"], cmdline_str
                    ):
                        orphaned_count += 1

                except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
                    continue  # Process disappeared or access denied

        return orphaned_count

    except ImportError:
        logging.debug("psutil not available for Node.js cleanup")
        return 0
    except Exception as e:
        logging.warning(f"Error during Node.js process cleanup: {e}")
        return 0


def _cleanup_orphaned_processes() -> None:
    """Clean up orphaned Playwright processes from previous crawler sessions.

    This function targets:
    1. Firefox processes with Playwright-specific arguments (headless, temp profiles)
    2. Node.js processes that appear to be Playwright-related (orphaned from crashes)
    3. Processes that are old enough (10+ minutes) OR exceed soft limits

    This should NOT affect normal Firefox browsers or legitimate Node.js applications.
    """
    if psutil is None:
        return
    try:
        current_pid = os.getpid()  # Our current process ID
        total_cleaned = 0

        # Step 1: Clean up Firefox processes (existing logic)
        playwright_firefox_procs = _collect_playwright_firefox_processes(current_pid)
        processes_to_kill = _select_processes_to_kill(playwright_firefox_procs)
        firefox_cleaned = _terminate_selected_processes(processes_to_kill)
        total_cleaned += firefox_cleaned

        # Step 2: Clean up orphaned Node.js processes that appear Playwright-related
        node_cleaned = _cleanup_orphaned_nodejs_processes(current_pid)
        total_cleaned += node_cleaned

        # Report results with more detail
        if total_cleaned > 0:
            logging.info(
                f"Cleaned up {total_cleaned} total orphaned processes "
                f"({firefox_cleaned} Firefox, {node_cleaned} Node.js)"
            )
            # Log remaining process counts after cleanup
            remaining_firefox = len(_collect_playwright_firefox_processes(current_pid))
            remaining_nodejs = len(_collect_playwright_processes())
            if remaining_firefox > 0 or remaining_nodejs > 0:
                logging.info(
                    f"Processes remaining after cleanup: {remaining_firefox} Firefox, {remaining_nodejs} Node.js"
                )
            time.sleep(3)  # Give system more time to fully clean up
        else:
            logging.debug("No orphaned Playwright processes found")

    except ImportError:
        logging.debug("psutil not available for orphaned process cleanup")
    except Exception as e:
        logging.debug(f"Error in orphaned process cleanup: {e}")
