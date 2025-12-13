# Cloud Deployment Guide - Ananda Crawler

> **Note**: Cloud deployment is **optional**. The crawler can be run in two ways:
>
> - **Cloud Mode**: Deploy to AWS ECS Fargate for scheduled execution (this guide)
> - **Local Mode**: Run directly on a laptop or desktop computer using `python website_crawler.py --site <site-name>`
>
> This guide covers cloud deployment. For local execution, see the main crawler documentation.

Deploy the Ananda crawler to AWS ECS Fargate for scheduled execution.

## 🚀 Cost Optimization Available

**New**: Automatic Fargate Spot capacity with 70%+ cost savings! See [SPOT-CAPACITY-README.md](SPOT-CAPACITY-README.md)
for setup.

## Architecture

- **Container**: Docker image in ECR (us-west-1)
- **Compute**: ECS Fargate (0.5 vCPU, 1GB RAM)
- **Storage**: EFS for SQLite database and logs (persistent across runs)
- **Scheduling**: EventBridge Scheduler (hourly during active hours, PT timezone)
- **Secrets**: AWS Secrets Manager for environment variables
- **Logging**: CloudWatch Logs
- **Network**: Public subnet with public IP assignment (NAT-less, cost-optimized)
- **Security**: Hardened security groups and NACLs (outbound-only, no inbound ports)

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
Manager secret (placeholder), hardened security group for crawler tasks

**Note**: Save the EFS ID from the output for later use.

**Cost Optimization**: After basic setup, run `./setup-spot-capacity.sh` to enable automatic Fargate Spot capacity with
70%+ cost savings. See [SPOT-CAPACITY-README.md](SPOT-CAPACITY-README.md).

**Security**: The setup script creates a hardened security group (`crawler-hardened-sg`) with:

- **Inbound**: Deny all (no ports exposed)
- **Outbound**: HTTPS (443) and HTTP (80) only for web crawling
- **Public IP**: Enabled for outbound internet access (avoids NAT Gateway costs)

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

**Security Hardening**:

- No port mappings (container doesn't expose any ports)
- Public IP assignment enabled (for outbound-only access)
- Hardened security group attached (inbound deny-all, outbound HTTPS/HTTP only)
- Read-only root filesystem (where compatible)
- Non-root user execution

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

Create the hourly schedule (7am–10pm PT) that runs one short task per hour:

```bash
./update-schedule-for-service.sh
```

This schedule uses `America/Los_Angeles` timezone (no UTC/DST math) and runs the crawler as a **one-shot ECS task** (no
always-on service required).

---

### Step 7: Enable Cost Optimization (Recommended)

Use Fargate Spot capacity for 70%+ cost savings:

```bash
# Update EventBridge schedule to use Spot capacity (recommended)
./update-schedule-for-service.sh
```

If you want to run the crawler as an **always-on ECS service** (continuous mode), you can still do that (optional):

```bash
./setup-spot-capacity.sh
./service-control.sh start
./service-control.sh status
```

### Step 8: Test the Deployment

Verify everything works:

```bash
# Check schedule configuration
aws scheduler get-schedule --name ananda-crawler-start --region us-west-1 --output table

# Trigger a one-shot run immediately (optional)
# (Uses Spot with on-demand fallback, and will exit automatically after max-runtime-minutes)
aws ecs run-task --cluster ananda-crawler-cluster --region us-west-1 \
  --task-definition ananda-crawler-task \
  --count 1 \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=95 capacityProvider=FARGATE,weight=5 \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-69894a33],securityGroups=[sg-00cff461f9ad3d8b2],assignPublicIp=ENABLED}'

# View logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1
```

**What to look for**: Task starts successfully, logs show crawler initialization, no database/EFS mount errors, crawler
begins processing URLs. With Spot capacity, check that tasks show `capacityProviderName` as your Spot provider.

## Transition Period: Laptop ↔ Cloud

During transition, you can run on either laptop or cloud, but **never both simultaneously**.

### Stop Laptop, Start Cloud

```bash
# 1. Stop laptop service
./manage_crawler.sh stop

# 2. Cloud runs automatically on schedule (hourly 7am-11pm PT)
# Or trigger a manual run:
aws ecs run-task --cluster ananda-crawler-cluster --region us-west-1 \
  --task-definition ananda-crawler-task \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=95 capacityProvider=FARGATE,weight=5 \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-69894a33],securityGroups=[sg-00cff461f9ad3d8b2],assignPublicIp=ENABLED}"

# 3. Check status
aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1
```

### Stop Cloud, Start Laptop

```bash
# 1. Stop any running cloud tasks
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
aws ecs stop-task --cluster ananda-crawler-cluster --task "$TASK_ARN" --region us-west-1

# 2. Start laptop service
./manage_crawler.sh start

# 3. Verify it's running
./manage_crawler.sh status
```

### Schedule Management

```bash
# Check schedule status
aws scheduler get-schedule --name ananda-crawler-start --region us-west-1 --query '{State:State,Schedule:ScheduleExpression}' --output table

# Disable schedule (for manual control)
aws scheduler update-schedule --name ananda-crawler-start --region us-west-1 --state DISABLED \
  --schedule-expression "cron(0 7-23 * * ? *)" --schedule-expression-timezone "America/Los_Angeles" \
  --flexible-time-window '{"Mode":"OFF"}' --target "$(aws scheduler get-schedule --name ananda-crawler-start --region us-west-1 --query 'Target' --output json)"

# Enable schedule
aws scheduler update-schedule --name ananda-crawler-start --region us-west-1 --state ENABLED \
  --schedule-expression "cron(0 7-23 * * ? *)" --schedule-expression-timezone "America/Los_Angeles" \
  --flexible-time-window '{"Mode":"OFF"}' --target "$(aws scheduler get-schedule --name ananda-crawler-start --region us-west-1 --query 'Target' --output json)"
```

**Important**: Always verify one is stopped before starting the other to avoid duplicate crawling. If switching, you may
want to copy the database again:

- **Laptop → Cloud**: Run `copy-database-to-efs.sh`
- **Cloud → Laptop**: Copy from EFS to local (requires ECS exec or EC2 instance)

## Security Hardening (NAT-less Configuration)

This deployment uses **public subnets with public IP assignment** to avoid NAT Gateway costs (~$32/month). The crawler
is hardened for outbound-only operation with zero inbound exposure.

### Network Architecture

- **Subnets**: Public subnets with routes to Internet Gateway (IGW)
- **Public IP**: Enabled per task for direct outbound internet access
- **No NAT Gateway**: Cost savings (~$32/month avoided)
- **Security Model**: Outbound-initiated connections only (web crawling)

### Security Group Configuration

The hardened security group (`crawler-hardened-sg`) enforces:

**Inbound Rules**:

- Deny all (default AWS behavior, explicitly documented)
- No ports exposed (container has no port mappings)

**Outbound Rules**:

- HTTPS (TCP 443) to `0.0.0.0/0` - Web crawling
- HTTP (TCP 80) to `0.0.0.0/0` - Legacy sites
- DNS (UDP/TCP 53) to AmazonProvidedDNS - Name resolution
- All other traffic denied

**Why This Works**:

- Security Groups are stateful (responses to outbound connections auto-allowed)
- No inbound ports = no attack surface
- Public IP is discoverable but inert (nothing listening)
- Ephemeral containers (Fargate) provide isolation

### Network ACL (NACL) Hardening (Optional)

For additional subnet-level protection, configure NACLs:

**Inbound NACL Rules**:

- Rule #100: DENY All from `0.0.0.0/0` (explicit deny)

**Outbound NACL Rules**:

- Rule #100: ALLOW TCP 80/443 to `0.0.0.0/0` (crawler traffic)
- Rule #200: ALLOW TCP/UDP 1024-65535 to `0.0.0.0/0` (ephemeral return ports)
- Rule #32767: DENY All (default deny)

**Note**: NACLs are stateless (unlike Security Groups), so return traffic must be explicitly allowed. Security Groups
provide primary protection; NACLs add defense-in-depth.

### Container Hardening

Task definition includes:

- **No Port Mappings**: Container doesn't expose any ports
- **Read-only Root Filesystem**: Where compatible (EFS mount provides writable `/app/data`)
- **Non-root User**: Container runs as UID 1000 (configured in Dockerfile)
- **Minimal IAM Permissions**: Task role only has access to required services (Secrets Manager, S3, CloudWatch Logs)

### Security Validation

After deployment, verify hardening:

```bash
# 1. Get task public IP
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
PUBLIC_IP=$(aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1 \
    --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text | \
    xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --region us-west-1 \
    --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

# 2. Scan for open ports (should show all filtered/closed)
nmap -p- "$PUBLIC_IP"

# 3. Verify outbound connectivity (from container logs)
aws logs tail /ecs/ananda-crawler --follow --region us-west-1
# Look for successful HTTP requests to external sites

# 4. Verify security group rules
SG_ID=$(aws ec2 describe-security-groups --region us-west-1 \
    --filters "Name=group-name,Values=crawler-hardened-sg" \
    --query 'SecurityGroups[0].GroupId' --output text)
aws ec2 describe-security-groups --group-ids "$SG_ID" --region us-west-1
```

### Monitoring and Detection

**CloudWatch Logs**: Enabled for all container output

- Log group: `/ecs/ananda-crawler`
- Monitor for errors, connection failures, or suspicious activity

**VPC Flow Logs** (Optional, ~$0.50/GB):

```bash
# Enable on crawler subnets to monitor traffic
aws ec2 create-flow-logs \
    --resource-type Subnet \
    --resource-ids subnet-xxx subnet-yyy \
    --traffic-type ALL \
    --log-destination-type cloud-watch-logs \
    --log-group-name /vpc/crawler-flow-logs \
    --region us-west-1
```

**GuardDuty** (Free tier available):

- Enable for VPC threat detection
- Alerts on port scans, suspicious traffic patterns

**CloudWatch Alarms**:

- Monitor rejected security group rules (indicates probe attempts)
- Alert on unusual outbound traffic volume

### Operational Checklist

Before deploying:

- [ ] Verify VPC has public subnets with routes to IGW
- [ ] Confirm hardened security group created (`crawler-hardened-sg`)
- [ ] Ensure task definition has no port mappings
- [ ] Verify `assignPublicIp=ENABLED` in network configuration
- [ ] Test outbound connectivity after deployment
- [ ] Run `nmap` scan to verify no open ports
- [ ] Review CloudWatch logs for successful crawler operation

### Rollback Procedure

If outbound access fails:

1. Check security group rules (ensure HTTPS/HTTP outbound allowed)
2. Verify subnet route table (must have `0.0.0.0/0` → IGW)
3. Check task logs for connection errors
4. Verify public IP assignment: `aws ecs describe-tasks --tasks <arn>`
5. If issues persist, temporarily enable NAT Gateway for debugging (accept cost)

### Cost Comparison

**Current (Public Subnet)**:

- Public IP: Free (included with Fargate)
- Internet Gateway: Free
- **Total**: $0/month for networking

**Alternative (Private Subnet + NAT)**:

- NAT Gateway: ~$32/month + data transfer
- **Total**: ~$32-40/month

**Trade-off**: Public IPs are discoverable but inert (no ports = no attack surface). Security Groups provide primary
protection.

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

### Verify Security Configuration

```bash
# Check security group rules
SG_ID=$(aws ec2 describe-security-groups --region us-west-1 \
    --filters "Name=group-name,Values=crawler-hardened-sg" \
    --query 'SecurityGroups[0].GroupId' --output text)
aws ec2 describe-security-groups --group-ids "$SG_ID" --region us-west-1

# Verify task has public IP and no port mappings
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1 \
    --query 'tasks[0].{PublicIP:attachments[0].details[?name==`networkInterfaceId`].value,PortMappings:containers[0].networkBindings}'

# Scan task public IP (should show all ports filtered)
PUBLIC_IP=$(aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1 \
    --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text | \
    xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --region us-west-1 \
    --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
echo "Scanning $PUBLIC_IP (should show all ports filtered)..."
nmap -p- "$PUBLIC_IP" || echo "nmap not installed - install to verify port security"
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
   # Start a task if none running
   aws ecs run-task --cluster ananda-crawler-cluster --region us-west-1 \
     --task-definition ananda-crawler-task --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[subnet-69894a33],securityGroups=[sg-00cff461f9ad3d8b2],assignPublicIp=ENABLED}"

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

### Updating Production with Security Hardening

To apply the NAT-less security hardening to an existing deployment:

1. **Ensure hardened security group exists**:

   ```bash
   # Run setup script to create hardened SG (idempotent - won't recreate if exists)
   ./aws-setup.sh
   ```

   Or verify it exists:

   ```bash
   aws ec2 describe-security-groups --region us-west-1 \
       --filters "Name=group-name,Values=crawler-hardened-sg" \
       --query 'SecurityGroups[0].GroupId' --output text
   ```

2. **Stop any running tasks** (to avoid conflicts):

   ```bash
   TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
   [ "$TASK_ARN" != "None" ] && aws ecs stop-task --cluster ananda-crawler-cluster --task "$TASK_ARN" --region us-west-1
   ```

3. **Rebuild Docker image** with updated Dockerfile (non-root user):

   ```bash
   ./build-and-push.sh v1.0.1
   # Or use 'latest' tag
   ./build-and-push.sh
   ```

4. **Re-register task definition** with hardening settings:

   ```bash
   ./register-task-definition.sh v1.0.1
   # Or use 'latest' tag
   ./register-task-definition.sh
   ```

5. **Update EventBridge schedule** to use hardened SG and public IP:

   ```bash
   ./update-schedule-for-service.sh
   ```

6. **Restart tasks** with new configuration:

   ```bash
   aws ecs run-task --cluster ananda-crawler-cluster --region us-west-1 \
     --task-definition ananda-crawler-task \
     --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=95 capacityProvider=FARGATE,weight=5 \
     --network-configuration "awsvpcConfiguration={subnets=[subnet-69894a33],securityGroups=[sg-00cff461f9ad3d8b2],assignPublicIp=ENABLED}"
   ```

7. **Verify security configuration**:

   ```bash
   # Check task has public IP
   TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
   aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1 \
       --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text | \
       xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --region us-west-1 \
       --query 'NetworkInterfaces[0].Association.PublicIp' --output text

   # Verify logs show successful outbound connections
   aws logs tail /ecs/ananda-crawler --follow --region us-west-1
   ```

### Updating the Image (General)

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

# Stop existing tasks and start new ones to pick up updated secrets
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
[ "$TASK_ARN" != "None" ] && aws ecs stop-task --cluster ananda-crawler-cluster --task "$TASK_ARN" --region us-west-1
# New task starts on next scheduled run, or trigger manually
```

### Database Backup

The SQLite database is stored on EFS. To backup:

1. Use ECS exec to access the container
2. Copy database from `/app/data/db/` to S3 or local machine
3. Or use EFS backup service (AWS Backup)

## Cost Estimation

**Monthly costs** (8 hours/day, 30 days):

### With Fargate Spot (Recommended - 70% savings)

- **ECS Fargate Spot**: ~$4-6 (0.5 vCPU × 1GB × 240 hours, 70% discount)
- **EFS**: ~$1-2 (minimal storage, bursting throughput)
- **ECR**: ~$0.10 (image storage)
- **CloudWatch Logs**: ~$1-2 (log ingestion and storage)
- **Secrets Manager**: ~$0.40 (one secret)
- **EventBridge**: Free tier covers this use case

**Total**: ~$6-11/month

### With Fargate On-Demand (Legacy)

- **ECS Fargate**: ~$10-15 (0.5 vCPU × 1GB × 240 hours)
- **EFS**: ~$1-2 (minimal storage, bursting throughput)
- **ECR**: ~$0.10 (image storage)
- **CloudWatch Logs**: ~$1-2 (log ingestion and storage)
- **Secrets Manager**: ~$0.40 (one secret)
- **EventBridge**: Free tier covers this use case

**Total**: ~$12-20/month

## Quick Reference Commands

### Scheduled Runs (Recommended)

```bash
# Update/verify schedule (hourly 7am–10pm PT)
./update-schedule-for-service.sh

# Check schedule details
aws scheduler get-schedule --name ananda-crawler-start --region us-west-1 --output table
```

### Manual Task Control

```bash
# Start a one-shot task manually
aws ecs run-task --cluster ananda-crawler-cluster --region us-west-1 \
  --task-definition ananda-crawler-task \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=95 capacityProvider=FARGATE,weight=5 \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-69894a33],securityGroups=[sg-00cff461f9ad3d8b2],assignPublicIp=ENABLED}"

# Stop a running task
TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
aws ecs stop-task --cluster ananda-crawler-cluster --task "$TASK_ARN" --region us-west-1

# Check task status
aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1
aws logs tail /ecs/ananda-crawler --since 10m --region us-west-1
```

### Continuous Service Mode (Optional / Legacy)

```bash
# Start/stop always-on ECS service (runs continuously until stopped)
./service-control.sh start
./service-control.sh stop
./service-control.sh status
```

### General Commands

```bash
# View logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1

# Copy database to EFS
./copy-database-to-efs.sh

# Update secrets
aws secretsmanager put-secret-value --secret-id ananda-crawler-secrets --secret-string file://secrets.json --region us-west-1

# Update image and redeploy
./build-and-push.sh v1.0.1
./register-task-definition.sh v1.0.1

# Setup Spot capacity (one-time)
./setup-spot-capacity.sh

# Update schedule for Spot capacity (one-time)
./update-schedule-for-service.sh
```

## NAT-less Deployment Checklist

Before deploying with public subnet configuration:

### Infrastructure Setup

- [ ] VPC has public subnets with routes to Internet Gateway (IGW)
- [ ] Hardened security group created (`crawler-hardened-sg`) with:
  - [ ] Inbound: Deny all (default, no ports exposed)
  - [ ] Outbound: HTTPS (443), HTTP (80), DNS (53) only
- [ ] EFS security group allows NFS (2049) from VPC CIDR
- [ ] Task definition has no port mappings
- [ ] Task definition sets `assignPublicIp=ENABLED` in network configuration
- [ ] Container runs as non-root user (UID 1000)

### Security Validation Checklist

- [ ] Run task and verify public IP assignment:

  ```bash
  TASK_ARN=$(aws ecs list-tasks --cluster ananda-crawler-cluster --region us-west-1 --query 'taskArns[0]' --output text)
  aws ecs describe-tasks --cluster ananda-crawler-cluster --tasks "$TASK_ARN" --region us-west-1 \
      --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value'
  ```

- [ ] Scan public IP with `nmap` - all ports should be filtered/closed
- [ ] Verify outbound connectivity in CloudWatch logs (successful HTTP requests)
- [ ] Confirm no inbound connection attempts succeed

### Optional Hardening

- [ ] Configure NACLs for subnet-level protection (defense-in-depth)
- [ ] Enable VPC Flow Logs for traffic monitoring
- [ ] Enable GuardDuty for threat detection
- [ ] Set up CloudWatch alarms for rejected security group rules

### Rollback Plan

If outbound access fails:

1. Verify security group outbound rules (HTTPS/HTTP allowed)
2. Check subnet route table (`0.0.0.0/0` → IGW)
3. Review CloudWatch logs for connection errors
4. Verify public IP assignment in task details
5. If needed, temporarily enable NAT Gateway for debugging (accept cost)

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
- [ ] Document hardened security group ID (`crawler-hardened-sg`)
- [ ] Document network configuration (public subnet, public IP enabled)
- [ ] Test manual start/stop procedures
- [ ] Verify schedule runs correctly
- [ ] Document any custom configurations
- [ ] Share security validation test results (nmap scan)

## Support

For issues or questions:

1. Check CloudWatch logs first
2. Review this documentation
3. Check AWS service health dashboards
4. Contact AWS support if infrastructure issues
