#!/bin/bash
# Setup Fargate Spot capacity provider for cost optimization
# Creates managed capacity provider with 95% Spot / 5% on-demand fallback
# Region: us-west-1

set -e

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
CAPACITY_PROVIDER_NAME="ananda-crawler-capacity-provider"
SERVICE_NAME="ananda-crawler-service"
TASK_FAMILY="ananda-crawler-task"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Setting up Fargate Spot capacity provider for cost optimization...${NC}"

# Check AWS CLI and credentials
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured. Run 'aws configure' first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ AWS CLI configured${NC}"

# Step 1: Configure cluster capacity provider strategy
echo -e "\n${YELLOW}Step 1: Configuring cluster for Fargate Spot optimization...${NC}"

# Check if FARGATE and FARGATE_SPOT capacity providers are available
AVAILABLE_PROVIDERS=$(aws ecs describe-clusters \
    --clusters "$CLUSTER_NAME" \
    --region "$REGION" \
    --query 'clusters[0].capacityProviders' \
    --output text)

if [[ "$AVAILABLE_PROVIDERS" == *"FARGATE_SPOT"* ]] && [[ "$AVAILABLE_PROVIDERS" == *"FARGATE"* ]]; then
    echo -e "${GREEN}✓ FARGATE and FARGATE_SPOT capacity providers are available${NC}"
else
    echo -e "${YELLOW}Adding FARGATE and FARGATE_SPOT capacity providers to cluster...${NC}"
    aws ecs update-cluster \
        --cluster "$CLUSTER_NAME" \
        --capacity-providers FARGATE FARGATE_SPOT \
        --region "$REGION"
    echo -e "${GREEN}✓ Capacity providers added to cluster${NC}"
fi

# Step 2: Set default capacity provider strategy for cluster
echo -e "\n${YELLOW}Step 2: Setting default capacity provider strategy...${NC}"

# Update cluster to use Spot-first strategy by default
aws ecs put-cluster-capacity-providers \
    --cluster "$CLUSTER_NAME" \
    --capacity-providers FARGATE FARGATE_SPOT \
    --default-capacity-provider-strategy "capacityProvider=FARGATE_SPOT,weight=95,base=0" "capacityProvider=FARGATE,weight=5,base=0" \
    --region "$REGION"

echo -e "${GREEN}✓ Default capacity provider strategy set (95% Spot, 5% on-demand)${NC}"

# Step 3: Check if service exists, create if needed
echo -e "\n${YELLOW}Step 3: Setting up ECS service...${NC}"

SERVICE_EXISTS=$(aws ecs describe-services \
    --cluster "$CLUSTER_NAME" \
    --services "$SERVICE_NAME" \
    --region "$REGION" \
    --query 'services[0].serviceName' \
    --output text 2>/dev/null || echo "NOT_FOUND")

if [ "$SERVICE_EXISTS" == "$SERVICE_NAME" ]; then
    echo -e "${YELLOW}Service '$SERVICE_NAME' exists, updating to use capacity provider...${NC}"

    # Get current service configuration
    TASK_DEF_ARN=$(aws ecs describe-services \
        --cluster "$CLUSTER_NAME" \
        --services "$SERVICE_NAME" \
        --region "$REGION" \
        --query 'services[0].taskDefinition' \
        --output text)

    NETWORK_CONFIG=$(aws ecs describe-services \
        --cluster "$CLUSTER_NAME" \
        --services "$SERVICE_NAME" \
        --region "$REGION" \
        --query 'services[0].networkConfiguration' \
        --output json)

    # Update service to use capacity provider strategy (95% Spot, 5% on-demand)
    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service "$SERVICE_NAME" \
        --capacity-provider-strategy "capacityProvider=FARGATE_SPOT,weight=95" "capacityProvider=FARGATE,weight=5" \
        --task-definition "$TASK_DEF_ARN" \
        --network-configuration "$NETWORK_CONFIG" \
        --desired-count 1 \
        --region "$REGION" \
        --force-new-deployment

    echo -e "${GREEN}✓ Service updated to use capacity provider${NC}"
else
    echo -e "${YELLOW}Service '$SERVICE_NAME' doesn't exist, creating new service...${NC}"

    # Get latest task definition
    TASK_DEF_ARN=$(aws ecs describe-task-definition \
        --task-definition "$TASK_FAMILY" \
        --region "$REGION" \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text)

    # Get VPC configuration
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

    # Create service with capacity provider strategy (95% Spot, 5% on-demand)
    aws ecs create-service \
        --cluster "$CLUSTER_NAME" \
        --service-name "$SERVICE_NAME" \
        --task-definition "$TASK_DEF_ARN" \
        --capacity-provider-strategy "capacityProvider=FARGATE_SPOT,weight=95" "capacityProvider=FARGATE,weight=5" \
        --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
        --desired-count 1 \
        --enable-execute-command \
        --region "$REGION"

    echo -e "${GREEN}✓ Service created with capacity provider strategy${NC}"
fi

# Step 4: Create CloudWatch alarm for on-demand usage monitoring
echo -e "\n${YELLOW}Step 4: Creating CloudWatch alarm for on-demand capacity usage...${NC}"

ALARM_NAME="ananda-crawler-spot-capacity-low"
SNS_TOPIC_NAME="ananda-crawler-alerts"

# Create SNS topic for alerts (if it doesn't exist)
TOPIC_ARN=$(aws sns list-topics \
    --region "$REGION" \
    --query "Topics[?ends_with(TopicArn, ':$SNS_TOPIC_NAME')].TopicArn" \
    --output text 2>/dev/null || echo "")

if [ -z "$TOPIC_ARN" ] || [ "$TOPIC_ARN" == "None" ]; then
    TOPIC_ARN=$(aws sns create-topic \
        --name "$SNS_TOPIC_NAME" \
        --region "$REGION" \
        --query 'TopicArn' \
        --output text)
    echo -e "${GREEN}✓ SNS topic created: $TOPIC_ARN${NC}"
else
    echo -e "${YELLOW}SNS topic already exists: $TOPIC_ARN${NC}"
fi

# Create CloudWatch alarm for on-demand capacity usage > 30 minutes
aws cloudwatch put-metric-alarm \
    --alarm-name "$ALARM_NAME" \
    --alarm-description "Alert when crawler runs on on-demand capacity for more than 30 minutes (indicates Spot capacity shortage)" \
    --metric-name "CapacityProviderReservation" \
    --namespace "AWS/ECS/ManagedScaling" \
    --statistic "Maximum" \
    --period 300 \
    --threshold 10 \
    --comparison-operator "GreaterThanThreshold" \
    --dimensions "Name=CapacityProviderName,Value=FARGATE" "Name=ClusterName,Value=$CLUSTER_NAME" \
    --evaluation-periods 6 \
    --alarm-actions "$TOPIC_ARN" \
    --region "$REGION"

echo -e "${GREEN}✓ CloudWatch alarm created${NC}"
echo -e "${YELLOW}Note: Alarm triggers when on-demand (FARGATE) capacity usage > 10% for 30+ minutes${NC}"

# Step 5: Verification
echo -e "\n${BLUE}Verification:${NC}"

# Check capacity provider status
echo -e "${GREEN}Built-in capacity providers:${NC}"
aws ecs describe-capacity-providers \
    --capacity-providers FARGATE FARGATE_SPOT \
    --region "$REGION" \
    --query 'capacityProviders[*].{Name:name, Status:status}' \
    --output table

# Check cluster capacity providers
echo -e "\n${GREEN}Cluster capacity providers:${NC}"
aws ecs describe-clusters \
    --clusters "$CLUSTER_NAME" \
    --region "$REGION" \
    --query 'clusters[0].capacityProviders' \
    --output table

# Check service configuration
echo -e "\n${GREEN}Service capacity provider strategy:${NC}"
aws ecs describe-services \
    --cluster "$CLUSTER_NAME" \
    --services "$SERVICE_NAME" \
    --region "$REGION" \
    --query 'services[0].capacityProviderStrategy' \
    --output table

echo -e "\n${GREEN}✓ Setup complete!${NC}"
echo -e "${YELLOW}The crawler service will now automatically use Fargate Spot (95%) with fallback to on-demand (5%)${NC}"
echo -e "${YELLOW}Monitor the CloudWatch alarm '$ALARM_NAME' for spot capacity issues${NC}"

# Instructions for manual testing
echo -e "\n${BLUE}To test the setup:${NC}"
echo "1. Scale service to 0: ./service-control.sh stop"
echo "2. Scale back to 1: ./service-control.sh start"
echo "3. Check status and capacity type: ./service-control.sh status"
echo "4. Manual check: aws ecs describe-tasks --cluster $CLUSTER_NAME --tasks <task-arn> --region $REGION --query 'tasks[0].capacityProviderName'"