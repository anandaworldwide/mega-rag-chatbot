"""
Unit tests for audio metadata extraction functionality.

This test suite verifies the extraction and handling of metadata from audio files.
Covers various formats, encodings, and edge cases including:
- Basic MP3/WAV metadata extraction
- Non-ASCII character handling in metadata fields
- Missing and malformed metadata scenarios
- URL extraction from different comment formats
- Very long metadata fields
- Empty and corrupted files
"""

import logging
import os
import shutil
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from mutagen.id3 import APIC, COMM, ID3

from data_ingestion.audio_video.media_utils import (
    get_media_metadata,
    get_mp3_metadata,
)

logger = logging.getLogger(__name__)

class TestMetadataExtraction(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.temp_files = []
        
    def tearDown(self):
        # Clean up any temporary files
        for temp_file in self.temp_files:
            if os.path.exists(temp_file):
                os.remove(temp_file)
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)
            
    def create_mp3_with_metadata(self, filename, title=None, artist=None, album=None, cover_art=None):
        """Helper to create MP3 with specific metadata"""
        filepath = os.path.join(self.temp_dir, filename)
        self.temp_files.append(filepath)
        
        # Create a valid MP3 file with 1 second of silence
        subprocess.run([
            'ffmpeg', '-f', 'lavfi', 
            '-i', 'anullsrc=r=44100:cl=mono', 
            '-t', '1',
            '-metadata', f'title={title or ""}',
            '-metadata', f'artist={artist or ""}',
            '-metadata', f'album={album or ""}',
            '-y',  # Overwrite output files
            '-acodec', 'libmp3lame',
            '-b:a', '128k',
            filepath
        ], check=True, capture_output=True)
        
        # Add cover art if provided
        if cover_art:
            tags = ID3(filepath)
            tags.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='Cover', data=cover_art))
            tags.save()
            
        return filepath
        
    def create_wav_with_metadata(self, filename, duration=1.0, sample_rate=44100):
        """Helper to create WAV file with specific duration"""
        filepath = os.path.join(self.temp_dir, filename)
        self.temp_files.append(filepath)
        
        # Create sine wave data
        t = np.linspace(0, duration, int(sample_rate * duration))
        data = np.sin(2 * np.pi * 440 * t)
        scaled = np.int16(data * 32767)
        
        with wave.open(filepath, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(scaled.tobytes())
            
        return filepath

    def test_basic_mp3_metadata(self):
        """Test basic MP3 metadata extraction"""
        filepath = self.create_mp3_with_metadata(
            'test.mp3',
            title='Test Title',
            artist='Test Artist',
            album='Test Album'
        )
        
        title, author, duration, url, album = get_media_metadata(filepath)
        
        self.assertEqual(title, 'Test Title')
        self.assertEqual(author, 'Test Artist')
        self.assertEqual(album, 'Test Album')
        self.assertIsNone(url)
        self.assertGreater(duration, 0)

    def test_non_ascii_metadata(self):
        """Test metadata with non-ASCII characters"""
        filepath = self.create_mp3_with_metadata(
            'test_unicode.mp3',
            title='测试标题',  # Chinese
            artist='テストアーティスト',  # Japanese
            album='Тестовый альбом'  # Russian
        )
        
        title, author, duration, url, album = get_media_metadata(filepath)
        
        self.assertEqual(title, '测试标题')
        self.assertEqual(author, 'テストアーティスト')
        self.assertEqual(album, 'Тестовый альбом')

    def test_missing_metadata(self):
        """Test handling of missing metadata fields"""
        filepath = self.create_mp3_with_metadata('test_missing.mp3')
        
        title, author, duration, url, album = get_media_metadata(filepath)
        
        # Should fall back to filename without extension
        self.assertEqual(title, 'test_missing')
        self.assertEqual(author, 'Unknown')
        self.assertIsNone(album)
        self.assertIsNone(url)
        self.assertGreater(duration, 0)

    def test_malformed_metadata(self):
        """Test handling of malformed metadata"""
        filepath = os.path.join(self.temp_dir, 'test_malformed.mp3')
        self.temp_files.append(filepath)
        
        # Create an invalid MP3 file
        with open(filepath, 'wb') as f:
            f.write(b'ID3' + b'\x00' * 1024)  # Invalid ID3 header
            
        with self.assertRaises(Exception) as context:
            get_mp3_metadata(filepath)
            
        self.assertIn("ID3v2.0 not supported", str(context.exception))

    def test_wav_metadata(self):
        """Test WAV metadata extraction"""
        filepath = self.create_wav_with_metadata('test.wav', duration=2.0)
        
        title, author, duration, url, album = get_media_metadata(filepath)
        
        # WAV files use filename as title
        self.assertEqual(title, 'test')
        self.assertEqual(author, 'Unknown')
        self.assertIsNone(album)
        self.assertIsNone(url)
        self.assertAlmostEqual(duration, 2.0, places=1)

    def test_url_in_comments(self):
        """Test URL extraction from comments"""
        url = 'https://example.com'
        filepath = self.create_mp3_with_metadata(
            'test_url.mp3',
            title='Test Title',
            artist='Test Artist'
        )
        
        # Add URL using mutagen directly
        tags = ID3(filepath)
        tags.add(COMM(encoding=3, lang='eng', desc='url', text=url))
        tags.save()
        
        title, author, duration, extracted_url, album = get_media_metadata(filepath)
        self.assertEqual(extracted_url, url)

    def test_unsupported_format(self):
        """Test handling of unsupported file formats"""
        filepath = os.path.join(self.temp_dir, 'test.ogg')
        self.temp_files.append(filepath)
        
        with open(filepath, 'wb') as f:
            f.write(b'\x00' * 1000)
            
        with self.assertRaises(ValueError) as context:
            get_media_metadata(filepath)
        self.assertIn('Unsupported file format', str(context.exception))

    def test_empty_file(self):
        """Test handling of empty files"""
        filepath = os.path.join(self.temp_dir, 'empty.mp3')
        self.temp_files.append(filepath)
        
        with open(filepath, 'wb') as f:
            pass
            
        with self.assertRaises(Exception):
            get_media_metadata(filepath)

    def test_very_long_metadata(self):
        """Test handling of very long metadata fields"""
        long_text = 'A' * 1000  # 1000 character string
        filepath = self.create_mp3_with_metadata(
            'test_long.mp3',
            title=long_text,
            artist=long_text,
            album=long_text
        )
        
        title, author, duration, url, album = get_media_metadata(filepath)
        
        self.assertEqual(len(title), 1000)
        self.assertEqual(len(author), 1000)
        self.assertEqual(len(album), 1000)

if __name__ == '__main__':
    unittest.main() 