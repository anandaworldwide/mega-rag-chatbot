# Bugs and Potential Issues

1. Race Conditions and Timing:

- Firestore transactions (memories emphasize reads before writes) are used in places like chat saving, but concurrent
  updates (e.g., in /api/vote.ts) might conflict without proper locking.

- Multiple setTimeout in streaming responses (e.g., chat route) could cause out-of-order events or unclosed streams.

1. Client-Side State Management:

- Hooks like useChatHistory.ts use infinite scrolling with cursors, but if DB queries fail mid-fetch, UI shows partial
  data without errors.

- Input fields (e.g., ChatInput.tsx) reset height with auto, but on mobile resize, could cause layout shifts or focus
  loss.

1. Error Prone Patterns:

- Dynamic imports in error handlers (memories flag as sloppy)—seen in some utils, could fail if modules aren't
  pre-loaded.

- UUID validation in chat API uses regex but assumes v4 only—potential mismatch if other formats are sent.

1. Performance:

- Reranking fetches extra docs (15+), then trims—inefficient for large queries.

- Queries in /api/leaderboard.ts aggregate without limits, could timeout on large datasets.

1. Testing Gaps:

- Memories note issues with Jest mocks (e.g., AWS SDK)—if not all endpoints are tested, bugs like unhandled promises
  could slip through.
