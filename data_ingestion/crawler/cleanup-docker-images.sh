#!/bin/bash
# Clean up old Ananda crawler Docker images
# Removes dangling images and old versions, keeping only the most recent ones

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Checking for Ananda crawler Docker images...${NC}"

# List all images matching ananda-crawler
IMAGES=$(docker images --format "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}" | grep -iE "(ananda-crawler|crawler.*ananda)" || true)

if [ -z "$IMAGES" ]; then
    echo -e "${YELLOW}No ananda-crawler images found.${NC}"
    exit 0
fi

echo -e "\n${GREEN}Found images:${NC}"
echo "$IMAGES" | while IFS=$'\t' read -r name id created; do
    echo "  - $name (ID: $id, Created: $created)"
done

# Count images
IMAGE_COUNT=$(echo "$IMAGES" | wc -l | tr -d ' ')
echo -e "\n${YELLOW}Total images found: $IMAGE_COUNT${NC}"

# Ask for confirmation
echo -e "\n${YELLOW}Options:${NC}"
echo "  1. Remove all ananda-crawler images except 'latest'"
echo "  2. Remove all ananda-crawler images (including 'latest')"
echo "  3. Remove dangling images only"
echo "  4. Remove all except the most recent image"
echo "  5. List images only (no deletion)"
read -p "Choose option [1-5]: " choice

case $choice in
    1)
        echo -e "\n${RED}Removing all ananda-crawler images except 'latest'...${NC}"
        # Get all image IDs except 'latest'
        IMAGE_IDS=$(echo "$IMAGES" | grep -v ":latest\t" | awk '{print $2}' | sort -u)
        if [ -n "$IMAGE_IDS" ]; then
            echo "$IMAGE_IDS" | xargs docker rmi -f || true
            echo -e "${GREEN}✓ Removed old images${NC}"
        else
            echo -e "${YELLOW}No images to remove (only 'latest' exists)${NC}"
        fi
        ;;
    2)
        echo -e "\n${RED}Removing ALL ananda-crawler images...${NC}"
        # Get all image IDs
        IMAGE_IDS=$(echo "$IMAGES" | awk '{print $2}' | sort -u)
        if [ -n "$IMAGE_IDS" ]; then
            echo "$IMAGE_IDS" | xargs docker rmi -f || true
            echo -e "${GREEN}✓ Removed all images${NC}"
        fi
        ;;
    3)
        echo -e "\n${RED}Removing dangling images...${NC}"
        docker image prune -f
        echo -e "${GREEN}✓ Removed dangling images${NC}"
        ;;
    4)
        echo -e "\n${RED}Keeping only the most recent image...${NC}"
        # Get the most recent image ID (sorted by creation date)
        KEEP_ID=$(docker images --format "{{.ID}}\t{{.CreatedAt}}" --filter "reference=*ananda-crawler*" | sort -k2 -r | head -1 | awk '{print $1}')
        if [ -n "$KEEP_ID" ]; then
            echo -e "${GREEN}Keeping image ID: $KEEP_ID${NC}"
            # Get all image IDs
            ALL_IDS=$(echo "$IMAGES" | awk '{print $2}' | sort -u)
            REMOVE_IDS=$(echo "$ALL_IDS" | grep -v "^${KEEP_ID}$")
            if [ -n "$REMOVE_IDS" ]; then
                echo "$REMOVE_IDS" | xargs docker rmi -f || true
                echo -e "${GREEN}✓ Removed old images${NC}"
            else
                echo -e "${YELLOW}No images to remove${NC}"
            fi
        else
            echo -e "${YELLOW}Could not determine most recent image${NC}"
        fi
        ;;
    5)
        echo -e "\n${GREEN}Image listing complete. No images removed.${NC}"
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid option. Exiting.${NC}"
        exit 1
        ;;
esac

# Also clean up dangling images
echo -e "\n${GREEN}Cleaning up dangling images...${NC}"
docker image prune -f || true

# Show remaining images
echo -e "\n${GREEN}Remaining ananda-crawler images:${NC}"
docker images | grep -iE "(ananda-crawler|crawler.*ananda)" || echo "  (none)"

echo -e "\n${GREEN}✓ Cleanup complete${NC}"
