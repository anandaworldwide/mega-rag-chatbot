#!/bin/bash
# Copy SQLite database from local machine to EFS
# This allows the cloud crawler to start with the current crawl state

set -e

# Global variable to track task ARN for cleanup
CLEANUP_TASK_ARN=""

# Cleanup function to stop temporary task if script is interrupted
cleanup() {
    if [ -n "$CLEANUP_TASK_ARN" ]; then
        echo ""
        echo -e "${YELLOW}Cleaning up temporary task...${NC}"
        aws ecs stop-task \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --task "$CLEANUP_TASK_ARN" \
            --reason "Script interrupted" > /dev/null 2>&1 || true
        echo -e "${YELLOW}Temporary task stopped${NC}"
    fi
}

# Set trap to cleanup on exit (including Ctrl+C)
trap cleanup EXIT INT TERM

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
SITE_ID="ananda-public"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Copying SQLite database to EFS...${NC}"

# Step 1: Find local database file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Database is in ../db/ relative to bin/ directory
LOCAL_DB_FILE="${SCRIPT_DIR}/../db/crawler_queue_${SITE_ID}.db"

if [ ! -f "$LOCAL_DB_FILE" ]; then
    echo -e "${RED}Error: Local database file not found at:${NC}"
    echo -e "${RED}  $LOCAL_DB_FILE${NC}"
    echo ""
    echo "Please ensure the crawler has been run locally first to create the database."
    exit 1
fi

echo -e "${GREEN}✓ Found local database: $LOCAL_DB_FILE${NC}"

# Step 2: Get EFS filesystem ID
echo -e "\n${YELLOW}Step 1: Finding EFS filesystem...${NC}"
EFS_ID=$(aws efs describe-file-systems \
    --region "$REGION" \
    --query "FileSystems[?Name=='ananda-crawler-efs'].FileSystemId" \
    --output text)

if [ -z "$EFS_ID" ] || [ "$EFS_ID" == "None" ]; then
    echo -e "${RED}Error: EFS filesystem 'ananda-crawler-efs' not found.${NC}"
    echo "Please run ./aws-setup.sh first to create the EFS filesystem."
    exit 1
fi

echo -e "${GREEN}✓ Found EFS filesystem: $EFS_ID${NC}"

# Step 3: Start a temporary ECS task to access EFS
echo -e "\n${YELLOW}Step 2: Starting temporary ECS task to access EFS...${NC}"

# Get latest task definition
TASK_DEF_REVISION=$(aws ecs describe-task-definition \
    --region "$REGION" \
    --task-definition "$TASK_FAMILY" \
    --query 'taskDefinition.revision' \
    --output text)

TASK_DEF_ARN="${TASK_FAMILY}:${TASK_DEF_REVISION}"

# Get VPC and subnet
# For Secrets Manager access, we need internet connectivity, so use public subnet with public IP
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

# Try to find a public subnet (one with route to Internet Gateway)
# Get all subnets in VPC
ALL_SUBNETS=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[*].SubnetId' \
    --output text)

# Check each subnet for public route table
SUBNET_ID=""
for SUBNET in $ALL_SUBNETS; do
    # Check if subnet has route to Internet Gateway
    ROUTE_TABLE_ID=$(aws ec2 describe-route-tables \
        --region "$REGION" \
        --filters "Name=association.subnet-id,Values=$SUBNET" \
        --query 'RouteTables[0].RouteTableId' \
        --output text 2>/dev/null || echo "")
    
    if [ -n "$ROUTE_TABLE_ID" ] && [ "$ROUTE_TABLE_ID" != "None" ]; then
        # Check if route table has route to Internet Gateway
        IGW_ROUTE=$(aws ec2 describe-route-tables \
            --region "$REGION" \
            --route-table-ids "$ROUTE_TABLE_ID" \
            --query 'RouteTables[0].Routes[?GatewayId!=`null` && GatewayId!=`local`].GatewayId' \
            --output text 2>/dev/null | grep -q "igw-" && echo "yes" || echo "")
        
        if [ -n "$IGW_ROUTE" ]; then
            SUBNET_ID="$SUBNET"
            break
        fi
    fi
done

# Fallback to first subnet if no public subnet found
if [ -z "$SUBNET_ID" ]; then
    SUBNET_ID=$(echo $ALL_SUBNETS | awk '{print $1}')
    echo -e "${YELLOW}Warning: Using subnet $SUBNET_ID (may not be public)${NC}"
fi

# Enable public IP assignment for Secrets Manager access
ASSIGN_PUBLIC_IP="ENABLED"
echo -e "${GREEN}✓ Using subnet: $SUBNET_ID (public IP enabled)${NC}"

# Get security group from EFS mount targets
EFS_ID_TEMP=$(aws efs describe-file-systems \
    --region "$REGION" \
    --query "FileSystems[?Tags[?Key=='Name' && Value=='ananda-crawler-efs']].FileSystemId" \
    --output text | head -1)

if [ -z "$EFS_ID_TEMP" ] || [ "$EFS_ID_TEMP" == "None" ]; then
    EFS_ID_TEMP=$(aws efs describe-file-systems \
        --region "$REGION" \
        --query 'FileSystems[0].FileSystemId' \
        --output text)
fi

# Get security group from EFS mount target
SECURITY_GROUP_ID=$(aws efs describe-mount-targets \
    --region "$REGION" \
    --file-system-id "$EFS_ID_TEMP" \
    --query 'MountTargets[0].SecurityGroups[0]' \
    --output text 2>/dev/null || echo "")

# Fallback to default security group if not found
if [ -z "$SECURITY_GROUP_ID" ] || [ "$SECURITY_GROUP_ID" == "None" ]; then
    SECURITY_GROUP_ID=$(aws ec2 describe-security-groups \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
        --query 'SecurityGroups[0].GroupId' \
        --output text)
fi

# Get EFS access point ID
EFS_ACCESS_POINT_ID=$(aws efs describe-access-points \
    --region "$REGION" \
    --file-system-id "$EFS_ID" \
    --query 'AccessPoints[0].AccessPointId' \
    --output text)

echo -e "${GREEN}✓ Starting temporary task...${NC}"

# Start task with sleep command to keep it running
# Enable execute command for ECS Exec
TASK_ARN=$(aws ecs run-task \
    --region "$REGION" \
    --cluster "$CLUSTER_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --launch-type FARGATE \
    --enable-execute-command \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SECURITY_GROUP_ID],assignPublicIp=$ASSIGN_PUBLIC_IP}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"crawler\",\"command\":[\"sleep\",\"3600\"]}]}" \
    --query 'tasks[0].taskArn' \
    --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" == "None" ]; then
    echo -e "${RED}Error: Failed to start temporary task${NC}"
    exit 1
fi

# Store task ARN for cleanup
CLEANUP_TASK_ARN="$TASK_ARN"

echo -e "${GREEN}✓ Task started: $TASK_ARN${NC}"
echo -e "${YELLOW}Waiting for task to be running (this can take 1-3 minutes for Fargate tasks)...${NC}"

# Wait for task to be running with progress updates
MAX_WAIT=300  # 5 minutes max
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(aws ecs describe-tasks \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --tasks "$TASK_ARN" \
        --query 'tasks[0].lastStatus' \
        --output text 2>/dev/null || echo "UNKNOWN")
    
    if [ "$STATUS" == "RUNNING" ]; then
        echo -e "${GREEN}✓ Task is running${NC}"
        break
    elif [ "$STATUS" == "STOPPED" ]; then
        STOPPED_REASON=$(aws ecs describe-tasks \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --tasks "$TASK_ARN" \
            --query 'tasks[0].stoppedReason' \
            --output text)
        echo -e "${RED}Error: Task stopped unexpectedly${NC}"
        echo -e "${RED}Reason: ${STOPPED_REASON}${NC}"
        exit 1
    fi
    
    if [ $((ELAPSED % 15)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
        echo -e "${YELLOW}  Still waiting... (${ELAPSED}s elapsed, status: ${STATUS})${NC}"
    fi
    
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

if [ "$STATUS" != "RUNNING" ]; then
    echo -e "${RED}Error: Task did not reach RUNNING state within ${MAX_WAIT} seconds${NC}"
    echo -e "${RED}Current status: ${STATUS}${NC}"
    exit 1
fi

# Step 4: Copy database file to EFS via S3
echo -e "\n${YELLOW}Step 3: Copying database file to EFS...${NC}"

# Use S3 as intermediary
S3_BUCKET="ananda-crawler-temp-$(aws sts get-caller-identity --query Account --output text)"
S3_KEY="db-copy/crawler_queue_${SITE_ID}.db"

# Create S3 bucket if needed
if ! aws s3 ls "s3://${S3_BUCKET}/" &> /dev/null; then
    echo -e "${YELLOW}Creating temporary S3 bucket...${NC}"
    aws s3 mb "s3://${S3_BUCKET}" --region "$REGION"
fi

# Upload database to S3
echo -e "${YELLOW}Uploading database to S3...${NC}"
aws s3 cp "$LOCAL_DB_FILE" "s3://${S3_BUCKET}/${S3_KEY}" --region "$REGION"
echo -e "${GREEN}✓ Database uploaded to S3${NC}"

# Start copy task using pure Python/boto3 (no AWS CLI in container)
echo -e "${YELLOW}Starting copy task...${NC}"

# Build Python command that downloads from S3 to EFS
# Using heredoc-style inline Python to avoid quoting issues
COPY_TASK_ARN=$(aws ecs run-task \
    --region "$REGION" \
    --cluster "$CLUSTER_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SECURITY_GROUP_ID],assignPublicIp=$ASSIGN_PUBLIC_IP}" \
    --overrides "{
      \"containerOverrides\": [{
        \"name\": \"crawler\",
        \"environment\": [
          {\"name\": \"COPY_S3_BUCKET\", \"value\": \"${S3_BUCKET}\"},
          {\"name\": \"COPY_S3_KEY\", \"value\": \"${S3_KEY}\"},
          {\"name\": \"COPY_DEST_PATH\", \"value\": \"/app/data/db/crawler_queue_${SITE_ID}.db\"},
          {\"name\": \"AWS_DEFAULT_REGION\", \"value\": \"${REGION}\"}
        ],
        \"command\": [\"sh\", \"-c\", \"pip install --quiet boto3 && python3 -c 'import boto3, os, sys; os.makedirs(\\\"/app/data/db\\\", exist_ok=True); s3=boto3.client(\\\"s3\\\"); bucket=os.environ[\\\"COPY_S3_BUCKET\\\"]; key=os.environ[\\\"COPY_S3_KEY\\\"]; dest=os.environ[\\\"COPY_DEST_PATH\\\"]; print(\\\"Downloading\\\", bucket+\\\"/\\\"+key, \\\"to\\\", dest); s3.download_file(bucket, key, dest); size=os.path.getsize(dest); print(\\\"Database copied to\\\", dest, \\\"size:\\\", size, \\\"bytes\\\")'\"]
      }]
    }" \
    --query 'tasks[0].taskArn' \
    --output text)

CLEANUP_TASK_ARN="$COPY_TASK_ARN"

# Wait and check
echo -e "${YELLOW}Waiting for copy to complete...${NC}"
MAX_WAIT=300
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER_NAME" --tasks "$COPY_TASK_ARN" --query 'tasks[0].lastStatus' --output text)
    if [ "$STATUS" == "STOPPED" ]; then
        EXIT_CODE=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER_NAME" --tasks "$COPY_TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)
        if [ "$EXIT_CODE" == "0" ]; then
            echo -e "${GREEN}✓ Database copied successfully${NC}"
            break
        else
            echo -e "${RED}Error: Copy task failed (exit $EXIT_CODE)${NC}"
            # Try to get logs
            LOG_STREAM=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER_NAME" --tasks "$COPY_TASK_ARN" --query 'tasks[0].containers[0].logStreamName' --output text)
            if [ -n "$LOG_STREAM" ] && [ "$LOG_STREAM" != "None" ]; then
                echo -e "${YELLOW}Logs:${NC}"
                aws logs get-log-events --log-group-name /ecs/ananda-crawler --log-stream-name "$LOG_STREAM" --region "$REGION" --limit 50 --start-from-head
            fi
            exit 1
        fi
    fi
    if [ $((ELAPSED % 10)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
        echo -e "${YELLOW}  Still copying... (${ELAPSED}s, status: $STATUS)${NC}"
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

# Cleanup S3 temp file
aws s3 rm "s3://${S3_BUCKET}/${S3_KEY}" --region "$REGION" || true
echo -e "${GREEN}✓ Cleanup complete${NC}"

LOCAL_SIZE=$(stat -f%z "$LOCAL_DB_FILE" 2>/dev/null || stat -c%s "$LOCAL_DB_FILE" 2>/dev/null)
echo -e "${GREEN}✓ Database file copied successfully (${LOCAL_SIZE} bytes)${NC}"

# Step 5: Stop temporary task
echo -e "\n${YELLOW}Step 4: Stopping temporary task...${NC}"
aws ecs stop-task \
    --region "$REGION" \
    --cluster "$CLUSTER_NAME" \
    --task "$TASK_ARN" \
    --reason "Database copy completed" > /dev/null

# Clear cleanup flag since we're stopping it intentionally
CLEANUP_TASK_ARN=""

echo -e "${GREEN}✓ Temporary task stopped${NC}"

echo -e "\n${GREEN}✅ Database successfully copied to EFS!${NC}"
echo -e "${GREEN}The cloud crawler will now start with your current crawl state.${NC}"

