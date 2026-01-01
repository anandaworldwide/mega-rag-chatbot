#!/bin/bash
# Register ECS task definition
# Region: us-west-1

set -e

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
ECR_REPO_NAME="ananda-crawler"
SECRETS_NAME="ananda-crawler-secrets"
LOG_GROUP_NAME="/ecs/ananda-crawler"
IMAGE_TAG="${1:-latest}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
NC='\033[0m'

echo -e "${GREEN}Registering ECS task definition...${NC}"

# Get ECR URI
ECR_URI=$(aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$REGION" --query 'repositories[0].repositoryUri' --output text)
FULL_IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

# Get EFS ID
EFS_ID=$(aws efs describe-file-systems \
    --region "$REGION" \
    --query "FileSystems[?Name=='ananda-crawler-efs'].FileSystemId" \
    --output text)

if [ -z "$EFS_ID" ]; then
    echo -e "${YELLOW}Error: EFS not found. Run aws-setup.sh first.${NC}"
    exit 1
fi

# Get EFS access point
ACCESS_POINT_ID=$(aws efs describe-access-points \
    --region "$REGION" \
    --file-system-id "$EFS_ID" \
    --query "AccessPoints[?Name=='crawler-data'].AccessPointId" \
    --output text)

if [ -z "$ACCESS_POINT_ID" ]; then
    echo -e "${YELLOW}Error: EFS access point not found. Run aws-setup.sh first.${NC}"
    exit 1
fi

# Get IAM roles
EXEC_ROLE_ARN=$(aws iam get-role --role-name "ecsTaskExecutionRole" --query 'Role.Arn' --output text)
TASK_ROLE_ARN=$(aws iam get-role --role-name "ananda-crawler-task-role" --query 'Role.Arn' --output text)

# Get VPC and subnet
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

SUBNET_ID=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[0].SubnetId' \
    --output text)

# Create task definition JSON
cat > /tmp/task-definition.json <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "2048",
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "crawler",
      "image": "${FULL_IMAGE_URI}",
      "essential": true,
      "command": [
        "python",
        "/app/crawler/website_crawler.py",
        "--site",
        "ananda-public",
        "--max-runtime-minutes",
        "38",
        "--non-interactive",
        "--force-csv-mode"
      ],
      "environment": [
        {
          "name": "DATA_DIR",
          "value": "/app/data"
        },
        {
          "name": "PYTHONUNBUFFERED",
          "value": "1"
        }
      ],
      "secrets": [
        {
          "name": "OPENAI_API_KEY",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:OPENAI_API_KEY::"
        },
        {
          "name": "OPENAI_INGEST_EMBEDDINGS_MODEL",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:OPENAI_INGEST_EMBEDDINGS_MODEL::"
        },
        {
          "name": "PINECONE_API_KEY",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:PINECONE_API_KEY::"
        },
        {
          "name": "PINECONE_INGEST_INDEX_NAME",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:PINECONE_INGEST_INDEX_NAME::"
        },
        {
          "name": "SITE",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:SITE::"
        },
        {
          "name": "OPS_ALERT_EMAIL",
          "valueFrom": "arn:aws:secretsmanager:${REGION}:$(aws sts get-caller-identity --query Account --output text):secret:${SECRETS_NAME}:OPS_ALERT_EMAIL::"
        }
      ],
      "mountPoints": [
        {
          "sourceVolume": "crawler-data",
          "containerPath": "/app/data",
          "readOnly": false
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP_NAME}",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "crawler"
        }
      },
      "user": "1000:1000"
    }
  ],
  "volumes": [
    {
      "name": "crawler-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "${EFS_ID}",
        "authorizationConfig": {
          "accessPointId": "${ACCESS_POINT_ID}",
          "iam": "ENABLED"
        },
        "transitEncryption": "ENABLED",
        "transitEncryptionPort": 2049
      }
    }
  ]
}
EOF

# Register task definition
aws ecs register-task-definition \
    --region "$REGION" \
    --cli-input-json file:///tmp/task-definition.json

echo -e "${GREEN}✓ Task definition registered successfully${NC}"
echo -e "${GREEN}Task family: ${TASK_FAMILY}${NC}"

# Get the new task definition revision
NEW_TASK_DEF_ARN=$(aws ecs describe-task-definition \
    --task-definition "$TASK_FAMILY" \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo -e "${GREEN}New revision: ${NEW_TASK_DEF_ARN}${NC}"

# Check if EventBridge schedule exists and update it
SCHEDULE_NAME="ananda-crawler-start"
if aws scheduler get-schedule --name "$SCHEDULE_NAME" --region "$REGION" &> /dev/null; then
    echo ""
    echo -e "${YELLOW}Updating EventBridge schedule to use new task definition...${NC}"
    
    # Get the script directory to call update-schedule-for-service.sh
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [ -f "$SCRIPT_DIR/update-schedule-for-service.sh" ]; then
        bash "$SCRIPT_DIR/update-schedule-for-service.sh"
        echo -e "${GREEN}✓ EventBridge schedule updated to use new task definition${NC}"
    else
        echo -e "${YELLOW}Warning: update-schedule-for-service.sh not found${NC}"
        echo -e "${YELLOW}Run ./update-schedule-for-service.sh manually to update the schedule${NC}"
    fi
else
    echo ""
    echo -e "${YELLOW}No EventBridge schedule found. Scheduled runs not configured.${NC}"
    echo -e "${YELLOW}To set up scheduled runs, run: ./update-schedule-for-service.sh${NC}"
fi

