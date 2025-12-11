#!/bin/bash
# AWS Setup Script for Crawler Deployment
# Creates ECR repo, EFS filesystem, ECS cluster/task definition, and EventBridge rules
# Region: us-west-1

set -e

REGION="us-west-1"
ECR_REPO_NAME="ananda-crawler"
CLUSTER_NAME="ananda-crawler-cluster"
TASK_FAMILY="ananda-crawler-task"
EFS_NAME="ananda-crawler-efs"
SECRETS_NAME="ananda-crawler-secrets"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
NC='\033[0m' # No Color

echo -e "${GREEN}Starting AWS setup for crawler deployment...${NC}"

# Check AWS CLI is installed and configured
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured. Run 'aws configure' first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ AWS CLI configured${NC}"

# Step 1: Create ECR repository
echo -e "\n${YELLOW}Step 1: Creating ECR repository...${NC}"
if aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}ECR repository already exists, skipping creation${NC}"
else
    aws ecr create-repository \
        --repository-name "$ECR_REPO_NAME" \
        --region "$REGION" \
        --image-scanning-configuration scanOnPush=true \
        --encryption-configuration encryptionType=AES256
    echo -e "${GREEN}✓ ECR repository created${NC}"
fi

ECR_URI=$(aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$REGION" --query 'repositories[0].repositoryUri' --output text)
echo -e "${GREEN}ECR URI: ${ECR_URI}${NC}"

# Step 2: Create EFS filesystem
echo -e "\n${YELLOW}Step 2: Creating EFS filesystem...${NC}"
EFS_ID=$(aws efs describe-file-systems \
    --region "$REGION" \
    --query "FileSystems[?Name=='$EFS_NAME'].FileSystemId" \
    --output text 2>/dev/null || echo "")

if [ -z "$EFS_ID" ]; then
    EFS_ID=$(aws efs create-file-system \
        --region "$REGION" \
        --performance-mode generalPurpose \
        --throughput-mode bursting \
        --encrypted \
        --tags "Key=Name,Value=$EFS_NAME" \
        --query 'FileSystemId' \
        --output text)
    echo -e "${GREEN}✓ EFS filesystem created: ${EFS_ID}${NC}"
    
    # Wait for filesystem to be available (poll until LifeCycleState is 'available')
    echo "Waiting for EFS to be available..."
    MAX_ATTEMPTS=30
    ATTEMPT=0
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        STATE=$(aws efs describe-file-systems \
            --region "$REGION" \
            --file-system-id "$EFS_ID" \
            --query 'FileSystems[0].LifeCycleState' \
            --output text 2>/dev/null || echo "creating")
        
        if [ "$STATE" == "available" ]; then
            echo -e "${GREEN}✓ EFS is available${NC}"
            break
        fi
        
        ATTEMPT=$((ATTEMPT + 1))
        echo "  Attempt $ATTEMPT/$MAX_ATTEMPTS: State is '$STATE', waiting..."
        sleep 2
    done
    
    if [ "$STATE" != "available" ]; then
        echo -e "${YELLOW}Warning: EFS may not be fully available yet, but continuing...${NC}"
    fi
else
    echo -e "${YELLOW}EFS filesystem already exists: ${EFS_ID}${NC}"
fi

# Get VPC ID (use default VPC or first available)
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[0].VpcId' --output text)
fi

echo -e "${GREEN}Using VPC: ${VPC_ID}${NC}"

# Get subnets in the VPC
SUBNET_IDS=$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[*].SubnetId' \
    --output text | awk '{print $1}')

if [ -z "$SUBNET_IDS" ]; then
    echo -e "${RED}Error: No subnets found in VPC ${VPC_ID}${NC}"
    exit 1
fi

SUBNET_ID=$(echo $SUBNET_IDS | cut -d' ' -f1)
echo -e "${GREEN}Using subnet: ${SUBNET_ID}${NC}"

# Create mount targets for EFS in each subnet
echo -e "\n${YELLOW}Creating EFS mount targets...${NC}"
for SUBNET in $SUBNET_IDS; do
    # Get security group for EFS (create if needed)
    SG_NAME="efs-sg-${EFS_ID:0:8}"
    SG_ID=$(aws ec2 describe-security-groups \
        --region "$REGION" \
        --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
        --query 'SecurityGroups[0].GroupId' \
        --output text 2>/dev/null || echo "")
    
    if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
        SG_ID=$(aws ec2 create-security-group \
            --region "$REGION" \
            --group-name "$SG_NAME" \
            --description "Security group for EFS access" \
            --vpc-id "$VPC_ID" \
            --query 'GroupId' \
            --output text)
        
        # Allow NFS traffic from VPC
        aws ec2 authorize-security-group-ingress \
            --region "$REGION" \
            --group-id "$SG_ID" \
            --protocol tcp \
            --port 2049 \
            --cidr $(aws ec2 describe-vpcs --region "$REGION" --vpc-ids "$VPC_ID" --query 'Vpcs[0].CidrBlock' --output text) \
            &> /dev/null || true
        
        echo -e "${GREEN}✓ Created security group: ${SG_ID}${NC}"
    fi
    
    # Check if mount target exists
    MOUNT_TARGET_ID=$(aws efs describe-mount-targets \
        --region "$REGION" \
        --file-system-id "$EFS_ID" \
        --query "MountTargets[?SubnetId=='$SUBNET'].MountTargetId" \
        --output text 2>/dev/null || echo "")
    
    if [ -z "$MOUNT_TARGET_ID" ]; then
        aws efs create-mount-target \
            --region "$REGION" \
            --file-system-id "$EFS_ID" \
            --subnet-id "$SUBNET" \
            --security-groups "$SG_ID" \
            &> /dev/null || echo -e "${YELLOW}Mount target may already exist for subnet ${SUBNET}${NC}"
    fi
done

echo -e "${GREEN}✓ EFS mount targets configured${NC}"

# Create EFS access point for the crawler
echo -e "\n${YELLOW}Creating EFS access point...${NC}"
ACCESS_POINT_ID=$(aws efs describe-access-points \
    --region "$REGION" \
    --file-system-id "$EFS_ID" \
    --query "AccessPoints[?Name=='crawler-data'].AccessPointId" \
    --output text 2>/dev/null || echo "")

if [ -z "$ACCESS_POINT_ID" ]; then
    ACCESS_POINT_ID=$(aws efs create-access-point \
        --region "$REGION" \
        --file-system-id "$EFS_ID" \
        --posix-user Uid=1000,Gid=1000 \
        --root-directory Path=/crawler-data,CreationInfo='{OwnerUid=1000,OwnerGid=1000,Permissions=755}' \
        --tags "Key=Name,Value=crawler-data" \
        --query 'AccessPointId' \
        --output text)
    echo -e "${GREEN}✓ EFS access point created: ${ACCESS_POINT_ID}${NC}"
else
    echo -e "${YELLOW}EFS access point already exists: ${ACCESS_POINT_ID}${NC}"
fi

# Step 3: Create ECS service linked role (if needed)
echo -e "\n${YELLOW}Step 3: Checking ECS service linked role...${NC}"
SERVICE_LINKED_ROLE_NAME="AWSServiceRoleForECS"
if aws iam get-role --role-name "$SERVICE_LINKED_ROLE_NAME" &> /dev/null; then
    echo -e "${GREEN}✓ ECS service linked role already exists${NC}"
else
    echo -e "${YELLOW}Creating ECS service linked role...${NC}"
    aws iam create-service-linked-role \
        --aws-service-name ecs.amazonaws.com 2>&1 | grep -v "already exists" || true
    echo -e "${GREEN}✓ ECS service linked role created${NC}"
    # Wait a moment for the role to propagate
    sleep 2
fi

# Step 4: Create ECS cluster
echo -e "\n${YELLOW}Step 4: Creating ECS cluster...${NC}"
if aws ecs describe-clusters --clusters "$CLUSTER_NAME" --region "$REGION" --query 'clusters[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
    echo -e "${YELLOW}ECS cluster already exists, skipping creation${NC}"
else
    aws ecs create-cluster \
        --cluster-name "$CLUSTER_NAME" \
        --region "$REGION" \
        --capacity-providers FARGATE FARGATE_SPOT \
        --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1
    echo -e "${GREEN}✓ ECS cluster created${NC}"
fi

# Step 5: Create task execution role and task role
echo -e "\n${YELLOW}Step 5: Creating IAM roles...${NC}"

# Task execution role (for ECS to pull images, write logs, etc.)
EXEC_ROLE_NAME="ecsTaskExecutionRole"
if aws iam get-role --role-name "$EXEC_ROLE_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}Task execution role already exists${NC}"
    EXEC_ROLE_ARN=$(aws iam get-role --role-name "$EXEC_ROLE_NAME" --query 'Role.Arn' --output text)
    
    # Check if Secrets Manager policy exists, add if missing
    if ! aws iam get-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name "SecretsManagerAccess" &> /dev/null; then
        cat > /tmp/ecs-exec-secrets-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:${REGION}:*:secret:${SECRETS_NAME}*"
    }
  ]
}
EOF
        
        aws iam put-role-policy \
            --role-name "$EXEC_ROLE_NAME" \
            --policy-name "SecretsManagerAccess" \
            --policy-document file:///tmp/ecs-exec-secrets-policy.json
        
        echo -e "${GREEN}✓ Added Secrets Manager access to existing execution role${NC}"
    fi
else
    # Create trust policy
    cat > /tmp/ecs-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    EXEC_ROLE_ARN=$(aws iam create-role \
        --role-name "$EXEC_ROLE_NAME" \
        --assume-role-policy-document file:///tmp/ecs-trust-policy.json \
        --query 'Role.Arn' \
        --output text)
    
    # Attach managed policy
    aws iam attach-role-policy \
        --role-name "$EXEC_ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
    
    # Add Secrets Manager permissions for retrieving secrets
    cat > /tmp/ecs-exec-secrets-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:${REGION}:*:secret:${SECRETS_NAME}*"
    }
  ]
}
EOF
    
    aws iam put-role-policy \
        --role-name "$EXEC_ROLE_NAME" \
        --policy-name "SecretsManagerAccess" \
        --policy-document file:///tmp/ecs-exec-secrets-policy.json
    
    echo -e "${GREEN}✓ Task execution role created with Secrets Manager access${NC}"
fi

# Task role (for the application to access AWS services)
TASK_ROLE_NAME="ananda-crawler-task-role"
if aws iam get-role --role-name "$TASK_ROLE_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}Task role already exists${NC}"
    TASK_ROLE_ARN=$(aws iam get-role --role-name "$TASK_ROLE_NAME" --query 'Role.Arn' --output text)
else
    TASK_ROLE_ARN=$(aws iam create-role \
        --role-name "$TASK_ROLE_NAME" \
        --assume-role-policy-document file:///tmp/ecs-trust-policy.json \
        --query 'Role.Arn' \
        --output text)
    
    # Create policy for Secrets Manager and S3 access
    cat > /tmp/crawler-task-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:${REGION}:*:secret:${SECRETS_NAME}*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::ananda-crawler-temp-*/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::ananda-crawler-temp-*"
    }
  ]
}
EOF

    POLICY_ARN=$(aws iam create-policy \
        --policy-name "ananda-crawler-task-policy" \
        --policy-document file:///tmp/crawler-task-policy.json \
        --query 'Policy.Arn' \
        --output text)

    aws iam attach-role-policy \
        --role-name "$TASK_ROLE_NAME" \
        --policy-arn "$POLICY_ARN"
    
    echo -e "${GREEN}✓ Task role created with S3 and Secrets Manager access${NC}"
fi

# Create CloudWatch log group for ECS tasks
echo -e "\n${YELLOW}Step 6: Creating CloudWatch log group...${NC}"
LOG_GROUP_NAME="/ecs/ananda-crawler"
if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}Log group already exists${NC}"
else
    aws logs create-log-group \
        --log-group-name "$LOG_GROUP_NAME" \
        --region "$REGION"
    echo -e "${GREEN}✓ Log group created${NC}"
fi

# Step 7: Create Secrets Manager secret (user needs to populate values)
echo -e "\n${YELLOW}Step 7: Creating Secrets Manager secret...${NC}"
if aws secretsmanager describe-secret --secret-id "$SECRETS_NAME" --region "$REGION" &> /dev/null; then
    echo -e "${YELLOW}Secret already exists${NC}"
    echo -e "${YELLOW}Note: Update secret values manually if needed${NC}"
else
    # Create placeholder secret (user must update with real values)
    aws secretsmanager create-secret \
        --name "$SECRETS_NAME" \
        --region "$REGION" \
        --description "Environment variables for Ananda crawler" \
        --secret-string '{"PLACEHOLDER":"Update this secret with actual environment variables"}'
    echo -e "${GREEN}✓ Secret created (PLACEHOLDER - update with real values)${NC}"
    echo -e "${YELLOW}⚠ IMPORTANT: Update the secret with actual environment variables:${NC}"
    echo -e "   aws secretsmanager put-secret-value --secret-id ${SECRETS_NAME} --secret-string file://secrets.json --region ${REGION}"
fi

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}AWS Infrastructure Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Update Secrets Manager secret with environment variables:"
echo "   aws secretsmanager put-secret-value --secret-id ${SECRETS_NAME} --secret-string file://secrets.json --region ${REGION}"
echo ""
echo "2. Build and push Docker image:"
echo "   ./build-and-push.sh"
echo ""
echo "3. Register ECS task definition:"
echo "   ./register-task-definition.sh"
echo ""
echo "4. Create EventBridge schedule:"
echo "   ./create-schedule.sh"
echo ""
echo "Configuration values:"
echo "  ECR URI: ${ECR_URI}"
echo "  EFS ID: ${EFS_ID}"
echo "  EFS Access Point: ${ACCESS_POINT_ID}"
echo "  Cluster: ${CLUSTER_NAME}"
echo "  Task Execution Role: ${EXEC_ROLE_ARN}"
echo "  Task Role: ${TASK_ROLE_ARN}"
echo "  Log Group: ${LOG_GROUP_NAME}"
echo "  Secrets: ${SECRETS_NAME}"

