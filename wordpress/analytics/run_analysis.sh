#!/bin/bash
#
# WordPress Plugin Analytics Runner
# 
# This script provides convenient commands to run analytics with common configurations.
# Make executable with: chmod +x run_analysis.sh
#

set -e

# Configuration
PROPERTY_ID="266581873"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CREDENTIALS_PATH="${SCRIPT_DIR}/credentials/ga-service-account.json"
OUTPUT_DIR="${SCRIPT_DIR}/reports"
CHARTS_DIR="${SCRIPT_DIR}/charts"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_dependencies() {
    log_info "Checking dependencies..."
    
    # Check Python
    if ! command -v python3 &> /dev/null; then
        log_error "Python 3 is required but not installed"
        exit 1
    fi
    
    # Check uv
    if ! command -v uv &> /dev/null; then
        log_error "uv is required but not installed"
        log_info "Install uv with: curl -LsSf https://astral.sh/uv/install.sh | sh"
        exit 1
    fi

    log_info "Syncing analytics environment..."
    (
        cd "${REPO_ROOT}"
        uv sync --locked --package mega-rag-chatbot-wordpress-analytics --no-default-groups
    )
    log_success "Analytics environment is ready"
}

check_credentials() {
    if [[ ! -f "$CREDENTIALS_PATH" ]]; then
        log_error "Credentials file not found: $CREDENTIALS_PATH"
        log_info "Please:"
        log_info "1. Create the credentials directory: mkdir -p ${SCRIPT_DIR}/credentials"
        log_info "2. Download your Google service account JSON file"
        log_info "3. Save it as: ${CREDENTIALS_PATH}"
        exit 1
    fi
    log_success "Credentials file found"
}

create_directories() {
    mkdir -p "$OUTPUT_DIR" "$CHARTS_DIR"
}

run_analysis() {
    local days=${1:-30}
    local include_charts=${2:-false}
    local output_file="${OUTPUT_DIR}/report_$(date +%Y%m%d_%H%M%S).json"
    
    log_info "Running analysis for the last $days days..."
    
    # Build command
    local cmd="uv run --project ${REPO_ROOT} --package mega-rag-chatbot-wordpress-analytics python ${SCRIPT_DIR}/wordpress_plugin_analytics.py"
    cmd="$cmd --property-id $PROPERTY_ID"
    cmd="$cmd --credentials $CREDENTIALS_PATH"
    cmd="$cmd --days $days"
    cmd="$cmd --output $output_file"
    
    if [[ "$include_charts" == "true" ]]; then
        cmd="$cmd --charts --charts-dir $CHARTS_DIR"
    fi
    
    # Run the analysis
    if eval "$cmd"; then
        log_success "Analysis completed successfully!"
        log_info "Report saved to: $output_file"
        if [[ "$include_charts" == "true" ]]; then
            log_info "Charts saved to: $CHARTS_DIR"
        fi
    else
        log_error "Analysis failed"
        exit 1
    fi
}

show_usage() {
    echo "WordPress Plugin Analytics Runner"
    echo ""
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  setup                    Set up environment and dependencies"
    echo "  quick [DAYS]            Quick analysis (default: 7 days)"
    echo "  full [DAYS]             Full analysis with charts (default: 30 days)"
    echo "  weekly                  Weekly report (7 days with charts)"
    echo "  monthly                 Monthly report (30 days with charts)"
    echo "  custom DAYS [charts]    Custom analysis with optional charts"
    echo "  test                    Test connection and credentials"
    echo ""
    echo "Examples:"
    echo "  $0 setup                # Set up environment"
    echo "  $0 quick                # Quick 7-day analysis"
    echo "  $0 full                 # Full 30-day analysis with charts"
    echo "  $0 weekly               # Weekly report"
    echo "  $0 custom 14 charts     # 14-day analysis with charts"
    echo ""
}

# Main command handling
case "${1:-}" in
    "setup")
        log_info "Setting up WordPress Plugin Analytics..."
        check_dependencies
        create_directories
        
        if [[ ! -f "$CREDENTIALS_PATH" ]]; then
            log_warning "Credentials not found. Please add your Google service account JSON file:"
            log_info "mkdir -p ${SCRIPT_DIR}/credentials"
            log_info "# Copy your credentials file to: $CREDENTIALS_PATH"
        else
            log_success "Setup completed successfully!"
        fi
        ;;
        
    "quick")
        days=${2:-7}
        check_dependencies
        check_credentials
        create_directories
        run_analysis "$days" false
        ;;
        
    "full")
        days=${2:-30}
        check_dependencies
        check_credentials
        create_directories
        run_analysis "$days" true
        ;;
        
    "weekly")
        check_dependencies
        check_credentials
        create_directories
        run_analysis 7 true
        ;;
        
    "monthly")
        check_dependencies
        check_credentials
        create_directories
        run_analysis 30 true
        ;;
        
    "custom")
        if [[ -z "${2:-}" ]]; then
            log_error "Please specify number of days for custom analysis"
            show_usage
            exit 1
        fi
        
        days=$2
        include_charts=false
        if [[ "${3:-}" == "charts" ]]; then
            include_charts=true
        fi
        
        check_dependencies
        check_credentials
        create_directories
        run_analysis "$days" "$include_charts"
        ;;
        
    "test")
        log_info "Testing connection and credentials..."
        check_dependencies
        check_credentials
        # Run a minimal test
        uv run --project ${REPO_ROOT} --package mega-rag-chatbot-wordpress-analytics python -c "
from wordpress_plugin_analytics import WordPressPluginAnalytics
import sys

try:
    analytics = WordPressPluginAnalytics('$PROPERTY_ID', '$CREDENTIALS_PATH')
    print('✅ Connection successful!')
    print('✅ Credentials valid!')
    print('✅ Ready to run analytics!')
except Exception as e:
    print(f'❌ Test failed: {e}')
    sys.exit(1)
        "
        ;;
        
    "help"|"--help"|"-h"|"")
        show_usage
        ;;
        
    *)
        log_error "Unknown command: $1"
        show_usage
        exit 1
        ;;
esac
