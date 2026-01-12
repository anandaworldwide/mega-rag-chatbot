"""
Progress tracking and signal handling utilities for data ingestion operations.

This module provides comprehensive progress tracking functionality including signal handlers,
progress bars, and graceful shutdown management for use across different ingestion pipelines
(PDF, HTML/web content, SQL database, audio/video).

Key features:
- Unified signal handling with graceful shutdown support
- ProgressTracker context manager for progress with checkpointing
- Standardized TQDM progress bar creation and management
- Integration with checkpoint systems for resume capability
- Thread-safe progress tracking and shutdown handling
"""

import asyncio
import logging
import signal
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

from tqdm import tqdm

logger = logging.getLogger(__name__)

# Global shutdown state - thread-safe
_shutdown_lock = Lock()
_is_exiting = False


@dataclass
class ProgressConfig:
    """Configuration for progress tracking operations."""

    description: str = "Processing"
    unit: str = "item"
    total: int | None = None
    show_progress: bool = True
    checkpoint_interval: int = 1  # Save checkpoint every N items
    enable_eta: bool = True
    bar_format: str | None = None
    ncols: int | None = None


@dataclass
class ProgressState:
    """Current state of progress tracking operation."""

    current: int = 0
    total: int | None = None
    start_time: float = field(default_factory=time.time)
    last_checkpoint: int = 0
    last_checkpoint_time: float = field(default_factory=time.time)
    interrupted: bool = False
    error_count: int = 0
    success_count: int = 0


def is_exiting() -> bool:
    """
    Check if a graceful shutdown has been initiated.

    Thread-safe check for the global shutdown state.

    Returns:
        bool: True if shutdown is in progress, False otherwise
    """
    with _shutdown_lock:
        return _is_exiting


def set_exiting(value: bool = True) -> None:
    """
    Set the global shutdown state.

    Args:
        value: True to initiate shutdown, False to reset state
    """
    global _is_exiting
    with _shutdown_lock:
        _is_exiting = value


def signal_handler(sig: int, frame: Any) -> None:
    """
    Handle shutdown signals (SIGINT/Ctrl+C) gracefully.

    Provides graceful shutdown on first signal, forced exit on second signal.
    Based on the pattern used in both PDF and SQL ingestion scripts.

    Args:
        sig: Signal number
        frame: Current stack frame
    """
    global _is_exiting

    with _shutdown_lock:
        if _is_exiting:
            logger.warning("Forced exit. Shutting down immediately...")
            sys.exit(1)  # Non-normal termination
        else:
            logger.info(
                "Graceful shutdown initiated. Processing will stop soon. Press Ctrl+C again for forced exit."
            )
            _is_exiting = True


def setup_signal_handlers(
    custom_handler: Callable[[int, Any], None] | None = None,
    signals_to_handle: list[int] | None = None,
) -> None:
    """
    Set up signal handlers for graceful shutdown.

    Args:
        custom_handler: Optional custom signal handler function
        signals_to_handle: List of signals to handle (defaults to [SIGINT])
    """
    if signals_to_handle is None:
        signals_to_handle = [signal.SIGINT]

    handler = custom_handler if custom_handler else signal_handler

    for sig in signals_to_handle:
        signal.signal(sig, handler)

    logger.debug(f"Signal handlers set up for signals: {signals_to_handle}")


def reset_shutdown_state() -> None:
    """
    Reset the shutdown state.

    Useful for testing or when reusing the module in the same process.
    """
    set_exiting(False)


def create_progress_bar(config: ProgressConfig, iterable: Any | None = None) -> tqdm:
    """
    Create a standardized TQDM progress bar.

    Args:
        config: Progress configuration settings
        iterable: Optional iterable to wrap with progress bar

    Returns:
        tqdm: Configured progress bar instance
    """
    tqdm_kwargs = {
        "desc": config.description,
        "unit": config.unit,
        "total": config.total,
        "disable": not config.show_progress,
    }

    if config.enable_eta and config.total:
        tqdm_kwargs["unit_scale"] = True

    if config.bar_format:
        tqdm_kwargs["bar_format"] = config.bar_format

    if config.ncols:
        tqdm_kwargs["ncols"] = config.ncols

    if iterable is not None:
        return tqdm(iterable, **tqdm_kwargs)
    else:
        return tqdm(**tqdm_kwargs)


class ProgressTracker:
    """
    Context manager for progress tracking with checkpoint integration.

    Provides comprehensive progress tracking with automatic checkpointing,
    signal handling, and graceful shutdown support.
    """

    def __init__(
        self,
        config: ProgressConfig,
        checkpoint_callback: Callable[[int, Any], None] | None = None,
        cleanup_callback: Callable[[], None] | None = None,
        checkpoint_data: dict[str, Any] | None = None,
    ):
        """
        Initialize progress tracker.

        Args:
            config: Progress configuration
            checkpoint_callback: Function to call for saving checkpoints (current_progress, data)
            cleanup_callback: Function to call during cleanup
            checkpoint_data: Additional data to pass to checkpoint callback
        """
        self.config = config
        self.state = ProgressState(total=config.total)
        self.checkpoint_callback = checkpoint_callback
        self.cleanup_callback = cleanup_callback
        self.checkpoint_data = checkpoint_data or {}
        self.progress_bar: tqdm | None = None
        self._setup_complete = False

    def __enter__(self) -> "ProgressTracker":
        """Enter the progress tracking context."""
        self._setup_complete = False

        # Create progress bar
        if self.config.show_progress:
            self.progress_bar = create_progress_bar(self.config)

        self._setup_complete = True
        logger.debug(f"Progress tracking started: {self.config.description}")

        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Exit the progress tracking context."""
        try:
            # Handle different exit scenarios
            if exc_type is not None:
                self.state.interrupted = True
                logger.warning(
                    f"Progress tracking interrupted due to exception: {exc_val}"
                )
            elif is_exiting():
                self.state.interrupted = True
                logger.info("Progress tracking interrupted due to graceful shutdown")

            # Save final checkpoint if needed
            if (
                self.checkpoint_callback
                and self.state.current > self.state.last_checkpoint
            ):
                self._save_checkpoint("final")

            # Run cleanup callback
            if self.cleanup_callback:
                try:
                    self.cleanup_callback()
                except Exception as e:
                    logger.error(f"Error during cleanup: {e}")

            # Close progress bar
            if self.progress_bar is not None:
                # Ensure progress bar shows completion if not interrupted
                if (
                    not self.state.interrupted
                    and self.config.total
                    and self.state.current < self.config.total
                ):
                    self.progress_bar.update(self.config.total - self.state.current)
                self.progress_bar.close()

            # Log final statistics
            elapsed = time.time() - self.state.start_time
            logger.info(
                f"Progress tracking completed: {self.state.current}/{self.config.total or '?'} items "
                f"in {elapsed:.2f}s, {self.state.success_count} successes, {self.state.error_count} errors"
            )

        except Exception as e:
            logger.error(f"Error during progress tracking cleanup: {e}")

    def update(self, n: int = 1, **kwargs) -> bool:
        """
        Update progress by n items.

        Args:
            n: Number of items to add to progress
            **kwargs: Additional data to include in checkpoint

        Returns:
            bool: True if operation should continue, False if shutdown requested
        """
        if not self._setup_complete:
            logger.warning("Progress tracker not properly initialized")
            return False

        # Check for shutdown request
        if is_exiting():
            logger.info("Shutdown detected during progress update")
            return False

        # Update state
        self.state.current += n

        # Update progress bar
        if self.progress_bar is not None:
            self.progress_bar.update(n)

        # Check if checkpoint needed
        if (
            self.checkpoint_callback
            and self.state.current - self.state.last_checkpoint
            >= self.config.checkpoint_interval
        ):
            checkpoint_data = {**self.checkpoint_data, **kwargs}
            self._save_checkpoint("interval", checkpoint_data)

        return True

    def increment_success(self, n: int = 1) -> None:
        """Increment success counter."""
        self.state.success_count += n

    def increment_error(self, n: int = 1) -> None:
        """Increment error counter."""
        self.state.error_count += n

    def set_total(self, total: int) -> None:
        """Update the total number of items to process."""
        self.state.total = total
        self.config.total = total
        if self.progress_bar is not None:
            self.progress_bar.total = total
            self.progress_bar.refresh()

    def set_description(self, description: str) -> None:
        """Update the progress bar description."""
        self.config.description = description
        if self.progress_bar is not None:
            self.progress_bar.set_description(description)

    def _save_checkpoint(
        self, checkpoint_type: str, additional_data: dict[str, Any] | None = None
    ) -> None:
        """Save a checkpoint with current progress."""
        try:
            data = {
                "current": self.state.current,
                "total": self.state.total,
                "checkpoint_type": checkpoint_type,
                "timestamp": time.time(),
                "success_count": self.state.success_count,
                "error_count": self.state.error_count,
                **(additional_data or {}),
            }

            if self.checkpoint_callback is not None:
                self.checkpoint_callback(self.state.current, data)
            self.state.last_checkpoint = self.state.current
            self.state.last_checkpoint_time = time.time()

        except Exception as e:
            logger.error(f"Error saving checkpoint: {e}")


def check_shutdown_requested() -> bool:
    """
    Convenience function to check if shutdown has been requested.

    Returns:
        bool: True if shutdown requested, False otherwise
    """
    return is_exiting()


def with_progress_bar(
    config: ProgressConfig,
    checkpoint_callback: Callable[[int, Any], None] | None = None,
    cleanup_callback: Callable[[], None] | None = None,
):
    """
    Decorator for functions that need progress tracking.

    Args:
        config: Progress configuration
        checkpoint_callback: Function to call for saving checkpoints
        cleanup_callback: Function to call during cleanup

    Returns:
        Decorator function
    """

    def decorator(func):
        def wrapper(*args, **kwargs):
            with ProgressTracker(
                config, checkpoint_callback, cleanup_callback
            ) as tracker:
                return func(tracker, *args, **kwargs)

        return wrapper

    return decorator


# Async variants for async operations
class AsyncProgressTracker(ProgressTracker):
    """Async version of ProgressTracker for use with async operations."""

    async def __aenter__(self) -> "AsyncProgressTracker":
        """Async enter method."""
        self.__enter__()
        return self

    async def __aexit__(  # noqa: C901
        self, exc_type: Any, exc_val: Any, exc_tb: Any
    ) -> None:
        """Async exit method."""
        try:
            # Handle different exit scenarios
            if exc_type is not None:
                self.state.interrupted = True
                logger.warning(
                    f"Progress tracking interrupted due to exception: {exc_val}"
                )
            elif is_exiting():
                self.state.interrupted = True
                logger.info("Progress tracking interrupted due to graceful shutdown")

            # Save final checkpoint if needed
            if (
                self.checkpoint_callback
                and self.state.current > self.state.last_checkpoint
            ):
                await self.save_checkpoint_async("final")

            # Run cleanup callback asynchronously if it's a coroutine
            if self.cleanup_callback:
                try:
                    if asyncio.iscoroutinefunction(self.cleanup_callback):
                        await self.cleanup_callback()
                    else:
                        self.cleanup_callback()
                except Exception as e:
                    logger.error(f"Error during async cleanup: {e}")

            # Close progress bar
            if self.progress_bar is not None:
                if (
                    not self.state.interrupted
                    and self.config.total
                    and self.state.current < self.config.total
                ):
                    # Ensure progress bar shows completion
                    self.progress_bar.update(self.config.total - self.state.current)
                self.progress_bar.close()

            # Log final statistics
            elapsed = time.time() - self.state.start_time
            logger.info(
                f"Async progress tracking completed: {self.state.current}/{self.config.total or '?'} items "
                f"in {elapsed:.2f}s, {self.state.success_count} successes, {self.state.error_count} errors"
            )

        except Exception as e:
            logger.error(f"Error during async progress tracking cleanup: {e}")

    async def save_checkpoint_async(
        self, checkpoint_type: str, additional_data: dict[str, Any] | None = None
    ) -> None:
        """Async version of checkpoint saving."""
        try:
            data = {
                "current": self.state.current,
                "total": self.state.total,
                "checkpoint_type": checkpoint_type,
                "timestamp": time.time(),
                "success_count": self.state.success_count,
                "error_count": self.state.error_count,
                **(additional_data or {}),
            }

            if self.checkpoint_callback is not None:
                if asyncio.iscoroutinefunction(self.checkpoint_callback):
                    await self.checkpoint_callback(self.state.current, data)
                else:
                    self.checkpoint_callback(self.state.current, data)

            self.state.last_checkpoint = self.state.current
            self.state.last_checkpoint_time = time.time()

            logger.debug(
                f"Async checkpoint saved: {checkpoint_type} at {self.state.current}"
            )

        except Exception as e:
            logger.error(f"Error saving async checkpoint: {e}")


# Utility functions for batch operations
def create_batch_progress_bar(
    items: list[Any],
    description: str = "Processing items",
    batch_size: int = 1,
    unit: str = "item",
) -> tqdm:
    """
    Create a progress bar for batch operations.

    Args:
        items: List of items to process
        description: Progress bar description
        batch_size: Number of items processed per batch
        unit: Unit name for progress display

    Returns:
        tqdm: Configured progress bar
    """
    config = ProgressConfig(
        description=description, unit=unit, total=len(items), show_progress=True
    )

    return create_progress_bar(config, items)


def monitor_async_tasks(
    tasks: list[Any], description: str = "Processing tasks", check_interval: float = 0.1
) -> tqdm:
    """
    Create a progress bar for monitoring async tasks.

    Args:
        tasks: List of async tasks to monitor
        description: Progress bar description
        check_interval: How often to check task completion (seconds)

    Returns:
        tqdm: Progress bar that updates as tasks complete
    """
    config = ProgressConfig(
        description=description, unit="task", total=len(tasks), show_progress=True
    )

    return create_progress_bar(config)


# Configuration presets for common use cases
PROGRESS_PRESETS = {
    "pdf_processing": ProgressConfig(
        description="Processing PDFs",
        unit="file",
        checkpoint_interval=1,
        enable_eta=True,
    ),
    "vector_upsert": ProgressConfig(
        description="Upserting vectors",
        unit="batch",
        checkpoint_interval=10,
        enable_eta=True,
    ),
    "data_extraction": ProgressConfig(
        description="Extracting data",
        unit="record",
        checkpoint_interval=100,
        enable_eta=True,
    ),
    "chunk_processing": ProgressConfig(
        description="Processing chunks",
        unit="chunk",
        checkpoint_interval=50,
        enable_eta=True,
    ),
}


def get_progress_preset(preset_name: str) -> ProgressConfig:
    """
    Get a predefined progress configuration preset.

    Args:
        preset_name: Name of the preset to retrieve

    Returns:
        ProgressConfig: Progress configuration preset

    Raises:
        ValueError: If preset name is not recognized
    """
    if preset_name not in PROGRESS_PRESETS:
        available = ", ".join(PROGRESS_PRESETS.keys())
        raise ValueError(
            f"Unknown preset '{preset_name}'. Available presets: {available}"
        )

    # Return a copy so modifications don't affect the original
    preset = PROGRESS_PRESETS[preset_name]
    return ProgressConfig(
        description=preset.description,
        unit=preset.unit,
        total=preset.total,
        show_progress=preset.show_progress,
        checkpoint_interval=preset.checkpoint_interval,
        enable_eta=preset.enable_eta,
        bar_format=preset.bar_format,
        ncols=preset.ncols,
    )
