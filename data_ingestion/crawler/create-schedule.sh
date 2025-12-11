#!/bin/bash
# Create EventBridge schedule for crawler (9am-5pm PT daily)
# Region: us-west-1

set -e

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
SCHEDULE_NAME_START="ananda-crawler-start"
SCHEDULE_NAME_STOP="ananda-crawler-stop"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
NC='\033[0m'

echo -e "${GREEN}Creating EventBridge schedules...${NC}"

# Get VPC and subnet
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

# Find public subnet (required for NAT-less configuration)
SUBNET_ID=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" \
    --query 'Subnets[0].SubnetId' \
    --output text 2>/dev/null)

# Fallback to any subnet if no public subnet found
if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" == "None" ]; then
    SUBNET_ID=$(aws ec2 describe-subnets \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[0].SubnetId' \
        --output text)
    echo -e "${YELLOW}Warning: Using subnet $SUBNET_ID (may not be public - ensure route to IGW)${NC}"
fi

# Get hardened security group for crawler tasks
CRAWLER_SG_NAME="crawler-hardened-sg"
SG_ID=$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=group-name,Values=$CRAWLER_SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
    echo -e "${RED}Error: Hardened security group '${CRAWLER_SG_NAME}' not found${NC}"
    echo "Please run aws-setup.sh first to create the security group"
    exit 1
fi

echo -e "${GREEN}Using hardened security group: ${SG_ID}${NC}"

# Get latest task definition revision
TASK_DEF_REVISION=$(aws ecs describe-task-definition \
    --region "$REGION" \
    --task-definition "$TASK_FAMILY" \
    --query 'taskDefinition.revision' \
    --output text)

TASK_DEF_ARN="${TASK_FAMILY}:${TASK_DEF_REVISION}"

# Create IAM role for EventBridge to run ECS tasks
EVENTBRIDGE_ROLE_NAME="EventBridge-ECSRunTask-Role"
if aws iam get-role --role-name "$EVENTBRIDGE_ROLE_NAME" &> /dev/null; then
    echo -e "${YELLOW}EventBridge role already exists${NC}"
    EVENTBRIDGE_ROLE_ARN=$(aws iam get-role --role-name "$EVENTBRIDGE_ROLE_NAME" --query 'Role.Arn' --output text)
else
    # Create trust policy
    cat > /tmp/eventbridge-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "scheduler.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    EVENTBRIDGE_ROLE_ARN=$(aws iam create-role \
        --role-name "$EVENTBRIDGE_ROLE_NAME" \
        --assume-role-policy-document file:///tmp/eventbridge-trust-policy.json \
        --query 'Role.Arn' \
        --output text)
    
    # Create policy for running ECS tasks
    cat > /tmp/eventbridge-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask"
      ],
      "Resource": "arn:aws:ecs:${REGION}:*:task-definition/${TASK_FAMILY}:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/ecsTaskExecutionRole",
        "arn:aws:iam::*:role/ananda-crawler-task-role"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:StopTask"
      ],
      "Resource": "arn:aws:ecs:${REGION}:*:task/*"
    }
  ]
}
EOF

    POLICY_ARN=$(aws iam create-policy \
        --policy-name "EventBridge-ECSRunTask-Policy" \
        --policy-document file:///tmp/eventbridge-policy.json \
        --query 'Policy.Arn' \
        --output text)
    
    aws iam attach-role-policy \
        --role-name "$EVENTBRIDGE_ROLE_NAME" \
        --policy-arn "$POLICY_ARN"
    
    echo -e "${GREEN}✓ Created EventBridge role${NC}"
fi

# Create start schedule (9am PT = 16:00 UTC in winter, 17:00 UTC in summer)
# Using 16:00 UTC as default (adjust for DST if needed)
cat > /tmp/start-schedule.json <<EOF
{
  "Name": "${SCHEDULE_NAME_START}",
  "ScheduleExpression": "cron(0 16 * * ? *)",
  "FlexibleTimeWindow": {
    "Mode": "OFF"
  },
  "Description": "Start crawler at 9am PT daily",
  "Target": {
    "Arn": "arn:aws:ecs:${REGION}:$(aws sts get-caller-identity --query Account --output text):cluster/${CLUSTER_NAME}",
    "RoleArn": "${EVENTBRIDGE_ROLE_ARN}",
    "EcsParameters": {
      "TaskDefinitionArn": "arn:aws:ecs:${REGION}:$(aws sts get-caller-identity --query Account --output text):task-definition/${TASK_DEF_ARN}",
      "LaunchType": "FARGATE",
      "NetworkConfiguration": {
        "awsvpcConfiguration": {
          "Subnets": ["${SUBNET_ID}"],
          "SecurityGroups": ["${SG_ID}"],
          "AssignPublicIp": "ENABLED"
        }
      }
    }
  },
  "State": "ENABLED"
}
EOF

# Create stop schedule (5pm PT = 00:00 UTC next day)
# Note: This is a simplified approach - actual stop requires tracking running tasks
# For now, we rely on --max-runtime-minutes=480 (8 hours) in task definition
cat > /tmp/stop-schedule.json <<EOF
{
  "Name": "${SCHEDULE_NAME_STOP}",
  "ScheduleExpression": "cron(0 0 * * ? *)",
  "Description": "Stop crawler at 5pm PT (placeholder - uses max-runtime instead)",
  "State": "DISABLED"
}
EOF

# Create or update start schedule
if aws scheduler get-schedule --name "$SCHEDULE_NAME_START" --region "$REGION" &> /dev/null; then
    aws scheduler update-schedule \
        --region "$REGION" \
        --cli-input-json file:///tmp/start-schedule.json
    echo -e "${GREEN}✓ Updated start schedule${NC}"
else
    aws scheduler create-schedule \
        --region "$REGION" \
        --cli-input-json file:///tmp/start-schedule.json
    echo -e "${GREEN}✓ Created start schedule${NC}"
fi

echo -e "${GREEN}✓ EventBridge schedule configured${NC}"
echo -e "${YELLOW}Note: Stop schedule is disabled. Tasks will auto-stop after 8 hours (max-runtime-minutes=480)${NC}"
echo -e "${GREEN}Schedule runs daily at 9am PT (16:00 UTC)${NC}"
echo -e "${GREEN}Security: Using hardened security group with public IP enabled (NAT-less configuration)${NC}"

