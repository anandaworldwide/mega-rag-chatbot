"""Tests for non-interactive Ananda Library dump import."""

from data_ingestion.sql_to_vector_db.process_anandalib_dump import import_database


def test_import_database_uses_defaults_file_instead_of_password_prompt(tmp_path):
    sql_file = tmp_path / "dump.sql"
    sql_file.write_text("SELECT 1;\n", encoding="utf-8")
    seen = []

    def runner(command, **kwargs):
        defaults_arg = next(
            part for part in command if str(part).startswith("--defaults-extra-file=")
        )
        defaults_path = defaults_arg.split("=", 1)[1]
        with open(defaults_path, encoding="utf-8") as defaults_file:
            defaults_text = defaults_file.read()
        seen.append((list(command), kwargs.get("stdin") is not None, defaults_text))
        return None

    import_database(
        str(sql_file),
        "anandalib_2026_09_26",
        "root",
        password="secret-pass",
        host="127.0.0.1",
        port=3306,
        runner=runner,
    )

    assert len(seen) == 2
    create_command, create_has_stdin, defaults_text = seen[0]
    import_command, import_has_stdin, _ = seen[1]
    assert "-p" not in create_command
    assert "-p" not in import_command
    assert "CREATE DATABASE IF NOT EXISTS `anandalib_2026_09_26`" in create_command
    assert import_command[-1] == "anandalib_2026_09_26"
    assert create_has_stdin is False
    assert import_has_stdin is True
    assert "password=secret-pass" in defaults_text
    assert "host=127.0.0.1" in defaults_text
    assert "port=3306" in defaults_text
    assert "user=root" in defaults_text
