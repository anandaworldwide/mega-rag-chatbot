"""Relocation of the two leftover Bhaktan .m4a talks."""

import pytest

from data_ingestion.audio_video.bhaktan_m4a import (
    BHAKTAN_M4A_RELOCATIONS,
    relocate_s3_object,
)


def test_bhaktan_m4a_destinations_add_kriyaban_only_component():
    assert len(BHAKTAN_M4A_RELOCATIONS) == 2
    for source, dest in BHAKTAN_M4A_RELOCATIONS:
        assert source.startswith("public/audio/bhaktan/_ Swami Kriyatalks")
        assert "/kriyaban-only/" not in source
        assert dest == source.replace(
            "public/audio/bhaktan/",
            "public/audio/bhaktan/kriyaban-only/",
            1,
        )
        assert dest.endswith(".m4a")


def test_relocate_s3_object_keeps_source_when_sizes_differ():
    class Client:
        def __init__(self):
            self.deleted = False

        def copy_object(self, **_kwargs):
            return None

        def head_object(self, **kwargs):
            key = kwargs["Key"]
            return {"ContentLength": 1 if key == "source" else 2}

        def delete_object(self, **_kwargs):
            self.deleted = True

    client = Client()
    with pytest.raises(SystemExit, match="Refusing to delete"):
        relocate_s3_object(client, "bucket", "source", "dest")
    assert client.deleted is False


def test_relocate_s3_object_deletes_source_when_sizes_match():
    class Client:
        def __init__(self):
            self.deleted = None

        def copy_object(self, **_kwargs):
            return None

        def head_object(self, **_kwargs):
            return {"ContentLength": 10}

        def delete_object(self, **kwargs):
            self.deleted = kwargs["Key"]

    client = Client()
    relocate_s3_object(client, "bucket", "source", "dest")
    assert client.deleted == "source"
