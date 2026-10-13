#!/bin/bash

# Script to run jest in the web directory with the correct arguments
# This is used by lint-staged during git commits

set -e

# Change to the web directory
cd "$(dirname "$0")/../web" || exit 1

# Print debugging information
echo "🧪 Running JavaScript/TypeScript tests for changed files..."
echo "Current directory: $(pwd)"
echo "Arguments received: $*"

# Check if we have any files to test
if [ $# -eq 0 ]; then
    echo "No files provided to test"
    exit 0
fi

# Function to determine if we need to run server tests
needs_server_tests() {
    local files=("$@")
    for file in "${files[@]}"; do
        # Normalize paths - handle both absolute and relative paths
        if [[ "$file" == /* ]]; then
            # Absolute path - strip workspace root and web/ prefix
            workspace_root="/Users/Michael/Documents/development/mega-rag-chatbot"
            normalized_file="${file#$workspace_root/}"
            normalized_file="${normalized_file#web/}"
        else
            # Relative path - just strip web/ prefix if present
            normalized_file="${file#web/}"
        fi
        
        case "$normalized_file" in
            pages/api/*|utils/server/*|services/*|__tests__/utils/server/*|__tests__/api/*)
                return 0
                ;;
        esac
    done
    return 1
}

# Determine test strategy based on changed files
run_server_tests=false
if needs_server_tests "$@"; then
    run_server_tests=true
    echo "📡 Server-side files detected - will run server tests"
fi

# Use timeout to ensure we don't exceed 25 seconds
timeout_cmd=""
if command -v timeout >/dev/null 2>&1; then
    timeout_cmd="timeout 25s"
elif command -v gtimeout >/dev/null 2>&1; then
    # macOS with coreutils installed via brew
    timeout_cmd="gtimeout 25s"
fi

# Run client tests first (always run these)
echo "Running client tests..."

# Check if we have test files vs source files
has_test_files=false
has_source_files=false
for file in "$@"; do
    case "$file" in
        */__tests__/*|*.test.*|*.spec.*)
            has_test_files=true
            ;;
        *)
            has_source_files=true
            ;;
    esac
done

# Build client command based on file types
if [ "$has_test_files" = true ] && [ "$has_source_files" = false ]; then
    # Only test files - run them directly, but exclude server tests
    client_cmd="npx jest --bail --passWithNoTests --no-coverage --config=src/config/jest.pre-commit.cjs"
else
    # Source files or mixed - use findRelatedTests
    client_cmd="npx jest --bail --passWithNoTests --no-coverage --config=src/config/jest.pre-commit.cjs --findRelatedTests"
fi

# Add files to client test command, but exclude server test files and server source files
client_files=()
for file in "$@"; do
    # Normalize paths - handle both absolute and relative paths
    if [[ "$file" == /* ]]; then
        # Absolute path - strip workspace root and web/ prefix
        workspace_root="/Users/Michael/Documents/development/mega-rag-chatbot"
        normalized_file="${file#$workspace_root/}"
        normalized_file="${normalized_file#web/}"
    else
        # Relative path - just strip web/ prefix if present
        normalized_file="${file#web/}"
    fi
    
    case "$normalized_file" in
        __tests__/utils/server/*|__tests__/api/*|utils/server/*|services/*|pages/api/*)
            # Skip server tests and server source files for client test run
            echo "Excluding server file from client tests: $normalized_file"
            ;;
        *)
            client_files+=("$normalized_file")
            client_cmd="$client_cmd \"$normalized_file\""
            ;;
    esac
done

# --findRelatedTests requires file paths. Server-only commits have none left.
if [ "$has_source_files" = true ] && [ ${#client_files[@]} -eq 0 ]; then
    echo "No client files to test - skipping client tests"
    client_exit_code=0
else
    # Run client tests (allow failures but capture exit code)
    set +e
    if [ -n "$timeout_cmd" ]; then
        eval "$timeout_cmd $client_cmd"
    else
        eval "$client_cmd"
    fi
    client_exit_code=$?
    set -e
fi

# Run server tests if needed
server_exit_code=0
if [ "$run_server_tests" = true ]; then
    echo "Running server tests..."
    server_cmd="npx jest --selectProjects=server --bail --passWithNoTests --no-coverage --findRelatedTests"
    
    # Add server-related files to server test command
    for file in "$@"; do
        # Normalize paths - handle both absolute and relative paths
        if [[ "$file" == /* ]]; then
            # Absolute path - strip workspace root and web/ prefix
            workspace_root="/Users/Michael/Documents/development/mega-rag-chatbot"
            normalized_file="${file#$workspace_root/}"
            normalized_file="${normalized_file#web/}"
        else
            # Relative path - just strip web/ prefix if present
            normalized_file="${file#web/}"
        fi
        
        case "$normalized_file" in
            pages/api/*|utils/server/*|services/*|__tests__/utils/server/*|__tests__/api/*)
                server_cmd="$server_cmd \"$normalized_file\""
                echo "Including server file in server tests: $normalized_file"
                ;;
        esac
    done
    
    # Run server tests
    set +e
    if [ -n "$timeout_cmd" ]; then
        eval "$timeout_cmd $server_cmd"
    else
        eval "$server_cmd"
    fi
    server_exit_code=$?
    set -e
fi

# Handle results
overall_success=true

if [ $client_exit_code -eq 0 ]; then
    echo "✅ Client tests passed!"
elif [ $client_exit_code -eq 124 ]; then
    echo "❌ Client tests timed out (>25s)"
    overall_success=false
else
    echo "❌ Client tests failed (exit code: $client_exit_code)"
    overall_success=false
fi

if [ "$run_server_tests" = true ]; then
    if [ $server_exit_code -eq 0 ]; then
        echo "✅ Server tests passed!"
    elif [ $server_exit_code -eq 124 ]; then
        echo "❌ Server tests timed out (>25s)"
        overall_success=false
    else
        echo "❌ Server tests failed (exit code: $server_exit_code)"
        overall_success=false
    fi
fi

if [ "$overall_success" = false ]; then
    echo ""
    echo "❌ Tests failed - commit blocked!"
    echo "   Fix the failing tests before committing."
    echo "   Run full test suite to debug:"
    echo "   cd web && npm run test:all"
    echo ""
    exit 1
fi

echo "✅ All tests passed - commit allowed"
exit 0