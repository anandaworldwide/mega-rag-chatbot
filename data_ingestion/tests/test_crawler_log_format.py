"""Log format tests for the crawler."""

from crawler.config import crawler_log_format

_ECS_ENV_NAMES = (
    "ECS_CONTAINER_METADATA_URI_V4",
    "ECS_CONTAINER_METADATA_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_EXECUTION_ENV",
)


def _clear_ecs_env(monkeypatch) -> None:
    for name in _ECS_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def test_docker_omits_python_time(monkeypatch):
    """Docker stdout goes to the journal, so the Python time is absent."""
    _clear_ecs_env(monkeypatch)
    monkeypatch.setattr(
        "crawler.config.Path.is_file",
        lambda self: str(self) == "/.dockerenv",
    )

    assert crawler_log_format() == "%(levelname)s - %(message)s"


def test_local_process_keeps_python_time(monkeypatch):
    """A process outside Docker keeps the Python time."""
    _clear_ecs_env(monkeypatch)
    monkeypatch.setattr("crawler.config.Path.is_file", lambda self: False)

    assert crawler_log_format() == "%(asctime)s - %(levelname)s - %(message)s"


def test_ecs_omits_python_time(monkeypatch):
    """CloudWatch writes the time, so the Python time is absent."""
    _clear_ecs_env(monkeypatch)
    monkeypatch.setenv("AWS_EXECUTION_ENV", "AWS_ECS_FARGATE")
    monkeypatch.setattr("crawler.config.Path.is_file", lambda self: False)

    assert crawler_log_format() == "%(levelname)s - %(message)s"
