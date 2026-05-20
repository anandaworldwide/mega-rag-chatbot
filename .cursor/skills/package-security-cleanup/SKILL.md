---
name: package-security-cleanup
description:
  Investigate and resolve package security issues, nightly build failures, and dependency vulnerabilities in accordance
  with project security policy.
disable-model-invocation: true
---

# Package Security Cleanup

This skill is responsible for triaging and recommending actions on any issues related to package security and dependency
maintenance. When invoked:

1. **Investigate Issues:**
   - Review errors or logs from the latest nightly build and identify any failures related to outdated, vulnerable, or
     incompatible packages.
   - Check dependabot alerts and security dashboards for open vulnerability reports or recommended dependency upgrades.
   - Scan for open pull requests tagged as security-related or dependency updates.

2. **Apply the Seven-Day Cool-Down Policy:**
   - Before recommending any package update or library adoption, confirm that at least seven days have passed since the
     new library version was published to the public registry or source.
   - Flag any library newer than seven days and defer its adoption until the policy window is satisfied.

3. **Recommend and Seek Approval:**
   - Present a summary of findings, prioritized by severity, and clearly recommend actions for each (e.g., accept, hold,
     reject, or investigate further).
   - Submit your recommendations for human approval. Do not apply changes, merge PRs, or update lockfiles without
     explicit approval from a maintainer.

4. **Post-Approval Actions (if approval is received):**
   - Once approval for specific actions is granted, proceed with updating, merging, or patching as allowed.
   - Ensure all changes follow internal change management procedures and security review protocols.

**Note:**  
Always document your investigation, link to relevant issues/PRs, and clearly indicate which fixes are urgent or require
further attention. Actions must always comply with project cool-down and security review policies.
