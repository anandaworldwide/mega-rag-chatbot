#!/bin/bash
# Service-based control script for crawler (replaces manual run-task approach)
# Uses the capacity provider strategy for automatic Spot/on-demand failover

set -e

REGION="us-west-1"
CLUSTER_NAME="ananda-crawler-cluster"
SERVICE_NAME="ananda-crawler-service"
TASK_FAMILY="ananda-crawler-task"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

show_usage() {
    echo "Usage: $0 {start|stop|status|scale <count>|restart}"
    echo ""
    echo "Commands:"
    echo "  start           - Start crawler service (desired count = 1)"
    echo "  stop            - Stop crawler service (desired count = 0)"
    echo "  status          - Show service and task status"
    echo "  scale <count>   - Scale service to specified desired count"
    echo "  restart         - Force new deployment to refresh tasks"
    echo ""
    echo "This script uses the capacity provider strategy for automatic Fargate Spot/on-demand failover."
}

start_service() {
    echo -e "${GREEN}Starting crawler service...${NC}"

    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service "$SERVICE_NAME" \
        --desired-count 1 \
        --region "$REGION"

    echo -e "${GREEN}✓ Service started (desired count = 1)${NC}"
    echo "Monitor deployment: aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $REGION"
}

stop_service() {
    echo -e "${YELLOW}Stopping crawler service...${NC}"

    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service "$SERVICE_NAME" \
        --desired-count 0 \
        --region "$REGION"

    echo -e "${GREEN}✓ Service stopped (desired count = 0)${NC}"
}

status_service() {
    echo -e "${BLUE}Service Status:${NC}"

    # Service info
    SERVICE_INFO=$(aws ecs describe-services \
        --cluster "$CLUSTER_NAME" \
        --services "$SERVICE_NAME" \
        --region "$REGION" \
        --query 'services[0].{Desired:desiredCount, Running:runningCount, Pending:pendingCount, Status:status}' \
        --output json)

    if [ $? -eq 0 ]; then
        DESIRED=$(echo "$SERVICE_INFO" | jq -r '.Desired')
        RUNNING=$(echo "$SERVICE_INFO" | jq -r '.Running')
        PENDING=$(echo "$SERVICE_INFO" | jq -r '.Pending')
        STATUS=$(echo "$SERVICE_INFO" | jq -r '.Status')

        echo "  Service: $SERVICE_NAME"
        echo "  Status: $STATUS"
        echo "  Desired: $DESIRED, Running: $RUNNING, Pending: $PENDING"

        # Capacity provider info
        CAPACITY_STRATEGY=$(aws ecs describe-services \
            --cluster "$CLUSTER_NAME" \
            --services "$SERVICE_NAME" \
            --region "$REGION" \
            --query 'services[0].capacityProviderStrategy[0].capacityProvider' \
            --output text 2>/dev/null || echo "LAUNCH_TYPE")

        if [ "$CAPACITY_STRATEGY" != "LAUNCH_TYPE" ]; then
            echo "  Capacity Provider: $CAPACITY_STRATEGY"

            # Show current capacity usage
            echo -e "\n${BLUE}Capacity Usage:${NC}"
            aws ecs describe-capacity-providers \
                --capacity-providers "$CAPACITY_STRATEGY" \
                --region "$REGION" \
                --query 'capacityProviders[0].{FargateSpot: fargateCapacityProvider.fargateSpot.targetCapacityPercent, Fargate: fargateCapacityProvider.fargate.targetCapacityPercent}' \
                --output table
        fi
    else
        echo -e "${RED}Service '$SERVICE_NAME' not found${NC}"
        return 1
    fi

    # Task info
    echo -e "\n${BLUE}Running Tasks:${NC}"
    TASK_ARNS=$(aws ecs list-tasks \
        --cluster "$CLUSTER_NAME" \
        --service-name "$SERVICE_NAME" \
        --region "$REGION" \
        --query 'taskArns[]' \
        --output text)

    if [ -z "$TASK_ARNS" ]; then
        echo "  No running tasks"
    else
        for TASK_ARN in $TASK_ARNS; do
            TASK_INFO=$(aws ecs describe-tasks \
                --cluster "$CLUSTER_NAME" \
                --tasks "$TASK_ARN" \
                --region "$REGION" \
                --query 'tasks[0].{Status:lastStatus, CapacityProvider:capacityProviderName, Created:createdAt}' \
                --output json)

            STATUS=$(echo "$TASK_INFO" | jq -r '.Status')
            CAPACITY=$(echo "$TASK_INFO" | jq -r '.CapacityProvider')
            CREATED=$(echo "$TASK_INFO" | jq -r '.Created')

            echo "  Task: ${TASK_ARN##*/}"
            echo "  Status: $STATUS"
            echo "  Capacity: $CAPACITY"
            echo "  Created: $CREATED"
            echo ""
        done
    fi
}

scale_service() {
    COUNT="$1"
    if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Error: Count must be a number${NC}"
        exit 1
    fi

    echo -e "${GREEN}Scaling service to $COUNT tasks...${NC}"

    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service "$SERVICE_NAME" \
        --desired-count "$COUNT" \
        --region "$REGION"

    echo -e "${GREEN}✓ Service scaled to $COUNT${NC}"
}

restart_service() {
    echo -e "${GREEN}Restarting service (force new deployment)...${NC}"

    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service "$SERVICE_NAME" \
        --force-new-deployment \
        --region "$REGION"

    echo -e "${GREEN}✓ Service restart initiated${NC}"
}

# Main command handling
case "$1" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    status)
        status_service
        ;;
    scale)
        if [ -z "$2" ]; then
            echo -e "${RED}Error: Please specify a count for scaling${NC}"
            show_usage
            exit 1
        fi
        scale_service "$2"
        ;;
    restart)
        restart_service
        ;;
    *)
        show_usage
        exit 1
        ;;
esac