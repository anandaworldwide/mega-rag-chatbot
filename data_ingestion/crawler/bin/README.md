# Crawler Utility Scripts

## Python Utilities

| Script                            | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `check_priority_due.py`           | Check which priority URLs are due for crawling |
| `check_robots_compliance.py`      | Validate URLs against robots.txt rules         |
| `cleanup_old_pinecone_vectors.py` | Remove stale vectors from Pinecone index       |
| `delete_by_skip_pattern.py`       | Delete URLs matching configured skip patterns  |
| `log_rotate.py`                   | Rotate and compress crawler log files          |
| `pinecone_health_check.py`        | Verify Pinecone connectivity and index health  |

## AWS/ECS Deployment

| Script                           | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `aws-setup.sh`                   | One-time AWS infrastructure setup (ECR, ECS cluster) |
| `build-and-push.sh`              | Build Docker image and push to ECR                   |
| `register-task-definition.sh`    | Register new ECS task definition revision            |
| `update-schedule-for-service.sh` | Update EventBridge schedule with new task definition |
| `setup-spot-capacity.sh`         | Configure Fargate Spot capacity provider             |
| `create-secrets-json.sh`         | Create AWS Secrets Manager secret from .env file     |

## Database Operations

| Script                          | Description                          |
| ------------------------------- | ------------------------------------ |
| `copy-database-to-efs.sh`       | Upload local SQLite DB to EFS mount  |
| `download-database-from-efs.sh` | Download SQLite DB from EFS to local |

## Local Operations

| Script                     | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `cleanup-docker-images.sh` | Remove old/unused Docker images locally            |
| `manage_crawler.sh`        | Start/stop/status wrapper for local crawler daemon |
| `service-control.sh`       | Control crawler LaunchAgent service                |
