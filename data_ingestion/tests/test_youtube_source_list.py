"""Tests for the S3 JSON YouTube source list."""

from data_ingestion.audio_video.youtube_source_list import (
    YoutubeSourceEntry,
    add_source_entry,
    parse_source_list,
    plan_new_youtube_videos,
    remove_source_entry,
    serialize_source_list,
)


def test_source_list_round_trips_url_and_playlist():
    entries = [
        YoutubeSourceEntry(
            kind="url",
            url="https://youtu.be/abcdefghijk",
            author="Swami Kriyananda",
            library="Ananda Youtube",
            required_access_level=0,
        ),
        YoutubeSourceEntry(
            kind="playlist",
            url="https://www.youtube.com/playlist?list=PLabc",
            author="Swami Kriyananda",
            library="Ananda Youtube",
            required_access_level=200,
        ),
    ]

    restored = parse_source_list(serialize_source_list(entries))

    assert restored == entries


def test_add_source_entry_keeps_one_copy_of_the_same_url():
    entry = YoutubeSourceEntry(
        kind="url",
        url="https://youtu.be/abcdefghijk",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )

    once, added_first = add_source_entry([], entry)
    twice, added_second = add_source_entry(once, entry)

    assert added_first is True
    assert added_second is False
    assert twice == [entry]


def test_remove_source_entry_matches_kind_and_url():
    video = YoutubeSourceEntry(
        kind="url",
        url="https://youtu.be/abcdefghijk",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )
    playlist = YoutubeSourceEntry(
        kind="playlist",
        url="https://www.youtube.com/playlist?list=PLabc",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )

    remaining, removed = remove_source_entry(
        [video, playlist], kind="playlist", url=playlist.url
    )
    untouched, removed_video = remove_source_entry(
        remaining, kind="url", url=playlist.url
    )

    assert removed is True
    assert removed_video is False
    assert untouched == [video]


def test_plan_new_youtube_videos_skips_processed_ids():
    playlist = YoutubeSourceEntry(
        kind="playlist",
        url="https://www.youtube.com/playlist?list=PLabc",
        author="Swami Kriyananda",
        library="Ananda Youtube",
        required_access_level=0,
    )
    direct = YoutubeSourceEntry(
        kind="url",
        url="https://youtu.be/newvideo111",
        author="Nayaswami Devi",
        library="Ananda Youtube",
        required_access_level=200,
    )

    def expand_playlist(url):
        assert url == playlist.url
        return [
            {
                "url": "https://www.youtube.com/watch?v=already1111",
                "youtube_id": "already1111",
            },
            {
                "url": "https://www.youtube.com/watch?v=freshvideo1",
                "youtube_id": "freshvideo1",
            },
        ]

    selection = plan_new_youtube_videos(
        [playlist, direct], {"already1111"}, expand_playlist
    )

    assert selection.skipped_processed == 1
    assert [
        (video.youtube_id, video.author, video.source) for video in selection.videos
    ] == [
        ("freshvideo1", "Swami Kriyananda", playlist.url),
        ("newvideo111", "Nayaswami Devi", None),
    ]
    assert selection.videos[1].required_access_level == 200
    assert selection.failed == []


def test_plan_new_youtube_videos_keeps_going_when_a_playlist_fails():
    broken = YoutubeSourceEntry(
        kind="playlist",
        url="https://www.youtube.com/playlist?list=PLbroken",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )
    direct = YoutubeSourceEntry(
        kind="url",
        url="https://youtu.be/newvideo111",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )
    invalid = YoutubeSourceEntry(
        kind="url",
        url="https://example.com/nope",
        author="Swami Kriyananda",
        library="Ananda Youtube",
    )

    def expand_playlist(url):
        raise RuntimeError("yt-dlp unavailable")

    selection = plan_new_youtube_videos(
        [broken, invalid, direct], set(), expand_playlist
    )

    assert [video.youtube_id for video in selection.videos] == ["newvideo111"]
    assert selection.failed == [
        "https://www.youtube.com/playlist?list=PLbroken: yt-dlp unavailable",
        "https://example.com/nope",
    ]
