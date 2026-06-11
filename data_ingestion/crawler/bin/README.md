# Crawler Utility Scripts

## Python Utilities

| Script                            | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `check_priority_due.py`           | Check which priority URLs are due for crawling |
| `check_robots_compliance.py`      | Validate URLs against robots.txt rules         |
| `cleanup_old_pinecone_vectors.py` | Remove stale vectors from Pinecone index       |
| `delete_by_skip_pattern.py`       | Delete URLs matching configured skip patterns  |
| `reconcile_orphaned_vectors.py`   | Find/delete Pinecone vectors whose URL has no live crawl_queue row. Weekly prod: `--apply-if-safe --email-report --max-runtime-seconds 7140` (2h systemd timer in `deploy/vm/`). |
| `log_rotate.py`                   | Rotate and compress crawler log files          |
| `pinecone_health_check.py`        | Verify Pinecone connectivity and index health  |

## Local Operations

| Script                     | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `cleanup-docker-images.sh` | Remove old/unused Docker images locally            |
| `manage_crawler.sh`        | Start/stop/status wrapper for local crawler daemon |

Production deployment on a dedicated VM (Docker + systemd) is documented in
[../CLOUD-DEPLOYMENT.md](../CLOUD-DEPLOYMENT.md#switching-between-production-vm-and-local). **systemd unit/timer samples**
and backup scripts: [../deploy/vm/README.md](../deploy/vm/README.md).
