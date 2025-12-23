#!/bin/bash
# Download SQLite database from EFS to local machine
# This allows local health checks and analysis using the cloud database state

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
    
    # Clean up S3 temp file if it exists
    if [ -n "$S3_BUCKET" ] && [ -n "$S3_KEY" ]; then
        echo -e "${YELLOW}Cleaning up temporary S3 file...${NC}"
        aws s3 rm "s3://${S3_BUCKET}/${S3_KEY}" --region "$REGION" || true
    fi
}

# Set trap to cleanup on exit (including Ctrl+C)
trap cleanup EXIT INT TERM

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
SITE_ID="${1:-ananda-public}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Downloading SQLite database from EFS...${NC}"
echo -e "${YELLOW}Site: ${SITE_ID}${NC}"

# Step 1: Get EFS filesystem ID
echo -e "\n${YELLOW}Step 1: Finding EFS filesystem...${NC}"
EFS_ID=$(aws efs describe-file-systems \
    --region "$REGION" \
    --query "FileSystems[?Name=='ananda-crawler-efs'].FileSystemId" \
    --output text)

if [ -z "$EFS_ID" ] || [ "$EFS_ID" == "None" ]; then
    echo -e "${RED}Error: EFS filesystem 'ananda-crawler-efs' not found.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Found EFS filesystem: $EFS_ID${NC}"

# Step 2: Set up networking and start copy task
echo -e "\n${YELLOW}Step 2: Setting up networking...${NC}"

# Get latest task definition
TASK_DEF_REVISION=$(aws ecs describe-task-definition \
    --region "$REGION" \
    --task-definition "$TASK_FAMILY" \
    --query 'taskDefinition.revision' \
    --output text)

TASK_DEF_ARN="${TASK_FAMILY}:${TASK_DEF_REVISION}"

# Get VPC and subnet
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

# Find a public subnet
ALL_SUBNETS=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[*].SubnetId' \
    --output text)

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

echo -e "${GREEN}✓ Using security group: $SECURITY_GROUP_ID${NC}"

# Step 3: Copy database file from EFS to S3
echo -e "\n${YELLOW}Step 3: Copying database from EFS to S3...${NC}"

# Use S3 as intermediary
S3_BUCKET="ananda-crawler-temp-$(aws sts get-caller-identity --query Account --output text)"
S3_KEY="db-copy/crawler_queue_${SITE_ID}.db"

# Create S3 bucket if needed
if ! aws s3 ls "s3://${S3_BUCKET}/" &> /dev/null; then
    echo -e "${YELLOW}Creating temporary S3 bucket...${NC}"
    aws s3 mb "s3://${S3_BUCKET}" --region "$REGION"
fi

# Start copy task using Python/boto3 to upload from EFS to S3
echo -e "${YELLOW}Starting copy task...${NC}"

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
          {\"name\": \"COPY_SOURCE_PATH\", \"value\": \"/app/data/db/crawler_queue_${SITE_ID}.db\"},
          {\"name\": \"AWS_DEFAULT_REGION\", \"value\": \"${REGION}\"}
        ],
        \"command\": [\"sh\", \"-c\", \"pip install --user boto3 && python3 -c 'import time; time.sleep(2); import boto3; import os; import sys; source=os.environ[\\\"COPY_SOURCE_PATH\\\"]; bucket=os.environ[\\\"COPY_S3_BUCKET\\\"]; key=os.environ[\\\"COPY_S3_KEY\\\"]; print(\\\"Source:\\\", source); sys.stdout.flush(); dir_path=os.path.dirname(source); print(\\\"Dir exists:\\\", os.path.exists(dir_path)); print(\\\"File exists:\\\", os.path.exists(source)); sys.stdout.flush(); print(\\\"Contents:\\\", os.listdir(dir_path) if os.path.exists(dir_path) else \\\"N/A\\\"); sys.stdout.flush(); s3=boto3.client(\\\"s3\\\"); s3.upload_file(source, bucket, key) if os.path.exists(source) else sys.exit(1); print(\\\"SUCCESS\\\"); time.sleep(5)'\"]
      }]
    }" \
    --query 'tasks[0].taskArn' \
    --output text)

CLEANUP_TASK_ARN="$COPY_TASK_ARN"

# Wait for copy to complete
echo -e "${YELLOW}Waiting for copy to complete...${NC}"
MAX_WAIT=300
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(aws ecs describe-tasks \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --tasks "$COPY_TASK_ARN" \
        --query 'tasks[0].lastStatus' \
        --output text 2>/dev/null || echo "UNKNOWN")
    
    if [ "$STATUS" == "STOPPED" ]; then
        EXIT_CODE=$(aws ecs describe-tasks \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --tasks "$COPY_TASK_ARN" \
            --query 'tasks[0].containers[0].exitCode' \
            --output text)
        
        if [ "$EXIT_CODE" == "0" ]; then
            echo -e "${GREEN}✓ Copy completed successfully${NC}"
            break
        else
            STOPPED_REASON=$(aws ecs describe-tasks \
                --region "$REGION" \
                --cluster "$CLUSTER_NAME" \
                --tasks "$COPY_TASK_ARN" \
                --query 'tasks[0].stoppedReason' \
                --output text)
            echo -e "${RED}Error: Copy task failed${NC}"
            echo -e "${RED}Exit code: ${EXIT_CODE}${NC}"
            echo -e "${RED}Reason: ${STOPPED_REASON}${NC}"
            
            # Wait a moment for logs to be available
            echo -e "${YELLOW}Waiting for logs to be available...${NC}"
            sleep 3
            
            # Get logs from the failed task
            TASK_ID=$(echo "$COPY_TASK_ARN" | awk -F'/' '{print $NF}')
            LOG_GROUP="/ecs/${TASK_FAMILY}"
            LOG_STREAM="ecs/crawler/${TASK_ID}"
            
            echo -e "\n${YELLOW}Fetching logs from task ${TASK_ID}...${NC}"
            echo -e "${YELLOW}Log group: ${LOG_GROUP}${NC}"
            echo -e "${YELLOW}Log stream: ${LOG_STREAM}${NC}\n"
            
            # Try to get logs from the specific task stream
            LOG_OUTPUT=$(aws logs get-log-events \
                --region "$REGION" \
                --log-group-name "$LOG_GROUP" \
                --log-stream-name "$LOG_STREAM" \
                --limit 50 \
                --query 'events[*].message' \
                --output text 2>&1)
            
            if [ $? -eq 0 ] && [ -n "$LOG_OUTPUT" ] && [ "$LOG_OUTPUT" != "None" ]; then
                echo -e "${YELLOW}=== Task Logs ===${NC}"
                echo "$LOG_OUTPUT"
                echo -e "${YELLOW}==================${NC}\n"
            else
                echo -e "${YELLOW}Could not fetch from specific stream, trying to find recent logs...${NC}"
                if [ -n "$LOG_OUTPUT" ]; then
                    echo "Error: $LOG_OUTPUT"
                fi
                
                # Try to find the log stream
                ALL_STREAMS=$(aws logs describe-log-streams \
                    --region "$REGION" \
                    --log-group-name "$LOG_GROUP" \
                    --order-by LastEventTime \
                    --descending \
                    --max-items 5 \
                    --query 'logStreams[*].logStreamName' \
                    --output text 2>/dev/null || echo "")
                
                if [ -n "$ALL_STREAMS" ] && [ "$ALL_STREAMS" != "None" ]; then
                    echo -e "${YELLOW}Available log streams:${NC}"
                    echo "$ALL_STREAMS"
                    FIRST_STREAM=$(echo "$ALL_STREAMS" | awk '{print $1}')
                    if [ -n "$FIRST_STREAM" ] && [ "$FIRST_STREAM" != "None" ]; then
                        echo -e "\n${YELLOW}=== Recent logs from ${FIRST_STREAM} ===${NC}"
                        aws logs get-log-events \
                            --region "$REGION" \
                            --log-group-name "$LOG_GROUP" \
                            --log-stream-name "$FIRST_STREAM" \
                            --limit 30 \
                            --query 'events[*].message' \
                            --output text 2>/dev/null | tail -30 || true
                        echo -e "${YELLOW}========================================${NC}\n"
                    fi
                else
                    echo -e "${YELLOW}No log streams found in ${LOG_GROUP}${NC}"
                fi
            fi
            
            exit 1
        fi
    fi
    
    if [ $((ELAPSED % 15)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
        echo -e "${YELLOW}  Still waiting... (${ELAPSED}s elapsed, status: ${STATUS})${NC}"
    fi
    
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

if [ "$STATUS" != "STOPPED" ] || [ "$EXIT_CODE" != "0" ]; then
    echo -e "${RED}Error: Copy did not complete within ${MAX_WAIT} seconds${NC}"
    exit 1
fi

# Step 4: Download from S3 to local
echo -e "\n${YELLOW}Step 4: Downloading database from S3 to local...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DB_DIR="${SCRIPT_DIR}/../db"
LOCAL_DB_FILE="${LOCAL_DB_DIR}/crawler_queue_${SITE_ID}.db"

mkdir -p "$LOCAL_DB_DIR"

aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" "$LOCAL_DB_FILE" --region "$REGION"

if [ -f "$LOCAL_DB_FILE" ]; then
    FILE_SIZE=$(ls -lh "$LOCAL_DB_FILE" | awk '{print $5}')
    echo -e "${GREEN}✓ Database downloaded successfully${NC}"
    echo -e "${GREEN}  Location: $LOCAL_DB_FILE${NC}"
    echo -e "${GREEN}  Size: $FILE_SIZE${NC}"
else
    echo -e "${RED}Error: Database file not found after download${NC}"
    exit 1
fi

echo -e "\n${GREEN}✓ Database download complete!${NC}"

