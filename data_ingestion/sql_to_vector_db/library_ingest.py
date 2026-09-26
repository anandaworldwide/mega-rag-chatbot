"""Orchestrate an Ananda Library dump: S3, Docker MySQL, ingest, title catalog."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import sys
import tempfile
import zlib
from pathlib import Path

from data_ingestion.sql_to_vector_db.process_anandalib_dump import (
    import_ananda_library_dump,
)

LIBRARY_NAME = "Ananda Library"
ACCESS_FIELD = "luca_required_access_level"
LOCAL_MYSQL_HOST = "127.0.0.1"
LOCAL_MYSQL_PORT = 3307


def materialize_sql_dump(source: Path, dest_dir: Path) -> Path:
    """Return a plain SQL file. Gzip members ignore any HTML trailer."""
    source = Path(source)
    if not str(source).endswith(".gz"):
        return source
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / source.name[: -len(".gz")]
    decompressor = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    with source.open("rb") as compressed, dest.open("wb") as plain:
        while True:
            chunk = compressed.read(1024 * 1024)
            if not chunk:
                break
            plain.write(decompressor.decompress(chunk))
            if decompressor.eof:
                break
    if not decompressor.eof:
        raise zlib.error(f"truncated gzip: {source}")
    return dest


def compose_file(repo_root: Path) -> Path:
    """Path to the laptop MySQL Compose file."""
    return repo_root / "data_ingestion/sql_to_vector_db/docker-compose.yml"


def build_compose_command(repo_root: Path, *action: str) -> list[str]:
    """docker compose command for the Ananda Library MySQL service."""
    return ["docker", "compose", "-f", str(compose_file(repo_root)), *action]


def compose_environment(environ: dict) -> dict:
    """Env for Compose. A non-root DB_USER is created in the container."""
    env = dict(environ)
    user = env.get("DB_USER") or ""
    if user and user != "root":
        env["MYSQL_USER"] = user
        env["MYSQL_PASSWORD"] = env.get("DB_PASSWORD", "")
    else:
        env.pop("MYSQL_USER", None)
        env.pop("MYSQL_PASSWORD", None)
    return env


def local_mysql_environment(environ: dict) -> dict:
    """Point the ingest process at the Compose MySQL, not a remote DB_HOST."""
    env = dict(environ)
    env["DB_HOST"] = LOCAL_MYSQL_HOST
    env["DB_PORT"] = str(LOCAL_MYSQL_PORT)
    return env


def build_ingest_db_argv(
    repo_root: Path, site: str, database: str, *, replace: bool
) -> list[str]:
    """Argv for ingest_db_text. Keep existing vectors unless replace is set."""
    command = [
        sys.executable,
        str(repo_root / "data_ingestion/sql_to_vector_db/ingest_db_text.py"),
        "--site",
        site,
        "--database",
        database,
        "--library-name",
        LIBRARY_NAME,
        "--required-access-level-field",
        ACCESS_FIELD,
    ]
    if not replace:
        command.append("--keep-data")
    return command


def build_catalog_argv(repo_root: Path, site: str, version: str) -> list[str]:
    """Argv for the title-catalog rebuild."""
    return [
        sys.executable,
        str(repo_root / "bin/analyze_title_prefix_catalog.py"),
        "--site",
        site,
        "--write-artifacts",
        "--artifact-version",
        version,
    ]


def build_publish_argv(repo_root: Path, site: str) -> list[str]:
    """Argv for publishing title-catalog artifacts to S3."""
    return [
        str(repo_root / "bin/publish_title_catalog_to_s3.sh"),
        "--site",
        site,
        "--profile",
        "ananda",
    ]


def build_grant_command(repo_root: Path, user: str) -> list[str] | None:
    """Give the Compose app user permission to create the dated database.

    The MySQL image creates MYSQL_USER with no privileges unless MYSQL_DATABASE
    is set. Root is skipped. The password stays inside the container.
    """
    if user == "root":
        return None
    if not re.fullmatch(r"[A-Za-z0-9._-]+", user):
        raise SystemExit(f"DB_USER cannot be granted safely: {user}")
    sql = (
        f"GRANT ALL PRIVILEGES ON *.* TO '{user}'@'%' WITH GRANT OPTION; "
        "FLUSH PRIVILEGES;"
    )
    script = (
        f'mysql --protocol=socket -uroot -p"$MYSQL_ROOT_PASSWORD" -e {shlex.quote(sql)}'
    )
    return [
        *build_compose_command(repo_root, "exec", "-T", "mysql", "bash", "-c", script),
    ]


def confirm_library_replace(replace: bool, prompt) -> None:
    """Require the library name to be typed. --yes does not skip this."""
    if not replace:
        return
    typed = prompt(f"Type '{LIBRARY_NAME}' to delete existing vectors: ")
    if typed.strip() != LIBRARY_NAME:
        raise SystemExit("Library replace cancelled")


def resolve_library_dump(args, publisher, dest_dir: Path) -> Path:
    """Upload a local dump, or download an S3 dump into dest_dir."""
    if getattr(args, "dump", None):
        path = Path(args.dump)
        if not path.is_file():
            raise SystemExit(f"Dump not found: {path}")
        publisher.upload_dump(path, dry_run=False)
        return path
    key = getattr(args, "s3_key", None) or publisher.latest_dump_key()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(key).name
    publisher.download_dump(key, dest)
    return dest


def run_library(
    args,
    *,
    publisher,
    repo_root: Path,
    runner,
    importer=import_ananda_library_dump,
    environ: dict | None = None,
    prompt=input,
    artifact_version: str | None = None,
) -> str:
    """Upload or download the dump, import it, ingest, publish the title catalog."""
    base_env = dict(os.environ if environ is None else environ)
    user = base_env.get("DB_USER")
    password = base_env.get("DB_PASSWORD")
    if not user or not password:
        raise SystemExit("DB_USER and DB_PASSWORD must be set")
    confirm_library_replace(bool(args.replace_library), prompt)

    work = Path(tempfile.mkdtemp(prefix="anandalib-import-"))
    started = False
    succeeded = False
    database_name = ""
    try:
        dump_path = resolve_library_dump(args, publisher, work)
        sql_path = materialize_sql_dump(dump_path, work)
        runner(
            build_compose_command(repo_root, "up", "-d", "--wait"),
            check=True,
            env=compose_environment(base_env),
        )
        started = True
        grant_command = build_grant_command(repo_root, user)
        if grant_command is not None:
            runner(
                grant_command,
                check=True,
                env=compose_environment(base_env),
            )
        database_name = importer(
            str(sql_path),
            user,
            password=password,
            host=LOCAL_MYSQL_HOST,
            port=LOCAL_MYSQL_PORT,
        )
        local_env = local_mysql_environment(base_env)
        version = artifact_version or f"{args.site}-catalog"
        runner(
            build_ingest_db_argv(
                repo_root,
                args.site,
                database_name,
                replace=bool(args.replace_library),
            ),
            check=True,
            env=local_env,
        )
        runner(
            build_catalog_argv(repo_root, args.site, version),
            check=True,
            env=local_env,
        )
        runner(build_publish_argv(repo_root, args.site), check=True, env=local_env)
        succeeded = True
    finally:
        if started:
            down_args = ("down", "-v") if succeeded else ("down",)
            runner(
                build_compose_command(repo_root, *down_args),
                check=False,
                env=compose_environment(base_env),
            )
        shutil.rmtree(work, ignore_errors=True)
    return database_name
