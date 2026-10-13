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

Deployment has not been performed. Existing production approvals were created before this annotation was persisted, so their reasons cannot be retroactively reconstructed from private request bodies.

During the separate BlockRun poster test, the upstream charged 0.127 USDC and returned a successful image payload, but the deployed MoneySwitch proxy truncated its JSON body at 1 MiB. The output cannot be decoded as a complete image. The job was not resubmitted. Recovery of the existing job requires a fresh x402 signature and was blocked by automatic approval review pending explicit authorization for potential extra fees. No response-size or payment-recovery behavior is changed in this approval-description patch.
