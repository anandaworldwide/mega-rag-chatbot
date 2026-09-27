"""Move the two leftover Bhaktan .m4a talks under kriyaban-only.

The album name is not an access convention. Only the path component
kriyaban-only proposes access level 200.
"""

BHAKTAN_M4A_RELOCATIONS = (
    (
        "public/audio/bhaktan/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/Higher Kriya Initiations 2 & 3 & 4 Kriyaban Retreat 1994.m4a",
        "public/audio/bhaktan/kriyaban-only/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/Higher Kriya Initiations 2 & 3 & 4 Kriyaban Retreat 1994.m4a",
    ),
    (
        "public/audio/bhaktan/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/Swami on Kechari Mudra(1).m4a",
        "public/audio/bhaktan/kriyaban-only/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/Swami on Kechari Mudra(1).m4a",
    ),
)


def relocate_s3_object(s3_client, bucket: str, source: str, dest: str) -> None:
    """Copy source to dest, require equal size, then delete source."""
    s3_client.copy_object(
        Bucket=bucket,
        CopySource={"Bucket": bucket, "Key": source},
        Key=dest,
    )
    source_size = s3_client.head_object(Bucket=bucket, Key=source)["ContentLength"]
    dest_size = s3_client.head_object(Bucket=bucket, Key=dest)["ContentLength"]
    if source_size != dest_size:
        raise SystemExit(
            f"Refusing to delete {source}: size {source_size} != {dest_size} at {dest}"
        )
    s3_client.delete_object(Bucket=bucket, Key=source)
