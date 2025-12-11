# Cloud Deployment Guide - Ananda Crawler

Deploy the Ananda crawler to AWS ECS Fargate for scheduled execution (9am-5pm PT daily).

## Architecture

- **Container**: Docker image in ECR (us-west-1)
- **Compute**: ECS Fargate (0.5 vCPU, 1GB RAM)
- **Storage**: EFS for SQLite database and logs (persistent across runs)
- **Scheduling**: EventBridge (starts at 9am PT daily)
- **Secrets**: AWS Secrets Manager for environment variables
- **Logging**: CloudWatch Logs

## Prerequisites

- [ ] AWS CLI installed (`aws --version`)
- [ ] AWS credentials configured (`aws configure`)
- [ ] Docker installed (`docker --version`)
- [ ] Local crawler has been run at least once (creates database)
- [ ] `.env.ananda-public` file exists with all required variables
- [ ] AWS account permissions for: ECR, ECS, EFS, IAM, Secrets Manager, EventBridge, CloudWatch Logs

## Step-by-Step Deployment

### Step 1: Create AWS Infrastructure

Creates all required AWS resources (ECR, EFS, ECS cluster, IAM roles, etc.):

```bash
cd data_ingestion/crawler
./aws-setup.sh
```

**Creates**: ECR repository, EFS filesystem with access point, ECS cluster, IAM roles, CloudWatch log group, Secrets
Manager secret (placeholder)

**Note**: Save the EFS ID from the output for later use.

---

### Step 2: Prepare Secrets

Create a JSON file with your environment variables:

```bash
# Use helper script to generate secrets.json from your .env file
./create-secrets-json.sh ananda-public

# Review the generated file
cat secrets.json

# Update Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id ananda-crawler-secrets \
  --secret-string file://secrets.json \
  --region us-west-1
```

**Security**: Never commit `secrets.json` to git (already in `.gitignore`).

---

### Step 3: Build and Push Docker Image

Build and push the Docker image to ECR:

```bash
# Build and push with 'latest' tag
./build-and-push.sh

# Or use semantic versioning
./build-and-push.sh v1.0.0
```

---

### Step 4: Register ECS Task Definition

Register the task definition that tells ECS how to run your container:

```bash
# Use 'latest' tag
./register-task-definition.sh

# Or specify a version tag
./register-task-definition.sh v1.0.0
```

**Configures**: Docker image reference, CPU/memory (0.5 vCPU, 1GB RAM), EFS mount (`/app/data`), environment variables
from Secrets Manager, CloudWatch logging, max runtime (8 hours)

---

### Step 5: Copy SQLite Database to EFS

**IMPORTANT**: Copy your current crawl state to the cloud so the crawler continues where it left off.

```bash
./copy-database-to-efs.sh
```

**What it does**: Finds local database (`data_ingestion/crawler/db/crawler_queue_ananda-public.db`), starts temporary
ECS task to access EFS, copies database to `/app/data/db/` on EFS, verifies copy, stops temporary task

**Troubleshooting**: If database file not found, run the crawler locally once first.

---

### Step 6: Create EventBridge Schedule (Optional)

Create the daily schedule that starts the crawler at 9am PT:

```bash
./create-schedule.sh
```

**Note**: Skip this if you want manual control only (use `manual-control.sh`).

---

### Step 7: Test the Deployment

Verify everything works:

```bash
# Start crawler manually in cloud
./manual-control.sh start-cloud

# Check status
./manual-control.sh status-cloud

# View logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1
```

**What to look for**: Task starts successfully, logs show crawler initialization, no database/EFS mount errors, crawler
begins processing URLs

## Transition Period: Laptop ↔ Cloud

During transition, you can run on either laptop or cloud, but **never both simultaneously**.

### Stop Laptop, Start Cloud

```bash
# 1. Stop laptop service
./manual-control.sh stop-laptop

# 2. (Optional) Disable automatic schedule for manual control
./manual-control.sh disable-schedule

# 3. Start cloud crawler
./manual-control.sh start-cloud

# 4. Verify it's running
./manual-control.sh status-cloud
```

### Stop Cloud, Start Laptop

```bash
# 1. Stop cloud task
./manual-control.sh stop-cloud

# 2. Start laptop service
launchctl start com.ananda.crawler

# 3. Verify it's running
launchctl list com.ananda.crawler
```

### Schedule Management

```bash
# Disable automatic schedule (for manual control)
./manual-control.sh disable-schedule

# Enable automatic schedule (9am PT daily start)
./manual-control.sh enable-schedule
```

**Important**: Always verify one is stopped before starting the other to avoid duplicate crawling. If switching, you may
want to copy the database again:

- **Laptop → Cloud**: Run `copy-database-to-efs.sh`
- **Cloud → Laptop**: Copy from EFS to local (requires ECS exec or EC2 instance)

## Monitoring

### View Logs

```bash
# Real-time logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1

# Recent logs (last hour)
aws logs tail /ecs/ananda-crawler --since 1h --region us-west-1
```

### Check Task Status

```bash
# List running tasks
aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1

# Get detailed task info
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1
```

### Check EFS Storage

```bash
EFS_ID=$(aws efs describe-file-systems --region us-west-1 --query "FileSystems[?Name=='ananda-crawler-efs'].FileSystemId" --output text)
aws efs describe-file-systems --file-system-id "$EFS_ID" --region us-west-1
```

## Troubleshooting

### Database Copy Failed

1. Verify local database exists:

   ```bash
   ls -lh data_ingestion/crawler/db/crawler_queue_ananda-public.db
   ```

2. Check EFS was created:

   ```bash
   aws efs describe-file-systems --region us-west-1 --query "FileSystems[?Name=='ananda-crawler-efs']"
   ```

3. Try manual copy via ECS exec (if task is running):

   ```bash
   ./manual-control.sh start-cloud
   TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
   aws ecs execute-command --cluster ananda-crawler-cluster --task "$TASK_ARN" --container crawler --command "/bin/bash" --interactive --region us-west-1
   ```

### Task Fails to Start

1. Check CloudWatch logs:

   ```bash
   aws logs tail /ecs/ananda-crawler --since 30m --region us-west-1
   ```

2. Verify secrets are set correctly:

   ```bash
   aws secretsmanager get-secret-value --secret-id ananda-crawler-secrets --region us-west-1 --query SecretString --output text | jq .
   ```

3. Verify task definition exists:

   ```bash
   aws ecs describe-task-definition --task-definition ananda-crawler-task --region us-west-1
   ```

### EFS Mount Issues

1. Verify EFS mount targets exist:

   ```bash
   EFS_ID=$(aws efs describe-file-systems --region us-west-1 --query "FileSystems[?Name=='ananda-crawler-efs'].FileSystemId" --output text)
   aws efs describe-mount-targets --file-system-id "$EFS_ID" --region us-west-1
   ```

2. Check security group allows NFS (port 2049) from VPC

3. Verify task has IAM permissions for EFS

### Schedule Not Running

1. Check schedule state:

   ```bash
   aws scheduler get-schedule --name ananda-crawler-start --region us-west-1
   ```

2. Check execution history:

   ```bash
   aws scheduler list-schedule-executions --schedule-name ananda-crawler-start --region us-west-1
   ```

## Maintenance

### Updating the Image

1. Make code changes
2. Build and push new image:

   ```bash
   ./build-and-push.sh v1.0.1
   ```

3. Register new task definition:

   ```bash
   ./register-task-definition.sh v1.0.1
   ```

4. New tasks will use the updated image automatically

### Updating Secrets

```bash
# Update secret values
aws secretsmanager put-secret-value \
  --secret-id ananda-crawler-secrets \
  --secret-string file://secrets.json \
  --region us-west-1

# Restart tasks to pick up new secrets
./manual-control.sh stop-cloud
./manual-control.sh start-cloud
```

### Database Backup

The SQLite database is stored on EFS. To backup:

1. Use ECS exec to access the container
2. Copy database from `/app/data/db/` to S3 or local machine
3. Or use EFS backup service (AWS Backup)

## Cost Estimation

**Monthly costs** (8 hours/day, 30 days):

- **ECS Fargate**: ~$10-15 (0.5 vCPU × 1GB × 240 hours)
- **EFS**: ~$1-2 (minimal storage, bursting throughput)
- **ECR**: ~$0.10 (image storage)
- **CloudWatch Logs**: ~$1-2 (log ingestion and storage)
- **Secrets Manager**: ~$0.40 (one secret)
- **EventBridge**: Free tier covers this use case

**Total**: ~$12-20/month

## Quick Reference Commands

```bash
# Start cloud crawler
./manual-control.sh start-cloud

# Stop cloud crawler
./manual-control.sh stop-cloud

# Check status
./manual-control.sh status-cloud

# View logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1

# Copy database to EFS
./copy-database-to-efs.sh

# Update secrets
aws secretsmanager put-secret-value --secret-id ananda-crawler-secrets --secret-string file://secrets.json --region us-west-1

# Update image and redeploy
./build-and-push.sh v1.0.1
./register-task-definition.sh v1.0.1
```

## Handoff Checklist

When transferring ownership:

- [ ] Document AWS account and region
- [ ] Share IAM user credentials or role ARNs
- [ ] Document Secrets Manager secret name and location
- [ ] Share ECR repository URI
- [ ] Document ECS cluster and task family names
- [ ] Share EventBridge schedule name
- [ ] Document EFS filesystem ID
- [ ] Provide CloudWatch log group name
- [ ] Test manual start/stop procedures
- [ ] Verify schedule runs correctly
- [ ] Document any custom configurations

## Support

For issues or questions:

1. Check CloudWatch logs first
2. Review this documentation
3. Check AWS service health dashboards
4. Contact AWS support if infrastructure issues
