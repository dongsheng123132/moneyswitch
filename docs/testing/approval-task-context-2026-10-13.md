# Approval task descriptions

Host and payment approvals now persist the explicit `/v1/fetch` `purpose` annotation. The administrator list, public PIN link, and key-scoped polling endpoint return the same annotation. Pending cards and recently handled rows show the task description and explain the approval trigger. Records created before this change retain a null description.

Only a caller-supplied, shareable summary is stored; task bodies, image inputs and private prompts are not copied into the annotation. Repeating a host request retains the first pending request's description. The existing request binding, PIN enforcement, thresholds, allowed-host decision, and payment limits are unchanged.

Validation:

- Dashboard production build and full dashboard suite: 243 tests passed; after the mobile layout correction, the 113 related page/PIN tests passed again.
- Core approval/purpose/host suite: 64 tests passed, including existing-database migration and reopening.
- Server host/PIN/purpose suites: 66 tests passed.
- Generated skill and content contract: 92 tests passed.
- Bundled server build and unit suite: 15 tests passed; bundled migrations include `0013_approval_purpose.sql`.
- Administrator and PIN previews checked at 1440 px and 390 px: task and reason visible, no horizontal overflow; visually inspected desktop and mobile renders.

The inherited host-approval test still expected 10 minutes while the source TTL is 30 minutes; it now asserts the shared `APPROVAL_TTL_MS` value.

Deployed to `https://app.moneyswitch.dev` on 2026-10-13 at 17:17 China time after explicit user authorization. The patch was rebased onto the latest source branch, preserving the existing 30-minute approval TTL. Running revision: `0c0e0934d6d38757ec1769242239f16c7abe21d3`, image: `moneyswitch:0c0e093`, release: `/opt/moneyswitch/releases/0c0e093`.

Deployment validation:

- Linux image acceptance: 31 checks passed in a disposable container with no external network; real payments: 0.
- Verified configuration and wallet/data backup: `/opt/moneyswitch/backups/20261013-171738`.
- Read-only database integrity: `quick_check=ok`; nullable `approvals.purpose` migration present.
- Before/after digests match for all 24 MoneyKeys, 13 payments, 26 existing approvals, administrator authentication, wallet metadata and encrypted wallet file. Enabled networks and default network match.
- Runtime SHA-256: `45c1a142d544e94453d4b70110e987a8b0e0a7537e91a1e9a061685b0d39ad70`; public dashboard JS and CSS hashes match the release package.
- HTTPS health and existing approval-link API passed. The real public PIN page displays task/reason context on desktop and mobile without horizontal overflow; no decision or PIN was submitted.
- Local evidence: `C:/1mineyswitch/output/approval-task-context/deployment-verification.json`, integrity summaries and `live-pin-desktop.png` / `live-pin-mobile.png`.

Existing production approvals were created before this annotation was persisted and retain a null description. Their task label says "No task description supplied"; the approval reason is still displayed. New requests preserve only the explicit Agent-supplied `purpose` annotation.

During the separate BlockRun poster test, the upstream charged 0.127 USDC and returned a successful image payload, but the deployed MoneySwitch proxy truncated its JSON body at 1 MiB. The output cannot be decoded as a complete image. The job was not resubmitted. Recovery of the existing job requires a fresh x402 signature and was blocked by automatic approval review pending explicit authorization for potential extra fees. No response-size or payment-recovery behavior is changed in this approval-description patch.
