#!/bin/bash
# Manage the crawler daemon
# Usage: ./manage_crawler.sh [start|stop|restart|status|logs] [site-name]
# Default site: ananda-public

COMMAND=${1:-status}
SITE=${2:-ananda-public}
USER_ID=$(id -u)
SERVICE_NAME="com.ananda.crawler.${SITE}"
PLIST_FILE=~/Library/LaunchAgents/${SERVICE_NAME}.plist
LOG_DIR=~/Library/Logs/AnandaCrawler

# Function to show usage
show_usage() {
    echo "Usage: $0 [command] [site-name]"
    echo ""
    echo "Commands:"
    echo "  start    - Start the crawler daemon"
    echo "  stop     - Stop the crawler daemon"
    echo "  restart  - Restart the crawler daemon (default)"
    echo "  status   - Show crawler status"
    echo "  logs     - Tail crawler logs"
    echo ""
    echo "Default site: ananda-public"
    echo ""
    echo "Examples:"
    echo "  $0 restart"
    echo "  $0 status ananda-public"
    echo "  $0 logs"
}

# Check if plist file exists
check_plist() {
    if [ ! -f "$PLIST_FILE" ]; then
        echo "❌ Error: Plist file not found at $PLIST_FILE"
        echo "   Available plist files:"
        ls -1 ~/Library/LaunchAgents/com.ananda.crawler*.plist 2>/dev/null || echo "   (none found)"
        return 1
    fi
    return 0
}

# Start the crawler
start_crawler() {
    echo "🚀 Starting crawler for site: $SITE"
    check_plist || return 1
    
    if launchctl load "$PLIST_FILE" 2>&1; then
        echo "✅ Crawler started"
        sleep 2
        show_status
    else
        echo "❌ Failed to start crawler"
        return 1
    fi
}

# Stop the crawler
stop_crawler() {
    echo "🛑 Stopping crawler for site: $SITE"
    check_plist || return 1
    
    if launchctl unload "$PLIST_FILE" 2>&1; then
        echo "✅ Crawler stopped"
    else
        echo "❌ Failed to stop crawler"
        return 1
    fi
}

# Restart the crawler
restart_crawler() {
    echo "🔄 Restarting crawler for site: $SITE"
    check_plist || return 1
    
    if launchctl kickstart -k gui/${USER_ID}/${SERVICE_NAME} 2>&1; then
        echo "✅ Crawler restarted"
        sleep 2
        show_status
    else
        echo "⚠️  Kickstart failed, trying unload/load..."
        stop_crawler
        sleep 2
        start_crawler
    fi
}

# Show status
show_status() {
    echo "📊 Crawler status for site: $SITE"
    echo ""
    echo "Service registration:"
    launchctl list | grep crawler | while read -r line; do
        echo "   $line"
    done
    
    echo ""
    echo "Running processes:"
    ps aux | grep -E "(crawler_supervisor|website_crawler).*${SITE}" | grep -v grep | while read -r line; do
        echo "   $(echo $line | awk '{print $2, $11, $12, $13, $14, $15}')"
    done
    
    if [ -f "${LOG_DIR}/supervisor_${SITE}.log" ]; then
        echo ""
        echo "Recent log activity (last 5 lines):"
        tail -5 "${LOG_DIR}/supervisor_${SITE}.log" | sed 's/^/   /'
    fi
    
    echo ""
    echo "📝 View full logs:"
    echo "   tail -f ${LOG_DIR}/supervisor_${SITE}.log"
    echo "   tail -f ${LOG_DIR}/crawler_${SITE}.log"
}

# Tail logs
tail_logs() {
    echo "📝 Following logs for site: $SITE"
    echo "   Press Ctrl+C to stop"
    echo ""
    
    if [ -f "${LOG_DIR}/supervisor_${SITE}.log" ] && [ -f "${LOG_DIR}/crawler_${SITE}.log" ]; then
        tail -f "${LOG_DIR}/supervisor_${SITE}.log" "${LOG_DIR}/crawler_${SITE}.log"
    elif [ -f "${LOG_DIR}/supervisor_${SITE}.log" ]; then
        tail -f "${LOG_DIR}/supervisor_${SITE}.log"
    else
        echo "❌ No log files found at:"
        echo "   ${LOG_DIR}/supervisor_${SITE}.log"
        echo "   ${LOG_DIR}/crawler_${SITE}.log"
        return 1
    fi
}

# Main command dispatcher
case "$COMMAND" in
    start)
        start_crawler
        ;;
    stop)
        stop_crawler
        ;;
    restart)
        restart_crawler
        ;;
    status)
        show_status
        ;;
    logs)
        tail_logs
        ;;
    -h|--help|help)
        show_usage
        ;;
    *)
        echo "❌ Unknown command: $COMMAND"
        echo ""
        show_usage
        exit 1
        ;;
esac

