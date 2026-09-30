"""
Checkpoint utilities for data ingestion operations.

This module provides unified checkpoint functionality supporting different checkpointing patterns
used across various ingestion pipelines. It abstracts the complexity of different checkpoint
strategies while maintaining compatibility with existing implementations.

Supported checkpoint types:
- File-based: Track processed file counts with content signatures
- ID-based: Track sets of processed document/item IDs  
- Queue-based: Track processing status of work items
- Progress-based: Integration with progress tracking utilities

Key features:
- Multiple checkpoint strategies in one interface
- Atomic checkpoint operations with error handling
- Resume capability from saved checkpoints
- Integration with existing progress tracking
- Backward compatibility with current implementations
"""

import hashlib
import json
import logging
import os
import shutil
import tempfile
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class CheckpointConfig:
    """Configuration for checkpoint operations."""
    checkpoint_dir: str = "ingestion_checkpoints"
    checkpoint_file: str | None = None
    auto_create_dir: bool = True
    backup_count: int = 3  # Number of checkpoint backups to keep
    atomic_writes: bool = True  # Use atomic writes for safety


@dataclass 
class FileCheckpointData:
    """Data structure for file-based checkpointing."""
    processed_files: int = 0
    folder_signature: str | None = None
    total_files: int | None = None
    last_processed_file: str | None = None
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class IDCheckpointData:
    """Data structure for ID-based checkpointing."""
    processed_ids: set[int | str] = field(default_factory=set)
    last_processed_id: int | str | None = None
    total_count: int | None = None
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class ProgressCheckpointData:
    """Data structure for progress-based checkpointing."""
    current_progress: int = 0
    total_items: int | None = None
    success_count: int = 0
    error_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


class CheckpointError(Exception):
    """Base exception for checkpoint operations."""
    pass


class CheckpointManager:
    """
    Unified checkpoint manager supporting multiple checkpoint strategies.
    
    Provides a consistent interface for different types of checkpointing
    while supporting the specific needs of different ingestion pipelines.
    """
    
    def __init__(self, config: CheckpointConfig):
        """
        Initialize checkpoint manager.
        
        Args:
            config: Checkpoint configuration
        """
        self.config = config
        self._ensure_checkpoint_dir()
    
    def _ensure_checkpoint_dir(self) -> None:
        """Ensure checkpoint directory exists."""
        if self.config.auto_create_dir and self.config.checkpoint_dir:
            os.makedirs(self.config.checkpoint_dir, exist_ok=True)
    
    def _get_checkpoint_path(self, identifier: str | None = None) -> str:
        """
        Get the full path to a checkpoint file.
        
        Args:
            identifier: Optional identifier for multiple checkpoint files
            
        Returns:
            str: Full path to checkpoint file
        """
        if self.config.checkpoint_file:
            # Use configured file path
            if identifier:
                base, ext = os.path.splitext(self.config.checkpoint_file)
                return f"{base}_{identifier}{ext}"
            return self.config.checkpoint_file
        
        # Generate default filename
        filename = f"checkpoint_{identifier}.json" if identifier else "checkpoint.json"
        return os.path.join(self.config.checkpoint_dir, filename)
    
    def _atomic_write(self, filepath: str, data: dict[str, Any]) -> None:
        """
        Atomically write checkpoint data to file.
        
        Args:
            filepath: Path to checkpoint file
            data: Data to write
        """
        if not self.config.atomic_writes:
            # Simple write
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, default=str)
            return
        
        # Atomic write using temporary file
        temp_fd = None
        temp_path = None
        try:
            # Create temporary file in same directory
            dir_path = os.path.dirname(filepath)
            temp_fd, temp_path = tempfile.mkstemp(
                suffix='.tmp',
                prefix='checkpoint_',
                dir=dir_path
            )
            
            # Write to temporary file
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as temp_file:
                json.dump(data, temp_file, indent=2, default=str)
                temp_fd = None  # File is closed by context manager
            
            # Atomic move (rename)
            shutil.move(temp_path, filepath)
            temp_path = None  # Successfully moved
            
            logger.debug(f"Checkpoint saved atomically to {filepath}")
            
        except Exception as e:
            # Cleanup on error
            if temp_fd is not None:
                try:
                    os.close(temp_fd)
                except OSError:
                    pass
            
            if temp_path and os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
            
            raise CheckpointError(f"Failed to save checkpoint atomically: {e}")
    
    def _backup_existing_checkpoint(self, filepath: str) -> None:
        """
        Create backup of existing checkpoint file.
        
        Args:
            filepath: Path to checkpoint file to backup
        """
        if not os.path.exists(filepath) or self.config.backup_count <= 0:
            return
        
        try:
            # Rotate existing backups
            base_path = filepath
            for i in range(self.config.backup_count - 1, 0, -1):
                old_backup = f"{base_path}.bak{i}"
                new_backup = f"{base_path}.bak{i + 1}"
                
                if os.path.exists(old_backup):
                    if i == self.config.backup_count - 1:
                        # Remove oldest backup
                        os.unlink(old_backup)
                    else:
                        shutil.move(old_backup, new_backup)
            
            # Create new backup
            backup_path = f"{base_path}.bak1"
            shutil.copy2(filepath, backup_path)
            
            logger.debug(f"Created checkpoint backup: {backup_path}")
            
        except Exception as e:
            logger.warning(f"Failed to create checkpoint backup: {e}")
    
    def load_checkpoint(
        self, 
        identifier: str | None = None,
        checkpoint_type: str = "generic"
    ) -> FileCheckpointData | IDCheckpointData | ProgressCheckpointData | dict[str, Any] | None:
        """
        Load checkpoint data from file.
        
        Args:
            identifier: Optional identifier for multiple checkpoint files
            checkpoint_type: Type of checkpoint data to load
            
        Returns:
            Checkpoint data or None if not found
        """
        filepath = self._get_checkpoint_path(identifier)
        
        if not os.path.exists(filepath):
            logger.debug(f"No checkpoint found at {filepath}")
            return None
        
        try:
            with open(filepath, encoding='utf-8') as f:
                raw_data = json.load(f)
            
            logger.info(f"Loaded checkpoint from {filepath}")
            
            # Convert to appropriate data structure
            if checkpoint_type == "file":
                return FileCheckpointData(
                    processed_files=raw_data.get('processed_files', 0),
                    folder_signature=raw_data.get('folder_signature'),
                    total_files=raw_data.get('total_files'),
                    last_processed_file=raw_data.get('last_processed_file'),
                    timestamp=raw_data.get('timestamp', datetime.now().isoformat())
                )
            elif checkpoint_type == "id":
                return IDCheckpointData(
                    processed_ids=set(raw_data.get('processed_ids', [])),
                    last_processed_id=raw_data.get('last_processed_id'),
                    total_count=raw_data.get('total_count'),
                    timestamp=raw_data.get('timestamp', datetime.now().isoformat())
                )
            elif checkpoint_type == "progress":
                return ProgressCheckpointData(
                    current_progress=raw_data.get('current_progress', 0),
                    total_items=raw_data.get('total_items'),
                    success_count=raw_data.get('success_count', 0),
                    error_count=raw_data.get('error_count', 0),
                    metadata=raw_data.get('metadata', {}),
                    timestamp=raw_data.get('timestamp', datetime.now().isoformat())
                )
            else:
                # Return raw data for custom types
                return raw_data
                
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to load checkpoint from {filepath}: {e}")
            return None
    
    def save_checkpoint(
        self,
        data: FileCheckpointData | IDCheckpointData | ProgressCheckpointData | dict[str, Any],
        identifier: str | None = None
    ) -> bool:
        """
        Save checkpoint data to file.
        
        Args:
            data: Checkpoint data to save
            identifier: Optional identifier for multiple checkpoint files
            
        Returns:
            bool: True if saved successfully
        """
        filepath = self._get_checkpoint_path(identifier)
        
        try:
            # Backup existing checkpoint
            self._backup_existing_checkpoint(filepath)
            
            # Convert dataclass to dict if needed
            if hasattr(data, '__dict__'):
                save_data = {}
                for key, value in data.__dict__.items():
                    if isinstance(value, set):
                        # Convert sets to lists for JSON serialization
                        save_data[key] = sorted(list(value))
                    else:
                        save_data[key] = value
            else:
                save_data = data
            
            # Add timestamp if not present
            if 'timestamp' not in save_data:
                save_data['timestamp'] = datetime.now().isoformat()
            
            # Write checkpoint
            self._atomic_write(filepath, save_data)
            
            logger.debug(f"Checkpoint saved to {filepath}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to save checkpoint to {filepath}: {e}")
            return False
    
    def clear_checkpoint(self, identifier: str | None = None) -> bool:
        """
        Remove checkpoint file.
        
        Args:
            identifier: Optional identifier for multiple checkpoint files
            
        Returns:
            bool: True if cleared successfully
        """
        filepath = self._get_checkpoint_path(identifier)
        
        try:
            if os.path.exists(filepath):
                os.unlink(filepath)
                logger.info(f"Cleared checkpoint: {filepath}")
            return True
        except Exception as e:
            logger.error(f"Failed to clear checkpoint {filepath}: {e}")
            return False


# Utility functions for specific checkpoint patterns

def create_folder_signature(directory: str, pattern: str = "*.pdf") -> str:
    """
    Create a signature for folder contents based on file names and modification times.
    
    Args:
        directory: Directory to create signature for
        pattern: File pattern to match (supports glob patterns)
        
    Returns:
        str: MD5 hash of folder contents
    """
    
    file_paths = []
    
    # Handle recursive patterns
    if "**" in pattern:
        file_paths = list(Path(directory).rglob(pattern.replace("**/", "")))
    else:
        file_paths = list(Path(directory).glob(pattern))
    
    file_infos = []
    for file_path in sorted(file_paths):
        try:
            stats = file_path.stat()
            file_infos.append(f"{file_path.name}:{stats.st_mtime}")
        except (FileNotFoundError, OSError):
            # Skip files that can't be accessed
            continue
    
    signature_string = "|".join(file_infos)
    return hashlib.md5(signature_string.encode()).hexdigest()


def create_file_checkpoint_manager(
    checkpoint_dir: str, site_id: str | None = None, backup_count: int = 3
) -> CheckpointManager:
    """
    Create a checkpoint manager configured for file-based checkpointing.
    
    Args:
        checkpoint_dir: Directory for checkpoint files
        site_id: Optional site identifier for multiple sites
        
    Returns:
        CheckpointManager: Configured checkpoint manager
    """
    checkpoint_file = None
    if site_id:
        checkpoint_file = os.path.join(checkpoint_dir, f"file_checkpoint_{site_id}.json")
    
    config = CheckpointConfig(
        checkpoint_dir=checkpoint_dir,
        checkpoint_file=checkpoint_file,
        backup_count=backup_count,
        atomic_writes=True
    )
    
    return CheckpointManager(config)


def create_id_checkpoint_manager(checkpoint_dir: str, site_id: str) -> CheckpointManager:
    """
    Create a checkpoint manager configured for ID-based checkpointing.
    
    Args:
        checkpoint_dir: Directory for checkpoint files
        site_id: Site identifier for checkpoint file naming
        
    Returns:
        CheckpointManager: Configured checkpoint manager
    """
    checkpoint_file = os.path.join(checkpoint_dir, f"db_text_ingestion_checkpoint_{site_id}.json")
    
    config = CheckpointConfig(
        checkpoint_dir=checkpoint_dir,
        checkpoint_file=checkpoint_file,
        backup_count=2,
        atomic_writes=True
    )
    
    return CheckpointManager(config)


@contextmanager
def checkpoint_context(
    manager: CheckpointManager,
    identifier: str | None = None,
    checkpoint_type: str = "generic",
    auto_save: bool = True
):
    """
    Context manager for automatic checkpoint loading and saving.
    
    Args:
        manager: Checkpoint manager instance
        identifier: Optional identifier for checkpoint file
        checkpoint_type: Type of checkpoint data
        auto_save: Whether to automatically save checkpoint on exit
        
    Yields:
        Tuple[checkpoint_data, save_function]: Current checkpoint data and save function
    """
    # Load existing checkpoint
    checkpoint_data = manager.load_checkpoint(identifier, checkpoint_type)
    
    # Initialize with default if none exists
    if checkpoint_data is None:
        if checkpoint_type == "file":
            checkpoint_data = FileCheckpointData()
        elif checkpoint_type == "id":
            checkpoint_data = IDCheckpointData()
        elif checkpoint_type == "progress":
            checkpoint_data = ProgressCheckpointData()
        else:
            checkpoint_data = {}
    
    # Create save function
    def save_checkpoint(data: Any | None = None) -> bool:
        """Save current checkpoint data."""
        save_data = data if data is not None else checkpoint_data
        return manager.save_checkpoint(save_data, identifier)
    
    try:
        yield checkpoint_data, save_checkpoint
    finally:
        if auto_save:
            save_checkpoint()


# Integration functions for existing scripts

def pdf_checkpoint_integration(
    checkpoint_dir: str,
    folder_path: str,
    library_name: str,
    keep_data: bool = True
) -> tuple[int, str, Callable, Callable]:
    """
    Integration function for PDF ingestion checkpointing.

    PDF checkpoints do not keep backup copies. The caller removes the file
    when the process exits.

    Args:
        checkpoint_dir: Directory for checkpoint files
        folder_path: Path to PDF folder
        library_name: Library name for identification
        keep_data: Whether to resume from existing checkpoint

    Returns:
        Tuple[processed_count, folder_signature, save_function, clear_function]
    """
    manager = create_file_checkpoint_manager(
        checkpoint_dir, library_name, backup_count=0
    )
    
    # Create current folder signature
    current_signature = create_folder_signature(folder_path, "**/*.pdf")
    
    processed_count = 0
    
    if keep_data:
        checkpoint = manager.load_checkpoint(library_name, "file")
        if checkpoint and checkpoint.folder_signature == current_signature:
            processed_count = checkpoint.processed_files
            logger.info(f"Resuming PDF ingestion from file {processed_count + 1}")
        elif checkpoint:
            logger.info("Folder signature mismatch - starting from beginning")
    
    def save_checkpoint(count: int) -> bool:
        """Save current progress."""
        data = FileCheckpointData(
            processed_files=count,
            folder_signature=current_signature,
            timestamp=datetime.now().isoformat()
        )
        return manager.save_checkpoint(data, library_name)

    def clear_checkpoint() -> None:
        """Remove the checkpoint and any backups left from older runs."""
        path = manager._get_checkpoint_path(library_name)
        manager.clear_checkpoint(library_name)
        for backup in Path(path).parent.glob(Path(path).name + ".bak*"):
            backup.unlink(missing_ok=True)

    return processed_count, current_signature, save_checkpoint, clear_checkpoint


def sql_checkpoint_integration(
    checkpoint_dir: str,
    site_id: str,
    keep_data: bool = True
) -> tuple[set[int], int, Callable]:
    """
    Integration function for SQL ingestion checkpointing.
    
    Args:
        checkpoint_dir: Directory for checkpoint files
        site_id: Site identifier
        keep_data: Whether to resume from existing checkpoint
        
    Returns:
        Tuple[processed_ids, last_processed_id, save_function]
    """
    manager = create_id_checkpoint_manager(checkpoint_dir, site_id)
    
    processed_ids = set()
    last_processed_id = 0
    
    if keep_data:
        checkpoint = manager.load_checkpoint(site_id, "id")
        if checkpoint:
            processed_ids = checkpoint.processed_ids
            last_processed_id = checkpoint.last_processed_id or 0
            logger.info(f"Resuming SQL ingestion with {len(processed_ids)} processed IDs")
    
    def save_checkpoint(doc_ids: set[int], last_id: int) -> bool:
        """Save current progress."""
        data = IDCheckpointData(
            processed_ids=doc_ids,
            last_processed_id=last_id,
            timestamp=datetime.now().isoformat()
        )
        return manager.save_checkpoint(data, site_id)
    
    return processed_ids, last_processed_id, save_checkpoint 