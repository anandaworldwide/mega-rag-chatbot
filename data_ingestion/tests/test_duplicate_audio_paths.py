"""Rules for dropping a second scan of the same audio filename."""

from data_ingestion.audio_video.duplicate_audio_paths import paths_to_drop


def test_treasures_loose_copy_drops_when_album_copy_exists():
    album = (
        "treasures/Thumb drive from Krishna 7-2024/MP3 2007/"
        "A_Way_to_Awakening_SC21_81-84/03_Finding_Joy_in_Suffering.mp3"
    )
    loose = "treasures/03_Finding_Joy_in_Suffering.mp3"

    assert paths_to_drop([loose, album]) == [loose]


def test_treasures_keeps_kriyaban_folder_and_drops_loose_file():
    organized = (
        "treasures/kriyaban-only/Kriyaban Retreats with Swami Kriyananda (1)/"
        "46-sk-1st-kriya-retreat-life-of-a-kriya-yogi-fri-1993.mp3"
    )
    loose = "treasures/46-sk-1st-kriya-retreat-life-of-a-kriya-yogi-fri-1993.mp3"

    assert paths_to_drop([organized, loose]) == [loose]


def test_track_numbers_in_different_lessons_are_kept():
    lesson_4 = (
        "bhaktan/Swami Talks on Meditation/"
        "Swami Kriyananda Lessons in Meditation mp3/Lesson 4/01.mp3"
    )
    lesson_8 = (
        "bhaktan/Swami Talks on Meditation/"
        "Swami Kriyananda Lessons in Meditation mp3/Lesson 8/01.mp3"
    )

    assert paths_to_drop([lesson_4, lesson_8]) == []


def test_bhaktan_life_with_master_keeps_one_album_folder():
    album = "bhaktan/Life with Master/Life With Master Tape 4.mp3"
    other_album = "bhaktan/Swami Life with Master/Life With Master Tape 4.mp3"
    loose = "bhaktan/Life With Master Tape 4.mp3"

    assert paths_to_drop([loose, album, other_album]) == [other_album, loose]


def test_bhaktan_interviews_keep_the_2010_and_2011_folder():
    keep = (
        "bhaktan/Swami in America 2010 and 2011/Swami Interviews in L.A./"
        "Interview 3.12.2010 Elese Coit.mp3"
    )
    drop = (
        "bhaktan/Swami in America 2011 & interviews 2010/"
        "Interview 3.12.2010 Elese Coit.mp3"
    )

    assert paths_to_drop([drop, keep]) == [drop]
