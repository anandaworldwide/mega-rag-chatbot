#!/bin/bash
# Update EventBridge schedule to use Fargate Spot capacity
# Uses RunTask with CapacityProviderStrategy instead of LaunchType
# Runs hourly during active hours (PT) with a short max-runtime per task
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
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Updating EventBridge schedule to use Fargate Spot capacity...${NC}"

# Check AWS CLI and credentials
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured. Run 'aws configure' first.${NC}"
    exit 1
fi

# Get account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo -e "${GREEN}✓ AWS configured, Account: ${ACCOUNT_ID}${NC}"

# Get VPC and subnet
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

# Find public subnet
SUBNET_ID=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" \
    --query 'Subnets[0].SubnetId' \
    --output text 2>/dev/null)

if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" == "None" ]; then
    SUBNET_ID=$(aws ec2 describe-subnets \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[0].SubnetId' \
        --output text)
fi

# Get hardened security group
CRAWLER_SG_NAME="crawler-hardened-sg"
SG_ID=$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=group-name,Values=$CRAWLER_SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
    echo -e "${RED}Error: Could not find hardened security group '$CRAWLER_SG_NAME'${NC}"
    echo "Run aws-setup.sh first to create the security group"
    exit 1
fi

echo -e "${GREEN}Using subnet: $SUBNET_ID, security group: $SG_ID${NC}"

# Get latest task definition
TASK_DEF_ARN=$(aws ecs describe-task-definition \
    --task-definition "$TASK_FAMILY" \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo -e "${GREEN}Using task definition: $TASK_DEF_ARN${NC}"

# Get or create EventBridge role
EVENTBRIDGE_ROLE_NAME="EventBridge-ECSRunTask-Role"
if aws iam get-role --role-name "$EVENTBRIDGE_ROLE_NAME" &> /dev/null; then
    echo -e "${YELLOW}EventBridge role already exists${NC}"
    EVENTBRIDGE_ROLE_ARN=$(aws iam get-role --role-name "$EVENTBRIDGE_ROLE_NAME" --query 'Role.Arn' --output text)
else
    echo -e "${GREEN}Creating EventBridge role...${NC}"

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
      "Action": ["ecs:RunTask"],
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:*"
    },
    {
      "Effect": "Allow",
      "Action": ["iam:PassRole"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole",
        "arn:aws:iam::${ACCOUNT_ID}:role/ananda-crawler-task-role"
      ]
    }
  ]
}
EOF

    POLICY_ARN=$(aws iam create-policy \
        --policy-name "EventBridge-ECSRunTask-Policy" \
        --policy-document file:///tmp/eventbridge-policy.json \
        --query 'Policy.Arn' \
        --output text 2>/dev/null || echo "arn:aws:iam::${ACCOUNT_ID}:policy/EventBridge-ECSRunTask-Policy")

    aws iam attach-role-policy \
        --role-name "$EVENTBRIDGE_ROLE_NAME" \
        --policy-arn "$POLICY_ARN" 2>/dev/null || true

    echo -e "${GREEN}✓ Created EventBridge role${NC}"
    
    # Wait for role to propagate
    sleep 5
fi

# Update start schedule to use capacity provider strategy (Spot)
echo -e "\n${YELLOW}Updating start schedule to use Fargate Spot...${NC}"

aws scheduler update-schedule \
    --name "$SCHEDULE_NAME_START" \
    --schedule-expression "cron(0 7-22 * * ? *)" \
    --schedule-expression-timezone "America/Los_Angeles" \
    --flexible-time-window '{"Mode": "OFF"}' \
    --description "Run crawler hourly 7am-10pm PT (15m max) (uses Fargate Spot)" \
    --target "{
        \"Arn\": \"arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}\",
        \"RoleArn\": \"${EVENTBRIDGE_ROLE_ARN}\",
        \"EcsParameters\": {
            \"TaskDefinitionArn\": \"${TASK_DEF_ARN}\",
            \"TaskCount\": 1,
            \"CapacityProviderStrategy\": [
                {\"capacityProvider\": \"FARGATE_SPOT\", \"weight\": 95, \"base\": 0},
                {\"capacityProvider\": \"FARGATE\", \"weight\": 5, \"base\": 0}
            ],
            \"NetworkConfiguration\": {
                \"awsvpcConfiguration\": {
                    \"Subnets\": [\"${SUBNET_ID}\"],
                    \"SecurityGroups\": [\"${SG_ID}\"],
                    \"AssignPublicIp\": \"ENABLED\"
                }
            }
        }
    }" \
    --state ENABLED \
    --region "$REGION"

echo -e "${GREEN}✓ Updated start schedule to use Fargate Spot${NC}"

echo -e "\n${GREEN}✓ EventBridge schedule updated for Fargate Spot capacity${NC}"
echo -e "${BLUE}Schedule Summary:${NC}"
echo "  Schedule: hourly, 7am–10pm PT (America/Los_Angeles)"
echo "  Capacity: 95% Fargate Spot, 5% Fargate on-demand (fallback)"
echo "  Runtime: 15 minutes max (max-runtime-minutes=15)"
echo ""
echo -e "${YELLOW}Cost savings: ~70% compared to on-demand Fargate${NC}"

# Verification
echo -e "\n${BLUE}Verification:${NC}"
aws scheduler get-schedule --name "$SCHEDULE_NAME_START" --region "$REGION" --query '{Name:Name, State:State, Schedule:ScheduleExpression, Description:Description}' --output table