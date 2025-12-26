#!/bin/bash
# Helper script to create secrets.json from .env file
# Usage: ./create-secrets-json.sh [site-id]
# Example: ./create-secrets-json.sh ananda-public

set -e

SITE_ID="${1:-ananda-public}"
ENV_FILE="../../.env.${SITE_ID}"
OUTPUT_FILE="secrets.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[38;5;130m'  # Brown color for better readability
RED='\033[0;31m'
NC='\033[0m'

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: Environment file not found: ${ENV_FILE}${NC}"
    echo "Usage: $0 [site-id]"
    exit 1
fi

echo -e "${GREEN}Creating secrets.json from ${ENV_FILE}...${NC}"

# Required environment variables (must have values)
REQUIRED_VARS=(
    "OPENAI_API_KEY"
    "OPENAI_INGEST_EMBEDDINGS_MODEL"
    "PINECONE_API_KEY"
    "PINECONE_INGEST_INDEX_NAME"
)

# Start JSON object
echo "{" > "$OUTPUT_FILE"

FIRST=true
MISSING_REQUIRED=false

# Function to extract variable value from .env file
extract_env_value() {
    local var_name="$1"
    # Match: VAR=value, VAR = value, VAR="value", VAR='value', VAR=value # comment, VAR= (empty)
    # Handle all cases including empty values
    local line=$(grep -E "^[[:space:]]*${var_name}[[:space:]]*=" "$ENV_FILE" | head -1)
    
    if [ -z "$line" ]; then
        echo ""
        return
    fi
    
    # Extract value part (everything after =)
    local value=$(echo "$line" | sed 's/^[^=]*=[[:space:]]*//')
    
    # Remove inline comments (but preserve # in quoted strings)
    # Only remove # if it's not inside quotes
    if echo "$value" | grep -qE '^["\047]'; then
        # Quoted value - remove quotes but keep content
        value=$(echo "$value" | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/")
    else
        # Unquoted value - remove comments
        value=$(echo "$value" | sed 's/[[:space:]]*#.*$//')
    fi
    
    # Trim whitespace
    echo "$value" | xargs
}

# Read .env file and extract required variables
for VAR in "${REQUIRED_VARS[@]}"; do
    VALUE=$(extract_env_value "$VAR")
    
    # Check if variable exists in file (even if empty)
    if ! grep -qE "^[[:space:]]*${VAR}[[:space:]]*=" "$ENV_FILE"; then
        echo -e "${RED}Error: ${VAR} is required but not found in ${ENV_FILE}${NC}"
        echo -e "${YELLOW}  Looking for: ${VAR}=... (with or without quotes/spaces)${NC}"
        MISSING_REQUIRED=true
        continue
    fi
    
    # Check if value is empty (but variable exists)
    if [ -z "$VALUE" ]; then
        echo -e "${RED}Error: ${VAR} is set but has no value in ${ENV_FILE}${NC}"
        MISSING_REQUIRED=true
        continue
    fi
    
    if [ "$FIRST" = false ]; then
        echo "," >> "$OUTPUT_FILE"
    fi
    
    # Escape JSON special characters
    ESCAPED_VALUE=$(echo "$VALUE" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
    
    echo -n "  \"${VAR}\": \"${ESCAPED_VALUE}\"" >> "$OUTPUT_FILE"
    FIRST=false
done


# Always add SITE (set from site-id parameter)
if [ "$FIRST" = false ]; then
    echo "," >> "$OUTPUT_FILE"
fi
echo -n "  \"SITE\": \"${SITE_ID}\"" >> "$OUTPUT_FILE"

# Close JSON object
echo "" >> "$OUTPUT_FILE"
echo "}" >> "$OUTPUT_FILE"

# Check for missing required variables
if [ "$MISSING_REQUIRED" = true ]; then
    echo -e "\n${RED}Error: Missing required environment variables. Please add them to ${ENV_FILE}${NC}"
    rm -f "$OUTPUT_FILE"
    exit 1
fi

# Format JSON (if jq is available)
if command -v jq &> /dev/null; then
    # Use a temporary file in the same directory to avoid permission issues
    TEMP_FILE="${OUTPUT_FILE}.tmp.$$"
    if jq . "$OUTPUT_FILE" > "$TEMP_FILE" 2>/dev/null; then
        mv "$TEMP_FILE" "$OUTPUT_FILE"
        echo -e "${GREEN}✓ Formatted JSON with jq${NC}"
    else
        # If jq fails, remove temp file and continue without formatting
        rm -f "$TEMP_FILE"
        echo -e "${YELLOW}Note: Could not format JSON with jq (file may still be valid)${NC}"
    fi
fi

echo -e "${GREEN}✓ Created ${OUTPUT_FILE}${NC}"
echo -e "${YELLOW}⚠ IMPORTANT: Review ${OUTPUT_FILE} before uploading to Secrets Manager${NC}"
echo -e "${YELLOW}⚠ Add ${OUTPUT_FILE} to .gitignore to avoid committing secrets${NC}"
echo ""
echo "To upload to AWS Secrets Manager:"
echo "  aws secretsmanager put-secret-value \\"
echo "    --secret-id ananda-crawler-secrets \\"
echo "    --secret-string file://${OUTPUT_FILE} \\"
echo "    --region us-west-1"

