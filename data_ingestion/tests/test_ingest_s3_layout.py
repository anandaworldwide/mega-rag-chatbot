"""Tests for canonical S3 key layout used by ingest source publishing."""

from data_ingestion.utils.ingest_s3_layout import (
    RUNS_LEDGER_KEY,
    audio_s3_key,
    dump_s3_key,
    transcriptions_db_s3_key,
    transcriptions_dir_s3_prefix,
    youtube_data_map_s3_key,
    youtube_list_s3_key,
)


def test_audio_s3_key_joins_library_and_relative_path():
    assert (
        audio_s3_key("bhaktan", "Swami Talks/week-01/05.mp3")
        == "public/audio/bhaktan/Swami Talks/week-01/05.mp3"
    )


def test_audio_s3_key_normalizes_backslashes_and_leading_slash():
    assert (
        audio_s3_key("treasures", "/Thumb drive\\file.mp3")
        == "public/audio/treasures/Thumb drive/file.mp3"
    )


def test_audio_s3_key_rewrites_kriyaban_only_folder_to_hyphenated_segment():
    assert (
        audio_s3_key("bhaktan", "Kriyaban only/_ Swami/talk.mp3")
        == "public/audio/bhaktan/kriyaban-only/_ Swami/talk.mp3"
    )
    assert (
        audio_s3_key("treasures", "7-2024/Kriyaban Only/clip.mp3")
        == "public/audio/treasures/7-2024/kriyaban-only/clip.mp3"
    )


def test_audio_s3_key_rewrites_ignore_folder_and_optional_key_prefix():
    from data_ingestion.utils.ingest_s3_layout import audio_s3_key

    assert (
        audio_s3_key("bhaktan", "ignore/dup.mp3")
        == "public/audio/bhaktan/ignore/dup.mp3"
    )
    assert (
        audio_s3_key("bhaktan", "talk.mp3", key_prefix="Kriyaban Only")
        == "public/audio/bhaktan/kriyaban-only/talk.mp3"
    )


def test_state_list_and_dump_s3_keys():
    assert (
        youtube_data_map_s3_key("ananda")
        == "site-config/data_ingestion/media/ananda-youtube_data_map.json"
    )
    assert transcriptions_db_s3_key("ananda") == "ingestion/state/ananda-transcriptions.db"
    assert (
        transcriptions_dir_s3_prefix("ananda")
        == "ingestion/state/transcriptions/ananda"
    )
    assert (
        youtube_list_s3_key("youtube-links.xlsx")
        == "site-config/data_ingestion/youtube/lists/youtube-links.xlsx"
    )
    assert dump_s3_key("anandalib_2025_03_06.sql.gz") == (
        "ingestion/dumps/anandalib/anandalib_2025_03_06.sql.gz"
    )
    assert RUNS_LEDGER_KEY == "ingestion/runs/ingestion_runs.jsonl"
