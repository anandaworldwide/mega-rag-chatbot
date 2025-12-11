#!/bin/bash
# Build and push Docker image to ECR
# Region: us-west-1

set -e

REGION="us-west-1"
ECR_REPO_NAME="ananda-crawler"
IMAGE_TAG="${1:-latest}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
NC='\033[0m'

echo -e "${GREEN}Building Docker image...${NC}"

# Get ECR URI
ECR_URI=$(aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$REGION" --query 'repositories[0].repositoryUri' --output text)

if [ -z "$ECR_URI" ]; then
    echo -e "${YELLOW}Error: ECR repository not found. Run aws-setup.sh first.${NC}"
    exit 1
fi

FULL_IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Login to ECR
echo -e "${GREEN}Logging in to ECR...${NC}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Build image (from project root)
PROJECT_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJECT_ROOT"

echo -e "${GREEN}Building image from ${PROJECT_ROOT}...${NC}"
echo -e "${YELLOW}Building for linux/amd64 (Fargate requires x86_64)...${NC}"
docker build --platform linux/amd64 -f data_ingestion/crawler/Dockerfile -t "$ECR_REPO_NAME:$IMAGE_TAG" .

# Tag for ECR
docker tag "$ECR_REPO_NAME:$IMAGE_TAG" "$FULL_IMAGE_URI"

# Push to ECR
echo -e "${GREEN}Pushing image to ECR...${NC}"
docker push "$FULL_IMAGE_URI"

echo -e "${GREEN}✓ Image pushed successfully: ${FULL_IMAGE_URI}${NC}"

