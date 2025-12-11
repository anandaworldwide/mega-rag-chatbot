#!/bin/bash
# Manual control script for crawler during transition period
# Allows switching between laptop and cloud execution

set -e

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
SCHEDULE_NAME_START="ananda-crawler-start"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
RED='\033[0;31m'
NC='\033[0m'

show_usage() {
    echo "Usage: $0 {start-cloud|stop-cloud|status-cloud|stop-laptop|status-laptop|disable-schedule|enable-schedule}"
    echo ""
    echo "Commands:"
    echo "  start-cloud      - Manually start crawler task in cloud"
    echo "  stop-cloud        - Stop running cloud task"
    echo "  status-cloud      - Show cloud task status"
    echo "  stop-laptop       - Stop laptop crawler service"
    echo "  status-laptop     - Show laptop crawler status"
    echo "  disable-schedule  - Disable EventBridge schedule (use manual control)"
    echo "  enable-schedule   - Enable EventBridge schedule (automatic 9am start)"
}

start_cloud() {
    echo -e "${GREEN}Starting crawler in cloud...${NC}"
    
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
    
    # Find a public subnet (one that auto-assigns public IPs or has route to IGW)
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
        echo -e "${YELLOW}Warning: Using subnet $SUBNET_ID (may not be public)${NC}"
    fi
    
    # Get EFS ID - try multiple methods
    EFS_ID=$(aws efs describe-file-systems \
        --region "$REGION" \
        --query "FileSystems[?Tags[?Key=='Name' && Value=='ananda-crawler-efs']].FileSystemId" \
        --output text | head -1)
    
    if [ -z "$EFS_ID" ] || [ "$EFS_ID" == "None" ]; then
        # Fallback: try by name tag directly
        EFS_ID=$(aws efs describe-file-systems \
            --region "$REGION" \
            --query "FileSystems[?contains(CreationToken, 'ananda-crawler') || contains(FileSystemId, 'fs-')].FileSystemId" \
            --output text | head -1)
    fi
    
    if [ -z "$EFS_ID" ] || [ "$EFS_ID" == "None" ]; then
        # Last resort: get first EFS filesystem
        EFS_ID=$(aws efs describe-file-systems \
            --region "$REGION" \
            --query 'FileSystems[0].FileSystemId' \
            --output text)
    fi
    
    if [ -z "$EFS_ID" ] || [ "$EFS_ID" == "None" ]; then
        echo -e "${RED}Error: Could not find EFS filesystem${NC}"
        echo "Please run aws-setup.sh first to create the EFS"
        exit 1
    fi
    
    echo -e "${YELLOW}Found EFS: ${EFS_ID}${NC}"
    
    # Get hardened security group for crawler tasks (not EFS SG)
    CRAWLER_SG_NAME="crawler-hardened-sg"
    SG_ID=$(aws ec2 describe-security-groups \
        --region "$REGION" \
        --filters "Name=group-name,Values=$CRAWLER_SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null || echo "")
    
    if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
        echo -e "${RED}Error: Could not find hardened security group '${CRAWLER_SG_NAME}'${NC}"
        echo "VPC ID: ${VPC_ID}"
        echo ""
        echo "Troubleshooting:"
        echo "1. Run aws-setup.sh to create the hardened security group"
        echo "2. Check if security group exists:"
        echo "   aws ec2 describe-security-groups --filters \"Name=vpc-id,Values=${VPC_ID}\" --region ${REGION}"
        exit 1
    fi
    
    echo -e "${GREEN}Found hardened security group: ${SG_ID}${NC}"
    
    # Run task
    TASK_ARN=$(aws ecs run-task \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --task-definition "$TASK_DEF_ARN" \
        --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
        --query 'tasks[0].taskArn' \
        --output text)
    
    echo -e "${GREEN}✓ Task started: ${TASK_ARN}${NC}"
    echo "Monitor logs: aws logs tail /ecs/ananda-crawler --follow --region $REGION"
}

stop_cloud() {
    echo -e "${YELLOW}Stopping cloud crawler tasks...${NC}"
    
    # List running tasks
    TASK_ARNS=$(aws ecs list-tasks \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --desired-status RUNNING \
        --query 'taskArns[]' \
        --output text)
    
    if [ -z "$TASK_ARNS" ]; then
        echo -e "${YELLOW}No running tasks found${NC}"
        return
    fi
    
    for TASK_ARN in $TASK_ARNS; do
        echo "Stopping task: $TASK_ARN"
        aws ecs stop-task \
            --region "$REGION" \
            --cluster "$CLUSTER_NAME" \
            --task "$TASK_ARN" \
            --reason "Manual stop via control script"
    done
    
    echo -e "${GREEN}✓ Tasks stopped${NC}"
}

status_cloud() {
    echo -e "${GREEN}Cloud crawler status:${NC}"
    
    # List tasks
    TASK_ARNS=$(aws ecs list-tasks \
        --region "$REGION" \
        --cluster "$CLUSTER_NAME" \
        --query 'taskArns[]' \
        --output text)
    
    if [ -z "$TASK_ARNS" ]; then
        echo -e "${YELLOW}No tasks found${NC}"
    else
        for TASK_ARN in $TASK_ARNS; do
            STATUS=$(aws ecs describe-tasks \
                --region "$REGION" \
                --cluster "$CLUSTER_NAME" \
                --tasks "$TASK_ARN" \
                --query 'tasks[0].lastStatus' \
                --output text)
            echo "  Task: $TASK_ARN"
            echo "  Status: $STATUS"
        done
    fi
    
    # Check schedule status
    SCHEDULE_STATE=$(aws scheduler get-schedule \
        --region "$REGION" \
        --name "$SCHEDULE_NAME_START" \
        --query 'State' \
        --output text 2>/dev/null || echo "NOT_FOUND")
    
    echo "  Schedule: $SCHEDULE_STATE"
}

stop_laptop() {
    echo -e "${YELLOW}Stopping laptop crawler service...${NC}"
    
    if launchctl list | grep -q "com.ananda.crawler"; then
        launchctl stop com.ananda.crawler
        echo -e "${GREEN}✓ Laptop service stopped${NC}"
    else
        echo -e "${YELLOW}Laptop service not running${NC}"
    fi
}

status_laptop() {
    echo -e "${GREEN}Laptop crawler status:${NC}"
    
    if launchctl list | grep -q "com.ananda.crawler"; then
        STATUS=$(launchctl list com.ananda.crawler | head -1)
        echo "  Service: $STATUS"
    else
        echo -e "${YELLOW}Service not loaded${NC}"
    fi
}

disable_schedule() {
    echo -e "${YELLOW}Disabling EventBridge schedule...${NC}"
    
    aws scheduler update-schedule \
        --region "$REGION" \
        --name "$SCHEDULE_NAME_START" \
        --state DISABLED
    
    echo -e "${GREEN}✓ Schedule disabled${NC}"
    echo "Use 'start-cloud' command to manually start tasks"
}

enable_schedule() {
    echo -e "${GREEN}Enabling EventBridge schedule...${NC}"
    
    aws scheduler update-schedule \
        --region "$REGION" \
        --name "$SCHEDULE_NAME_START" \
        --state ENABLED
    
    echo -e "${GREEN}✓ Schedule enabled${NC}"
    echo "Crawler will start automatically at 9am PT daily"
}

case "$1" in
    start-cloud)
        start_cloud
        ;;
    stop-cloud)
        stop_cloud
        ;;
    status-cloud)
        status_cloud
        ;;
    stop-laptop)
        stop_laptop
        ;;
    status-laptop)
        status_laptop
        ;;
    disable-schedule)
        disable_schedule
        ;;
    enable-schedule)
        enable_schedule
        ;;
    *)
        show_usage
        exit 1
        ;;
esac

