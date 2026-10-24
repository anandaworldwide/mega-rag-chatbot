"""Tests for pick_target. Keys are synthetic."""

from data_ingestion.audio_video.audio_filename_fix import pick_target


def test_pick_target_r1_exact_file_name():
    old_key = "treasures/ignore/Talk A.mp3"
    s3_keys = [
        "treasures/Talk A.mp3",
        "treasures/Talk B.mp3",
    ]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target == "treasures/Talk A.mp3"
    assert rule == "R1"


def test_pick_target_r2_normalized_file_name():
    old_key = "treasures/Talk A.mp3"
    s3_keys = [
        "treasures/Talk-A.mp3",
        "treasures/Talk B.mp3",
    ]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target == "treasures/Talk-A.mp3"
    assert rule == "R2"


def test_pick_target_r3_drops_used_key():
    old_key = "treasures/Talk A.mp3"
    s3_keys = [
        "treasures/album/Talk A.mp3",
        "treasures/copy/Talk A.mp3",
    ]
    used_keys = ["treasures/album/Talk A.mp3"]

    target, rule = pick_target(old_key, s3_keys, used_keys=used_keys)

    assert target == "treasures/copy/Talk A.mp3"
    assert rule == "R3"


def test_pick_target_zero_targets():
    old_key = "treasures/Talk A.mp3"
    s3_keys = ["treasures/Talk B.mp3"]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target is None
    assert rule == "zero targets"


def test_pick_target_ambiguous():
    old_key = "treasures/Talk A.mp3"
    s3_keys = [
        "treasures/album/Talk A.mp3",
        "treasures/copy/Talk A.mp3",
    ]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target is None
    assert rule == "ambiguous"


def test_pick_target_excludes_ignore_folder():
    old_key = "treasures/Talk A.mp3"
    s3_keys = [
        "treasures/Ignore/Talk A.mp3",
        "treasures/album/Talk A.mp3",
    ]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target == "treasures/album/Talk A.mp3"
    assert rule == "R1"


def test_pick_target_excludes_set_aside_folder():
    old_key = "treasures/Talk A.mp3"
    s3_keys = [
        "treasures/Set Aside/Talk A.mp3",
        "treasures/album/Talk A.mp3",
    ]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target == "treasures/album/Talk A.mp3"
    assert rule == "R1"


def test_pick_target_does_not_move_across_libraries():
    old_key = "treasures/Talk A.mp3"
    s3_keys = ["bhaktan/Talk A.mp3"]

    target, rule = pick_target(old_key, s3_keys, used_keys=())

    assert target is None
    assert rule == "zero targets"
