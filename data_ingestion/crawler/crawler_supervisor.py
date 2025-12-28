#!/usr/bin/env python
"""
Ananda Library Crawler Supervisor
Manages bounded crawler instances with adaptive restart logic
"""

import argparse
import logging
import os
import select
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# Add parent directory to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv


class CrawlerSupervisor:
    """Supervisor for managing bounded crawler instances."""

    def __init__(self, site_id: str, max_runtime_minutes: int = 0):
        self.site_id = site_id
        self.max_runtime_minutes = max_runtime_minutes
        self.supervisor_start_time = time.time()

        # Determine paths based on environment (local vs Docker container)
        script_dir = Path(__file__).resolve().parent

        # In Docker: /app/crawler/crawler_supervisor.py -> crawler_dir = /app/crawler
        # Local: .../data_ingestion/crawler/crawler_supervisor.py -> crawler_dir = same
        self.crawler_dir = script_dir

        # Project dir: local = parent.parent (crawler -> data_ingestion -> project root)
        # Docker = /app
        if (script_dir.parent.parent / "data_ingestion").exists():
            self.project_dir = script_dir.parent.parent
        else:
            self.project_dir = script_dir.parent  # /app in Docker
        # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
        data_dir = os.getenv("DATA_DIR")
        self.log_dir = (
            Path(data_dir) / "logs"
            if data_dir
            else Path.home() / "Library" / "Logs" / "AnandaCrawler"
        )
        self.pid_file = Path(f"/tmp/crawler_supervisor_{site_id}.pid")

        # Ensure log directory exists
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Setup logging
        self.setup_logging()

        # Load environment
        self.load_environment()

        # Check for existing instance
        self.check_existing_instance()

        # Write PID file
        self.write_pid_file()

        # Setup signal handlers
        signal.signal(signal.SIGTERM, self.signal_handler)
        signal.signal(signal.SIGINT, self.signal_handler)

    def setup_logging(self):
        """Setup logging configuration."""
        log_file = self.log_dir / f"supervisor_{self.site_id}.log"
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(message)s",
            handlers=[logging.FileHandler(log_file), logging.StreamHandler(sys.stdout)],
        )
        self.logger = logging.getLogger(__name__)

    def load_environment(self):
        """Load environment variables for the site.

        In cloud deployment, env vars come from AWS Secrets Manager.
        Locally, they come from .env files.
        """
        # Check if we're running in cloud mode (env vars already set via Secrets Manager)
        required_vars = ["OPENAI_API_KEY", "PINECONE_API_KEY"]
        if all(os.getenv(var) for var in required_vars):
            self.logger.info("Environment variables already set (cloud mode)")
            return

        # Local mode: load from .env file
        env_file = self.project_dir / f".env.{self.site_id}"
        if not env_file.exists():
            self.logger.error(f"Environment file not found: {env_file}")
            self.logger.error("Either set required env vars or provide .env file")
            sys.exit(1)

        load_dotenv(env_file)
        self.logger.info(f"Loaded environment from: {env_file}")

    def check_existing_instance(self):
        """Check if another supervisor instance is already running."""
        if self.pid_file.exists():
            try:
                with open(self.pid_file) as f:
                    old_pid = int(f.read().strip())

                # Check if process is still running
                try:
                    os.kill(old_pid, 0)
                    self.logger.error(
                        f"Supervisor for {self.site_id} already running (PID: {old_pid})"
                    )
                    sys.exit(1)
                except OSError:
                    # Process is dead, remove stale PID file
                    self.logger.warning(
                        f"Removing stale PID file from dead process (PID: {old_pid})"
                    )
                    self.pid_file.unlink()

            except (ValueError, OSError) as e:
                self.logger.warning(f"Error reading PID file, removing it: {e}")
                with open(self.pid_file, "w") as f:
                    f.write("")  # Clear the file

    def write_pid_file(self):
        """Write current PID to file."""
        with open(self.pid_file, "w") as f:
            f.write(str(os.getpid()))

    def signal_handler(self, signum, frame):
        """Handle termination signals."""
        self.logger.info(f"Received signal {signum}, shutting down...")
        self.cleanup()
        sys.exit(0)

    def cleanup(self):
        """Cleanup resources."""
        if self.pid_file.exists():
            self.pid_file.unlink()
        self.logger.info("Supervisor shutdown complete")

    def _check_health_failure_in_log(self, crawler_log: Path) -> bool:
        """Check if crawler log contains health check failure message."""
        if not crawler_log.exists():
            return False

        try:
            with open(crawler_log) as f:
                lines = f.readlines()
                for line in lines[-20:]:
                    if "Health check failed - requesting graceful shutdown" in line:
                        return True
        except Exception as e:
            self.logger.debug(f"Error reading crawler log: {e}")

        return False

    def _update_last_output_time(
        self, crawler_log: Path, current_time: float, last_output_time: float
    ) -> float:
        """Update last output time based on log file activity."""
        if not crawler_log.exists():
            return last_output_time

        try:
            with open(crawler_log) as f:
                lines = f.readlines()
                # If log has any non-empty lines, consider it active output
                if any(line.strip() for line in lines[-20:]):
                    return current_time
        except Exception as e:
            self.logger.debug(f"Error checking log output: {e}")

        return last_output_time

    def _force_kill_process(self, process: subprocess.Popen) -> None:
        """Forcefully kill a process that didn't terminate gracefully."""
        try:
            process.terminate()
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.logger.error("Process didn't terminate, killing forcefully")
            process.kill()
            process.wait(timeout=5)

    def _check_shutdown_timeout(
        self,
        process: subprocess.Popen,
        shutdown_requested_time: float | None,
        current_time: float,
    ) -> bool:
        """Check if graceful shutdown timeout exceeded and kill process if needed."""
        GRACEFUL_SHUTDOWN_TIMEOUT = 300  # 5 minutes

        if shutdown_requested_time is None:
            return False

        elapsed = current_time - shutdown_requested_time
        if elapsed > GRACEFUL_SHUTDOWN_TIMEOUT:
            self.logger.error(
                f"Crawler requested graceful shutdown {elapsed:.0f}s ago but hasn't exited - killing forcefully"
            )
            self._force_kill_process(process)
            return True

        return False

    def _monitor_crawler_health(
        self, process: subprocess.Popen, crawler_log: Path, start_time: float
    ) -> None:
        """Monitor crawler process and log file for health check failures.

        If crawler requests graceful shutdown but doesn't exit within 5 minutes,
        kill it forcefully.
        """
        HEALTH_CHECK_INTERVAL = 30  # Check every 30 seconds
        OUTPUT_TIMEOUT = 600  # 10 minutes without output

        last_output_time = start_time
        shutdown_requested_time = None

        while process.poll() is None:
            time.sleep(HEALTH_CHECK_INTERVAL)

            current_time = time.time()

            # Check if process is still producing output
            if current_time - last_output_time > OUTPUT_TIMEOUT:
                self.logger.error(
                    f"Crawler has produced no output for {current_time - last_output_time:.0f} seconds - treating as wedged and killing"
                )
                self._force_kill_process(process)
                return

            # Update last output time from log file
            last_output_time = self._update_last_output_time(
                crawler_log, current_time, last_output_time
            )

            # Check for health check failure in log
            if (
                self._check_health_failure_in_log(crawler_log)
                and shutdown_requested_time is None
            ):
                shutdown_requested_time = current_time
                self.logger.warning(
                    "Detected health check failure in crawler log - monitoring for graceful exit"
                )

            # Check if shutdown timeout exceeded
            if self._check_shutdown_timeout(
                process, shutdown_requested_time, current_time
            ):
                return

    def _build_crawler_command(self) -> list[str]:
        """Build the crawler command list."""
        return [
            sys.executable,
            "-u",  # Unbuffered output for real-time logs
            str(self.crawler_dir / "website_crawler.py"),
            "--site",
            self.site_id,
            "--max-runtime-minutes",
            "45",
            "--non-interactive",
        ]

    def _run_cloud_mode(self, cmd: list[str]) -> int:
        """Run crawler in cloud mode (stdout goes to CloudWatch)."""
        process = subprocess.Popen(
            cmd,
            cwd=self.crawler_dir,
            # stdout/stderr inherit from parent - goes to CloudWatch
        )
        process.wait(timeout=60 * 60)
        return process.returncode if process.returncode is not None else 1

    def _read_process_output_unix(self, process: subprocess.Popen, log_file) -> None:
        """Read process output on Unix systems using select for non-blocking reads."""
        if process.stdout is None:
            return

        # Hard wall-clock cap to prevent indefinite wedges (e.g., browser launch hang under extreme memory pressure).
        # Note: We cannot rely on Playwright timeouts when the system is thrashing heavily.
        start_time = time.time()
        MAX_INSTANCE_RUNTIME_SECONDS = 60 * 60  # 1 hour

        while process.poll() is None:
            if time.time() - start_time > MAX_INSTANCE_RUNTIME_SECONDS:
                self.logger.error(
                    "Crawler instance exceeded max runtime (1 hour) while still running - killing forcefully"
                )
                self._force_kill_process(process)
                break

            ready, _, _ = select.select([process.stdout], [], [], 30)
            if ready:
                line = process.stdout.readline()
                if line:
                    log_file.write(line)
                    log_file.flush()
                else:
                    # EOF reached
                    break
            else:
                # Timeout - check if process is still alive
                if process.poll() is not None:
                    break

    def _read_process_output_windows(self, process: subprocess.Popen, log_file) -> None:
        """Read process output on Windows using blocking read."""
        if process.stdout is None:
            return

        for line in iter(process.stdout.readline, ""):
            log_file.write(line)
            log_file.flush()

    def _wait_and_cleanup_process(self, process: subprocess.Popen) -> int:
        """Wait for process completion and cleanup if needed."""
        try:
            process.wait(timeout=60 * 60)
        except subprocess.TimeoutExpired:
            self.logger.error("Crawler instance timed out after 1 hour")
            process.kill()
            process.wait(timeout=5)
            return 1
        finally:
            if process.poll() is None:
                self.logger.warning("Crawler process still running, terminating...")
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.logger.error("Process didn't terminate, killing forcefully")
                    process.kill()
                    process.wait(timeout=5)

        return process.returncode if process.returncode is not None else 1

    def _run_local_mode(self, cmd: list[str], crawler_log: Path) -> int:
        """Run crawler in local mode (write to log file)."""
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        with open(crawler_log, "a", buffering=1) as log_file:  # Line buffered
            process = subprocess.Popen(
                cmd,
                cwd=self.crawler_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                bufsize=1,  # Line buffered
                text=True,  # Text mode
            )

            if process.stdout is None:
                self.logger.error("Process stdout is None - cannot read output")
                process.wait(timeout=60 * 60)
                return process.returncode if process.returncode is not None else 1

            # Start health monitoring thread
            start_time = time.time()
            health_monitor = threading.Thread(
                target=self._monitor_crawler_health,
                args=(process, crawler_log, start_time),
                daemon=True,
            )
            health_monitor.start()

            # Read output based on platform
            if sys.platform != "win32":
                self._read_process_output_unix(process, log_file)
            else:
                self._read_process_output_windows(process, log_file)

            return self._wait_and_cleanup_process(process)

    def run_crawler_instance(self) -> int:
        """Run a single crawler instance and return exit code."""
        crawler_log = self.log_dir / f"crawler_{self.site_id}.log"
        cmd = self._build_crawler_command()

        self.logger.info(f"Starting crawler instance: {' '.join(cmd)}")

        try:
            is_cloud = bool(os.getenv("DATA_DIR"))
            if is_cloud:
                return self._run_cloud_mode(cmd)
            else:
                return self._run_local_mode(cmd, crawler_log)
        except subprocess.TimeoutExpired:
            self.logger.error("Crawler instance timed out after 1 hour")
            return 1
        except Exception as e:
            self.logger.error(f"Error running crawler instance: {e}")
            return 1

    def get_restart_delay(self, exit_code: int, runtime_seconds: int) -> int:
        """Determine restart delay based on exit conditions."""
        if exit_code == 0:
            # Normal completion
            if runtime_seconds < 1800:  # Less than 30 minutes
                self.logger.info("Crawler completed quickly - lots of work available")
                return 60  # Quick restart for productive sessions
            else:
                return 120  # Normal restart delay
        elif exit_code == 2:
            # Critical error (browser launch failure, etc.)
            self.logger.warning("Critical crawler error - longer restart delay")
            return 600  # Wait 10 minutes after critical errors
        else:
            # Other errors (rate limiting, etc.)
            self.logger.warning(
                f"Crawler exited with code {exit_code} - moderate restart delay"
            )
            return 300  # Wait 5 minutes after other errors

    def run_supervisor_loop(self):
        """Main supervisor loop."""
        self.logger.info(f"Starting crawler supervisor for site: {self.site_id}")
        self.logger.info(f"Project directory: {self.project_dir}")
        self.logger.info(f"Log directory: {self.log_dir}")
        if self.max_runtime_minutes > 0:
            self.logger.info(f"Max runtime: {self.max_runtime_minutes} minutes")

        try:
            while True:
                # Check if we've exceeded max runtime
                if self.max_runtime_minutes > 0:
                    elapsed_minutes = (time.time() - self.supervisor_start_time) / 60
                    if elapsed_minutes >= self.max_runtime_minutes:
                        self.logger.info(
                            f"Max runtime of {self.max_runtime_minutes} minutes reached. Shutting down."
                        )
                        break

                start_time = time.time()

                # Run crawler instance
                exit_code = self.run_crawler_instance()

                # Calculate runtime
                end_time = time.time()
                runtime_seconds = int(end_time - start_time)

                # Log completion
                self.logger.info(
                    f"Crawler instance completed with exit code {exit_code} after {runtime_seconds}s"
                )

                # Determine restart delay
                restart_delay = self.get_restart_delay(exit_code, runtime_seconds)

                if restart_delay > 0:
                    self.logger.info(
                        f"Waiting {restart_delay} seconds before next crawler instance..."
                    )
                    time.sleep(restart_delay)
                else:
                    self.logger.info("Restarting immediately...")

        except KeyboardInterrupt:
            self.logger.info("Supervisor interrupted by user")
        except Exception as e:
            self.logger.error(f"Unexpected error in supervisor loop: {e}")
        finally:
            self.cleanup()


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Supervisor for managing Ananda Library crawler instances"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables (e.g., ananda-public)",
    )
    parser.add_argument(
        "--max-runtime-minutes",
        type=int,
        default=0,
        help="Maximum total runtime in minutes (0 = unlimited, default for cloud: 480 = 8 hours)",
    )
    return parser.parse_args()


def main():
    args = parse_arguments()
    supervisor = CrawlerSupervisor(
        args.site, max_runtime_minutes=args.max_runtime_minutes
    )
    supervisor.run_supervisor_loop()


if __name__ == "__main__":
    main()
