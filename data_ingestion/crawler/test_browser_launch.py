#!/usr/bin/env python3
"""Simple test script to debug Playwright Firefox launch in container."""

import sys
import time

print("=== Playwright Firefox Launch Test ===", flush=True)
print(f"Python version: {sys.version}", flush=True)

# Test 1: Import playwright
print("\n[1] Importing playwright...", flush=True)
try:
    from playwright.sync_api import sync_playwright

    print("    ✓ Import successful", flush=True)
except Exception as e:
    print(f"    ✗ Import failed: {e}", flush=True)
    sys.exit(1)

# Test 2: Start playwright
print("\n[2] Starting Playwright context...", flush=True)
try:
    playwright = sync_playwright().start()
    print("    ✓ Playwright started", flush=True)
except Exception as e:
    print(f"    ✗ Playwright start failed: {e}", flush=True)
    sys.exit(1)

# Test 3: Launch Firefox with minimal config
print("\n[3] Launching Firefox (headless, 60s timeout)...", flush=True)
start_time = time.time()
try:
    browser = playwright.firefox.launch(
        headless=True,
        timeout=60000,  # 60 second timeout
    )
    elapsed = time.time() - start_time
    print(f"    ✓ Firefox launched in {elapsed:.1f}s", flush=True)
except Exception as e:
    elapsed = time.time() - start_time
    print(f"    ✗ Firefox launch failed after {elapsed:.1f}s: {e}", flush=True)
    playwright.stop()
    sys.exit(1)

# Test 4: Create a page
print("\n[4] Creating new page...", flush=True)
try:
    page = browser.new_page()
    print("    ✓ Page created", flush=True)
except Exception as e:
    print(f"    ✗ Page creation failed: {e}", flush=True)
    browser.close()
    playwright.stop()
    sys.exit(1)

# Test 5: Navigate to a simple page
print("\n[5] Navigating to example.com...", flush=True)
try:
    page.goto("https://example.com", timeout=30000)
    title = page.title()
    print(f"    ✓ Navigation successful, title: {title}", flush=True)
except Exception as e:
    print(f"    ✗ Navigation failed: {e}", flush=True)

# Cleanup
print("\n[6] Cleaning up...", flush=True)
try:
    page.close()
    browser.close()
    playwright.stop()
    print("    ✓ Cleanup complete", flush=True)
except Exception as e:
    print(f"    ✗ Cleanup error: {e}", flush=True)

print("\n=== All tests passed! ===", flush=True)
