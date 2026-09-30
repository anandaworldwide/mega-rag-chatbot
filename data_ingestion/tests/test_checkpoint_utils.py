"""
Tests for checkpoint utilities module.

Tests the unified checkpoint functionality including file-based, ID-based,
and progress-based checkpointing strategies as well as integration functions.
"""

import json
import os
import shutil
import tempfile
from unittest.mock import patch

import pytest

from data_ingestion.utils.checkpoint_utils import (
    CheckpointConfig,
    CheckpointError,
    CheckpointManager,
    FileCheckpointData,
    IDCheckpointData,
    ProgressCheckpointData,
    checkpoint_context,
    create_file_checkpoint_manager,
    create_folder_signature,
    create_id_checkpoint_manager,
    pdf_checkpoint_integration,
    sql_checkpoint_integration,
)


class TestCheckpointConfig:
    """Test CheckpointConfig dataclass."""
    
    def test_default_config(self):
        """Test default checkpoint configuration."""
        config = CheckpointConfig()
        
        assert config.checkpoint_dir == "ingestion_checkpoints"
        assert config.checkpoint_file is None
        assert config.auto_create_dir is True
        assert config.backup_count == 3
        assert config.atomic_writes is True
    
    def test_custom_config(self):
        """Test custom checkpoint configuration."""
        config = CheckpointConfig(
            checkpoint_dir="/custom/path",
            checkpoint_file="custom.json",
            auto_create_dir=False,
            backup_count=5,
            atomic_writes=False
        )
        
        assert config.checkpoint_dir == "/custom/path"
        assert config.checkpoint_file == "custom.json"
        assert config.auto_create_dir is False
        assert config.backup_count == 5
        assert config.atomic_writes is False


class TestCheckpointDataClasses:
    """Test checkpoint data structure classes."""
    
    def test_file_checkpoint_data_defaults(self):
        """Test FileCheckpointData with defaults."""
        data = FileCheckpointData()
        
        assert data.processed_files == 0
        assert data.folder_signature is None
        assert data.total_files is None
        assert data.last_processed_file is None
        assert isinstance(data.timestamp, str)
    
    def test_file_checkpoint_data_custom(self):
        """Test FileCheckpointData with custom values."""
        timestamp = "2024-01-01T12:00:00"
        data = FileCheckpointData(
            processed_files=50,
            folder_signature="abc123",
            total_files=100,
            last_processed_file="file.pdf",
            timestamp=timestamp
        )
        
        assert data.processed_files == 50
        assert data.folder_signature == "abc123"
        assert data.total_files == 100
        assert data.last_processed_file == "file.pdf"
        assert data.timestamp == timestamp
    
    def test_id_checkpoint_data_defaults(self):
        """Test IDCheckpointData with defaults."""
        data = IDCheckpointData()
        
        assert data.processed_ids == set()
        assert data.last_processed_id is None
        assert data.total_count is None
        assert isinstance(data.timestamp, str)
    
    def test_id_checkpoint_data_custom(self):
        """Test IDCheckpointData with custom values."""
        processed_ids = {1, 2, 3}
        data = IDCheckpointData(
            processed_ids=processed_ids,
            last_processed_id=3,
            total_count=10
        )
        
        assert data.processed_ids == processed_ids
        assert data.last_processed_id == 3
        assert data.total_count == 10
    
    def test_progress_checkpoint_data_defaults(self):
        """Test ProgressCheckpointData with defaults."""
        data = ProgressCheckpointData()
        
        assert data.current_progress == 0
        assert data.total_items is None
        assert data.success_count == 0
        assert data.error_count == 0
        assert data.metadata == {}
        assert isinstance(data.timestamp, str)


class TestCheckpointManager:
    """Test CheckpointManager functionality."""
    
    def setup_method(self):
        """Set up temporary directory for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.config = CheckpointConfig(
            checkpoint_dir=self.temp_dir,
            auto_create_dir=True,
            backup_count=2
        )
        self.manager = CheckpointManager(self.config)
    
    def teardown_method(self):
        """Clean up temporary directory after each test."""
        shutil.rmtree(self.temp_dir)
    
    def test_manager_initialization(self):
        """Test checkpoint manager initialization."""
        assert self.manager.config == self.config
        assert os.path.exists(self.temp_dir)
    
    def test_get_checkpoint_path_default(self):
        """Test getting checkpoint path with default filename."""
        path = self.manager._get_checkpoint_path()
        expected = os.path.join(self.temp_dir, "checkpoint.json")
        assert path == expected
    
    def test_get_checkpoint_path_with_identifier(self):
        """Test getting checkpoint path with identifier."""
        path = self.manager._get_checkpoint_path("test_id")
        expected = os.path.join(self.temp_dir, "checkpoint_test_id.json")
        assert path == expected
    
    def test_get_checkpoint_path_configured_file(self):
        """Test getting checkpoint path with configured file."""
        config = CheckpointConfig(
            checkpoint_dir=self.temp_dir,
            checkpoint_file=os.path.join(self.temp_dir, "custom.json")
        )
        manager = CheckpointManager(config)
        
        path = manager._get_checkpoint_path()
        assert path == config.checkpoint_file
    
    def test_save_and_load_file_checkpoint(self):
        """Test saving and loading file checkpoint data."""
        data = FileCheckpointData(
            processed_files=25,
            folder_signature="test_signature",
            total_files=50
        )
        
        # Save checkpoint
        success = self.manager.save_checkpoint(data, "test")
        assert success is True
        
        # Load checkpoint
        loaded = self.manager.load_checkpoint("test", "file")
        assert isinstance(loaded, FileCheckpointData)
        assert loaded.processed_files == 25
        assert loaded.folder_signature == "test_signature"
        assert loaded.total_files == 50
    
    def test_save_and_load_id_checkpoint(self):
        """Test saving and loading ID checkpoint data."""
        data = IDCheckpointData(
            processed_ids={1, 2, 3, 5},
            last_processed_id=5,
            total_count=10
        )
        
        # Save checkpoint
        success = self.manager.save_checkpoint(data, "test")
        assert success is True
        
        # Load checkpoint
        loaded = self.manager.load_checkpoint("test", "id")
        assert isinstance(loaded, IDCheckpointData)
        assert loaded.processed_ids == {1, 2, 3, 5}
        assert loaded.last_processed_id == 5
        assert loaded.total_count == 10
    
    def test_save_and_load_progress_checkpoint(self):
        """Test saving and loading progress checkpoint data."""
        metadata = {"batch_size": 100, "model": "test"}
        data = ProgressCheckpointData(
            current_progress=75,
            total_items=150,
            success_count=70,
            error_count=5,
            metadata=metadata
        )
        
        # Save checkpoint
        success = self.manager.save_checkpoint(data, "test")
        assert success is True
        
        # Load checkpoint
        loaded = self.manager.load_checkpoint("test", "progress")
        assert isinstance(loaded, ProgressCheckpointData)
        assert loaded.current_progress == 75
        assert loaded.total_items == 150
        assert loaded.success_count == 70
        assert loaded.error_count == 5
        assert loaded.metadata == metadata
    
    def test_save_and_load_generic_checkpoint(self):
        """Test saving and loading generic checkpoint data."""
        data = {
            "custom_field": "value",
            "numbers": [1, 2, 3],
            "nested": {"key": "value"}
        }
        
        # Save checkpoint
        success = self.manager.save_checkpoint(data, "test")
        assert success is True
        
        # Load checkpoint
        loaded = self.manager.load_checkpoint("test", "generic")
        assert loaded == data
    
    def test_load_nonexistent_checkpoint(self):
        """Test loading checkpoint that doesn't exist."""
        loaded = self.manager.load_checkpoint("nonexistent", "file")
        assert loaded is None
    
    def test_clear_checkpoint(self):
        """Test clearing checkpoint file."""
        data = FileCheckpointData(processed_files=10)
        
        # Save and verify exists
        self.manager.save_checkpoint(data, "test")
        path = self.manager._get_checkpoint_path("test")
        assert os.path.exists(path)
        
        # Clear and verify removed
        success = self.manager.clear_checkpoint("test")
        assert success is True
        assert not os.path.exists(path)
    
    def test_backup_functionality(self):
        """Test checkpoint backup creation."""
        data1 = FileCheckpointData(processed_files=10)
        data2 = FileCheckpointData(processed_files=20)
        
        # Save first checkpoint
        self.manager.save_checkpoint(data1, "test")
        
        # Save second checkpoint (should create backup)
        self.manager.save_checkpoint(data2, "test")
        
        # Check backup exists
        path = self.manager._get_checkpoint_path("test")
        backup_path = f"{path}.bak1"
        assert os.path.exists(backup_path)
        
        # Verify backup contains first data
        with open(backup_path) as f:
            backup_data = json.load(f)
        assert backup_data['processed_files'] == 10
    
    def test_atomic_writes(self):
        """Test atomic write functionality."""
        data = FileCheckpointData(processed_files=42)
        
        # Test with atomic writes enabled
        success = self.manager.save_checkpoint(data, "atomic_test")
        assert success is True
        
        # Verify file was created
        path = self.manager._get_checkpoint_path("atomic_test")
        assert os.path.exists(path)
        
        # Load and verify content
        loaded = self.manager.load_checkpoint("atomic_test", "file")
        assert loaded.processed_files == 42
    
    def test_atomic_write_error_handling(self):
        """Test atomic write error handling."""
        data = FileCheckpointData(processed_files=10)
        
        # Mock tempfile creation to fail
        with patch('tempfile.mkstemp', side_effect=OSError("Disk full")):
            with pytest.raises(CheckpointError):
                self.manager._atomic_write("/invalid/path/file.json", {"test": "data"})
    
    def test_save_checkpoint_error_handling(self):
        """Test error handling when saving checkpoint fails."""
        # Create manager with invalid directory (no permissions)
        if os.name != 'nt':  # Skip on Windows due to permission handling differences
            config = CheckpointConfig(
                checkpoint_dir="/root/invalid_dir",  # Should not be writable
                auto_create_dir=False
            )
            manager = CheckpointManager(config)
            
            data = FileCheckpointData(processed_files=10)
            success = manager.save_checkpoint(data)
            assert success is False


class TestUtilityFunctions:
    """Test utility functions."""
    
    def setup_method(self):
        """Set up temporary directory with test files."""
        self.temp_dir = tempfile.mkdtemp()
        
        # Create test files
        self.test_files = [
            "file1.pdf",
            "file2.pdf", 
            "subdir/file3.pdf"
        ]
        
        for file_path in self.test_files:
            full_path = os.path.join(self.temp_dir, file_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, 'w') as f:
                f.write(f"Content of {file_path}")
    
    def teardown_method(self):
        """Clean up temporary directory."""
        shutil.rmtree(self.temp_dir)
    
    def test_create_folder_signature(self):
        """Test folder signature creation."""
        signature = create_folder_signature(self.temp_dir, "*.pdf")
        
        # Should be consistent
        signature2 = create_folder_signature(self.temp_dir, "*.pdf")
        assert signature == signature2
        
        # Should be 32-character MD5 hash
        assert len(signature) == 32
        assert signature.isalnum()
    
    def test_create_folder_signature_recursive(self):
        """Test folder signature with recursive pattern."""
        signature = create_folder_signature(self.temp_dir, "**/*.pdf")
        
        # Should include subdirectory files
        assert len(signature) == 32
        
        # Should be different from non-recursive (includes subdir files)
        non_recursive = create_folder_signature(self.temp_dir, "*.pdf")
        assert signature != non_recursive
    
    def test_create_folder_signature_empty_dir(self):
        """Test folder signature with empty directory."""
        empty_dir = tempfile.mkdtemp()
        try:
            signature = create_folder_signature(empty_dir, "*.pdf")
            # Should still generate valid hash (of empty string)
            assert len(signature) == 32
        finally:
            os.rmdir(empty_dir)
    
    def test_create_file_checkpoint_manager(self):
        """Test file checkpoint manager factory."""
        manager = create_file_checkpoint_manager(self.temp_dir)
        
        assert isinstance(manager, CheckpointManager)
        assert manager.config.checkpoint_dir == self.temp_dir
        assert manager.config.backup_count == 3
        assert manager.config.atomic_writes is True
    
    def test_create_file_checkpoint_manager_with_site(self):
        """Test file checkpoint manager factory with site ID."""
        manager = create_file_checkpoint_manager(self.temp_dir, "test_site")
        
        expected_file = os.path.join(self.temp_dir, "file_checkpoint_test_site.json")
        assert manager.config.checkpoint_file == expected_file
    
    def test_create_id_checkpoint_manager(self):
        """Test ID checkpoint manager factory."""
        manager = create_id_checkpoint_manager(self.temp_dir, "test_site")
        
        assert isinstance(manager, CheckpointManager)
        assert manager.config.checkpoint_dir == self.temp_dir
        expected_file = os.path.join(self.temp_dir, "db_text_ingestion_checkpoint_test_site.json")
        assert manager.config.checkpoint_file == expected_file


class TestCheckpointContext:
    """Test checkpoint context manager."""
    
    def setup_method(self):
        """Set up test environment."""
        self.temp_dir = tempfile.mkdtemp()
        config = CheckpointConfig(checkpoint_dir=self.temp_dir)
        self.manager = CheckpointManager(config)
    
    def teardown_method(self):
        """Clean up test environment."""
        shutil.rmtree(self.temp_dir)
    
    def test_checkpoint_context_new_file(self):
        """Test checkpoint context with new file checkpoint."""
        with checkpoint_context(self.manager, "test", "file") as (data, save_func):
            assert isinstance(data, FileCheckpointData)
            assert data.processed_files == 0
            
            # Modify data
            data.processed_files = 10
            data.folder_signature = "test_sig"
            
            # Manual save
            success = save_func()
            assert success is True
        
        # Verify auto-save on exit
        loaded = self.manager.load_checkpoint("test", "file")
        assert loaded.processed_files == 10
        assert loaded.folder_signature == "test_sig"
    
    def test_checkpoint_context_existing_file(self):
        """Test checkpoint context with existing file checkpoint."""
        # Create existing checkpoint
        existing = FileCheckpointData(processed_files=5, folder_signature="existing")
        self.manager.save_checkpoint(existing, "test")
        
        # Use context with existing data
        with checkpoint_context(self.manager, "test", "file") as (data, save_func):
            assert data.processed_files == 5
            assert data.folder_signature == "existing"
    
    def test_checkpoint_context_no_auto_save(self):
        """Test checkpoint context without auto-save."""
        with checkpoint_context(self.manager, "test", "file", auto_save=False) as (data, save_func):
            data.processed_files = 15
        
        # Should not be saved automatically
        loaded = self.manager.load_checkpoint("test", "file")
        assert loaded is None or loaded.processed_files == 0
    
    def test_checkpoint_context_id_type(self):
        """Test checkpoint context with ID checkpoint type."""
        with checkpoint_context(self.manager, "test", "id") as (data, save_func):
            assert isinstance(data, IDCheckpointData)
            assert data.processed_ids == set()
            
            data.processed_ids.add(1)
            data.processed_ids.add(2)
            data.last_processed_id = 2
        
        # Verify saved data
        loaded = self.manager.load_checkpoint("test", "id")
        assert loaded.processed_ids == {1, 2}
        assert loaded.last_processed_id == 2


class TestIntegrationFunctions:
    """Test integration functions for existing scripts."""
    
    def setup_method(self):
        """Set up test environment."""
        self.temp_dir = tempfile.mkdtemp()
        self.pdf_dir = os.path.join(self.temp_dir, "pdfs")
        os.makedirs(self.pdf_dir)
        
        # Create test PDF files
        for i in range(3):
            pdf_path = os.path.join(self.pdf_dir, f"test{i}.pdf")
            with open(pdf_path, 'w') as f:
                f.write(f"PDF content {i}")
    
    def teardown_method(self):
        """Clean up test environment."""
        shutil.rmtree(self.temp_dir)
    
    def test_pdf_checkpoint_integration_new(self):
        """Test PDF checkpoint integration with new checkpoint."""
        processed_count, signature, save_func, _clear = pdf_checkpoint_integration(
            self.temp_dir, self.pdf_dir, "test_library", keep_data=True
        )
        
        assert processed_count == 0
        assert len(signature) == 32  # MD5 hash
        assert callable(save_func)
        
        # Test save function
        success = save_func(2)
        assert success is True
        
        # Verify saved data
        manager = create_file_checkpoint_manager(self.temp_dir, "test_library")
        loaded = manager.load_checkpoint("test_library", "file")
        assert loaded.processed_files == 2
        assert loaded.folder_signature == signature

    def test_pdf_checkpoint_skips_backups_and_clear_removes_the_file(self):
        """PDF checkpoints do not rotate backups, and clear removes leftovers."""
        _count, _signature, save_func, clear_func = pdf_checkpoint_integration(
            self.temp_dir, self.pdf_dir, "test_library", keep_data=True
        )
        save_func(1)
        save_func(2)
        checkpoint_path = os.path.join(
            self.temp_dir, "file_checkpoint_test_library_test_library.json"
        )
        assert os.path.exists(checkpoint_path)
        assert not os.path.exists(checkpoint_path + ".bak1")
        leftover_backup = checkpoint_path + ".bak1"
        with open(leftover_backup, "w", encoding="utf-8") as backup_file:
            backup_file.write("{}")

        clear_func()

        assert not os.path.exists(checkpoint_path)
        assert not os.path.exists(leftover_backup)
    
    def test_pdf_checkpoint_integration_existing(self):
        """Test PDF checkpoint integration with existing checkpoint."""
        # Create existing checkpoint
        manager = create_file_checkpoint_manager(self.temp_dir, "test_library")
        signature = create_folder_signature(self.pdf_dir, "**/*.pdf")
        existing = FileCheckpointData(
            processed_files=1,
            folder_signature=signature
        )
        manager.save_checkpoint(existing, "test_library")
        
        # Test integration
        processed_count, _, save_func, _clear = pdf_checkpoint_integration(
            self.temp_dir, self.pdf_dir, "test_library", keep_data=True
        )
        
        assert processed_count == 1  # Should resume from existing
    
    def test_pdf_checkpoint_integration_signature_mismatch(self):
        """Test PDF checkpoint integration with signature mismatch."""
        # Create existing checkpoint with different signature
        manager = create_file_checkpoint_manager(self.temp_dir, "test_library")
        existing = FileCheckpointData(
            processed_files=1,
            folder_signature="old_signature"
        )
        manager.save_checkpoint(existing, "test_library")
        
        # Test integration
        processed_count, _, _, _clear = pdf_checkpoint_integration(
            self.temp_dir, self.pdf_dir, "test_library", keep_data=True
        )
        
        assert processed_count == 0  # Should start from beginning
    
    def test_pdf_checkpoint_integration_no_keep_data(self):
        """Test PDF checkpoint integration without keeping data."""
        # Create existing checkpoint
        manager = create_file_checkpoint_manager(self.temp_dir, "test_library")
        existing = FileCheckpointData(processed_files=1)
        manager.save_checkpoint(existing, "test_library")
        
        # Test integration
        processed_count, _, _, _clear = pdf_checkpoint_integration(
            self.temp_dir, self.pdf_dir, "test_library", keep_data=False
        )
        
        assert processed_count == 0  # Should ignore existing checkpoint
    
    def test_sql_checkpoint_integration_new(self):
        """Test SQL checkpoint integration with new checkpoint."""
        processed_ids, last_id, save_func = sql_checkpoint_integration(
            self.temp_dir, "test_site", keep_data=True
        )
        
        assert processed_ids == set()
        assert last_id == 0
        assert callable(save_func)
        
        # Test save function
        test_ids = {1, 2, 3}
        success = save_func(test_ids, 3)
        assert success is True
        
        # Verify saved data
        manager = create_id_checkpoint_manager(self.temp_dir, "test_site")
        loaded = manager.load_checkpoint("test_site", "id")
        assert loaded.processed_ids == test_ids
        assert loaded.last_processed_id == 3
    
    def test_sql_checkpoint_integration_existing(self):
        """Test SQL checkpoint integration with existing checkpoint."""
        # Create existing checkpoint
        manager = create_id_checkpoint_manager(self.temp_dir, "test_site")
        existing_ids = {10, 20, 30}
        existing = IDCheckpointData(
            processed_ids=existing_ids,
            last_processed_id=30
        )
        manager.save_checkpoint(existing, "test_site")
        
        # Test integration
        processed_ids, last_id, _ = sql_checkpoint_integration(
            self.temp_dir, "test_site", keep_data=True
        )
        
        assert processed_ids == existing_ids
        assert last_id == 30
    
    def test_sql_checkpoint_integration_no_keep_data(self):
        """Test SQL checkpoint integration without keeping data."""
        # Create existing checkpoint
        manager = create_id_checkpoint_manager(self.temp_dir, "test_site")
        existing = IDCheckpointData(processed_ids={10, 20}, last_processed_id=20)
        manager.save_checkpoint(existing, "test_site")
        
        # Test integration
        processed_ids, last_id, _ = sql_checkpoint_integration(
            self.temp_dir, "test_site", keep_data=False
        )
        
        assert processed_ids == set()  # Should ignore existing
        assert last_id == 0


class TestErrorHandling:
    """Test error handling scenarios."""
    
    def test_checkpoint_error_exception(self):
        """Test CheckpointError exception."""
        error = CheckpointError("Test error message")
        assert str(error) == "Test error message"
        assert isinstance(error, Exception)
    
    def test_corrupted_checkpoint_file(self):
        """Test handling of corrupted checkpoint file."""
        temp_dir = tempfile.mkdtemp()
        try:
            config = CheckpointConfig(checkpoint_dir=temp_dir)
            manager = CheckpointManager(config)
            
            # Create corrupted JSON file
            checkpoint_path = manager._get_checkpoint_path("test")
            with open(checkpoint_path, 'w') as f:
                f.write("invalid json {")
            
            # Should return None for corrupted file
            loaded = manager.load_checkpoint("test", "file")
            assert loaded is None
            
        finally:
            shutil.rmtree(temp_dir)
    
    def test_permission_denied_error(self):
        """Test handling permission denied errors."""
        temp_dir = tempfile.mkdtemp()
        try:
            config = CheckpointConfig(checkpoint_dir=temp_dir)
            manager = CheckpointManager(config)
            
            # Create checkpoint file first
            data = FileCheckpointData(processed_files=1)
            checkpoint_path = manager._get_checkpoint_path("test")
            manager.save_checkpoint(data, "test")
            
            if os.name != 'nt':  # Skip on Windows
                # Make directory read-only to prevent atomic writes
                os.chmod(temp_dir, 0o555)  # Read-only directory
                
                # Should handle permission error gracefully
                success = manager.save_checkpoint(data, "test")
                assert success is False
                
        finally:
            # Restore permissions before cleanup
            if os.name != 'nt':
                try:
                    os.chmod(temp_dir, 0o755)  # Restore write permissions
                except OSError:
                    pass  # May fail if permissions already restored
                for root, dirs, files in os.walk(temp_dir):
                    for d in dirs:
                        try:
                            os.chmod(os.path.join(root, d), 0o755)
                        except OSError:
                            pass
                    for f in files:
                        try:
                            os.chmod(os.path.join(root, f), 0o644)
                        except OSError:
                            pass
            shutil.rmtree(temp_dir) 