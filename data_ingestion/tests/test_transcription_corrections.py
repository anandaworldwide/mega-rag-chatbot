"""
Tests for transcription corrections functionality.

Tests cover:
1. Loading corrections from JSON file
2. Applying corrections to transcript text
3. Applying corrections to word objects
4. Handling different transcript formats (dict, list, string)
5. Site-specific corrections
6. Edge cases (empty corrections, missing site, etc.)
"""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from data_ingestion.audio_video.transcription_utils import (
    _apply_text_corrections,
    _apply_word_corrections,
    _load_transcription_corrections,
    _normalize_transcript_format,
    apply_transcription_corrections,
)


@pytest.fixture
def sample_transcript():
    """Sample transcript dict with text and words."""
    return {
        "text": "Rajashijanakaranda spoke about meditation",
        "words": [
            {"word": "Rajashijanakaranda", "start": 0.0, "end": 2.5},
            {"word": "spoke", "start": 2.6, "end": 3.0},
            {"word": "about", "start": 3.1, "end": 3.5},
            {"word": "meditation", "start": 3.6, "end": 4.5},
        ],
    }


@pytest.fixture
def sample_corrections_json():
    """Sample corrections JSON content."""
    return {
        "ananda": {
            "Rajashijanakaranda": "Rajarsi Janakananda",
            "St. Lin": "St. Lynn",
        },
        "ananda-public": {
            "Rajashijanakaranda": "Rajarsi Janakananda",
        },
        "crystal": {},
        "jairam": {},
    }


def test_normalize_transcript_format_dict(sample_transcript):
    """Test normalization of dict format transcript."""
    result = _normalize_transcript_format(sample_transcript)
    assert result == sample_transcript


def test_normalize_transcript_format_string():
    """Test normalization of string format transcript."""
    text = "Just a text string"
    result = _normalize_transcript_format(text)
    assert result == {"text": text, "words": []}


def test_normalize_transcript_format_list():
    """Test normalization of list format transcript."""
    transcript_list = [
        {"text": "First segment", "words": [{"word": "First", "start": 0.0, "end": 0.5}]},
        {"text": "Second segment", "words": [{"word": "Second", "start": 1.0, "end": 1.5}]},
    ]
    result = _normalize_transcript_format(transcript_list)
    assert result["text"] == "First segment Second segment"
    assert len(result["words"]) == 2
    assert result["words"][0]["word"] == "First"
    assert result["words"][1]["word"] == "Second"


def test_apply_text_corrections_basic():
    """Test applying corrections to text."""
    text = "Rajashijanakaranda spoke"
    corrections = {"Rajashijanakaranda": "Rajarsi Janakananda"}
    corrected_text, corrections_applied = _apply_text_corrections(text, corrections)

    assert corrected_text == "Rajarsi Janakananda spoke"
    assert len(corrections_applied) == 1
    assert "Rajashijanakaranda → Rajarsi Janakananda" in corrections_applied


def test_apply_text_corrections_multiple():
    """Test applying multiple corrections to text."""
    text = "Rajashijanakaranda spoke about St. Lin"
    corrections = {
        "Rajashijanakaranda": "Rajarsi Janakananda",
        "St. Lin": "St. Lynn",
    }
    corrected_text, corrections_applied = _apply_text_corrections(text, corrections)

    assert corrected_text == "Rajarsi Janakananda spoke about St. Lynn"
    assert len(corrections_applied) == 2


def test_apply_text_corrections_no_match():
    """Test applying corrections when no matches found."""
    text = "No corrections needed"
    corrections = {"Rajashijanakaranda": "Rajarsi Janakananda"}
    corrected_text, corrections_applied = _apply_text_corrections(text, corrections)

    assert corrected_text == text
    assert len(corrections_applied) == 0


def test_apply_text_corrections_empty():
    """Test applying corrections to empty text."""
    text = ""
    corrections = {"Rajashijanakaranda": "Rajarsi Janakananda"}
    corrected_text, corrections_applied = _apply_text_corrections(text, corrections)

    assert corrected_text == ""
    assert len(corrections_applied) == 0


def test_apply_word_corrections_basic(sample_transcript):
    """Test applying corrections to word objects."""
    words = sample_transcript["words"]
    corrections = {"Rajashijanakaranda": "Rajarsi Janakananda"}
    corrected_words = _apply_word_corrections(words, corrections)

    assert len(corrected_words) == len(words)
    assert corrected_words[0]["word"] == "Rajarsi Janakananda"
    assert corrected_words[0]["start"] == words[0]["start"]  # Timestamps preserved
    assert corrected_words[0]["end"] == words[0]["end"]
    assert corrected_words[1]["word"] == "spoke"  # Unchanged word


def test_apply_word_corrections_multiple():
    """Test applying multiple corrections to words."""
    words = [
        {"word": "Rajashijanakaranda", "start": 0.0, "end": 2.5},
        {"word": "St. Lin", "start": 2.6, "end": 3.5},
    ]
    corrections = {
        "Rajashijanakaranda": "Rajarsi Janakananda",
        "St. Lin": "St. Lynn",
    }
    corrected_words = _apply_word_corrections(words, corrections)

    assert corrected_words[0]["word"] == "Rajarsi Janakananda"
    assert corrected_words[1]["word"] == "St. Lynn"
    assert corrected_words[0]["start"] == 0.0  # Timestamps preserved


def test_apply_word_corrections_no_match():
    """Test applying corrections when no word matches."""
    words = [{"word": "normal", "start": 0.0, "end": 0.5}]
    corrections = {"Rajashijanakaranda": "Rajarsi Janakananda"}
    corrected_words = _apply_word_corrections(words, corrections)

    assert corrected_words[0]["word"] == "normal"
    assert len(corrected_words) == 1


def test_load_transcription_corrections_with_temp_file(sample_corrections_json):
    """Test loading corrections from a temporary JSON file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = Path(tmpdir) / "transcription_corrections.json"
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(sample_corrections_json, f)

        # Mock Path(__file__) to return our temp directory
        with patch(
            "data_ingestion.audio_video.transcription_utils.Path"
        ) as mock_path_class:
            # Create a mock Path object that behaves like Path(__file__)
            mock_file_path = Path(tmpdir) / "transcription_utils.py"
            mock_path_instance = mock_path_class.return_value
            mock_path_instance.parent = Path(tmpdir)
            mock_path_instance.__file__ = str(mock_file_path)

            # Clear cache
            from data_ingestion.audio_video.transcription_utils import (
                _transcription_corrections_cache,
            )

            _transcription_corrections_cache.clear()

            # Mock Path(__file__) properly
            original_path = Path
            with patch(
                "data_ingestion.audio_video.transcription_utils.Path",
                return_value=type("Path", (), {"parent": Path(tmpdir)})(),
            ):
                # Create a mock that returns our temp dir when called
                def mock_path_init(path):
                    class MockPath:
                        def __init__(self, p):
                            self._path = p

                        @property
                        def parent(self):
                            return Path(tmpdir)

                    return MockPath(path)

                with patch(
                    "data_ingestion.audio_video.transcription_utils.Path",
                    side_effect=lambda p: type("Path", (), {"parent": Path(tmpdir)})()
                    if "__file__" in str(p) or "transcription_utils.py" in str(p)
                    else original_path(p),
                ):
                    # Test loading
                    result = _load_transcription_corrections("ananda")
                    assert result == sample_corrections_json["ananda"]


def test_load_transcription_corrections_missing_site(sample_corrections_json):
    """Test loading corrections for a site that doesn't exist."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = Path(tmpdir) / "transcription_corrections.json"
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(sample_corrections_json, f)

        # Mock Path(__file__).parent to return our temp directory
        with patch(
            "data_ingestion.audio_video.transcription_utils.Path"
        ) as mock_path_class:
            class MockPath:
                def __init__(self, path):
                    self._path = path

                @property
                def parent(self):
                    return Path(tmpdir)

            mock_path_class.return_value = MockPath("transcription_utils.py")

            from data_ingestion.audio_video.transcription_utils import (
                _transcription_corrections_cache,
            )

            _transcription_corrections_cache.clear()

            result = _load_transcription_corrections("nonexistent")
            assert result == {}


def test_load_transcription_corrections_file_not_found():
    """Test loading corrections when file doesn't exist."""
    # Mock Path(__file__).parent to point to nonexistent directory
    with patch(
        "data_ingestion.audio_video.transcription_utils.Path"
    ) as mock_path_class:
        class MockPath:
            def __init__(self, path):
                self._path = path

            @property
            def parent(self):
                return Path("/nonexistent")

        mock_path_class.return_value = MockPath("transcription_utils.py")

        from data_ingestion.audio_video.transcription_utils import (
            _transcription_corrections_cache,
        )

        _transcription_corrections_cache.clear()

        result = _load_transcription_corrections("ananda")
        assert result == {}


def test_apply_transcription_corrections_basic(sample_transcript):
    """Test applying corrections to a complete transcript."""
    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {"Rajashijanakaranda": "Rajarsi Janakananda"}

        result = apply_transcription_corrections(sample_transcript, "ananda")

        assert result["text"] == "Rajarsi Janakananda spoke about meditation"
        assert result["words"][0]["word"] == "Rajarsi Janakananda"
        assert result["words"][0]["start"] == 0.0  # Timestamps preserved
        assert len(result["words"]) == 4


def test_apply_transcription_corrections_no_site(sample_transcript):
    """Test applying corrections when no site is provided."""
    result = apply_transcription_corrections(sample_transcript, None)

    assert result == sample_transcript  # Should return unchanged


def test_apply_transcription_corrections_empty_corrections(sample_transcript):
    """Test applying corrections when corrections dict is empty."""
    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {}

        result = apply_transcription_corrections(sample_transcript, "ananda")

        assert result == sample_transcript  # Should return unchanged


def test_apply_transcription_corrections_string_format():
    """Test applying corrections to string format transcript."""
    text = "Rajashijanakaranda spoke"
    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {"Rajashijanakaranda": "Rajarsi Janakananda"}

        result = apply_transcription_corrections(text, "ananda")

        assert result["text"] == "Rajarsi Janakananda spoke"
        assert result["words"] == []


def test_apply_transcription_corrections_list_format():
    """Test applying corrections to list format transcript."""
    transcript_list = [
        {
            "text": "Rajashijanakaranda spoke",
            "words": [{"word": "Rajashijanakaranda", "start": 0.0, "end": 2.5}],
        }
    ]
    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {"Rajashijanakaranda": "Rajarsi Janakananda"}

        result = apply_transcription_corrections(transcript_list, "ananda")

        assert result["text"] == "Rajarsi Janakananda spoke"
        assert result["words"][0]["word"] == "Rajarsi Janakananda"


def test_apply_transcription_corrections_preserves_other_fields(sample_transcript):
    """Test that corrections preserve other transcript fields."""
    sample_transcript["file_path"] = "test.mp3"
    sample_transcript["author"] = "Test Author"

    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {"Rajashijanakaranda": "Rajarsi Janakananda"}

        result = apply_transcription_corrections(sample_transcript, "ananda")

        assert result["file_path"] == "test.mp3"
        assert result["author"] == "Test Author"
        assert result["text"] == "Rajarsi Janakananda spoke about meditation"


def test_apply_transcription_corrections_multiple_occurrences():
    """Test applying corrections when term appears multiple times."""
    transcript = {
        "text": "Rajashijanakaranda spoke. Rajashijanakaranda continued.",
        "words": [
            {"word": "Rajashijanakaranda", "start": 0.0, "end": 2.5},
            {"word": "spoke", "start": 2.6, "end": 3.0},
            {"word": "Rajashijanakaranda", "start": 3.1, "end": 5.6},
            {"word": "continued", "start": 5.7, "end": 6.5},
        ],
    }
    with patch(
        "data_ingestion.audio_video.transcription_utils._load_transcription_corrections"
    ) as mock_load:
        mock_load.return_value = {"Rajashijanakaranda": "Rajarsi Janakananda"}

        result = apply_transcription_corrections(transcript, "ananda")

        assert result["text"] == "Rajarsi Janakananda spoke. Rajarsi Janakananda continued."
        assert result["words"][0]["word"] == "Rajarsi Janakananda"
        assert result["words"][2]["word"] == "Rajarsi Janakananda"
