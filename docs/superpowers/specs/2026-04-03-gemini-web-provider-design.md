# Gemini Web Provider Design

- Date: 2026-04-03
- Status: Approved for implementation planning
- Scope: Phase 1 (print/pipe mode only)

## 1. Problem Statement
Current runtime paths depend on API-backed providers (`firstParty`, `bedrock`, `vertex`, `foundry`).
The requested capability is a new provider that uses Web Gemini as the reasoning backend through browser automation, without requiring an API key path for model calls.

The provider must enforce strict serialized turns: a new user request can only be sent after Gemini has fully completed the previous response.

## 2. Goals
1. Add a new formal provider `geminiWeb`.
2. Enable via environment variable `CLAUDE_CODE_USE_GEMINI_WEB=1`.
3. Drive [gemini.google.com](https://gemini.google.com) via Playwright.
4. Use a dedicated persistent browser profile (login once, reuse session).
5. Return final response only (no partial streaming in Phase 1).
6. Enforce strict completion gating:
   - Gemini generation has stopped.
   - Final response text is unchanged for 2 seconds.
7. Enforce strict turn serialization (no overlapping sends).
8. Use subprocess runner with NDJSON over stdio for process isolation.
9. Support non-interactive `--print` / pipe mode only in Phase 1.
10. Retry each failed request once automatically; then return structured error.

## 3. Non-Goals (Phase 1)
1. Interactive REPL support.
2. Partial streaming output to users.
3. Gemini tool-call execution protocol.
4. Dynamic Gemini model switching from `--model`.
5. Multiple Gemini endpoints (fixed to `gemini.google.com`).

## 4. Approved Product Decisions
1. Provider form: official provider (`geminiWeb`) rather than fallback-only mode.
2. Browser engine: Playwright first.
3. Session strategy: dedicated persistent profile.
4. Completion strategy: strict double condition + 2s stability window.
5. Output strategy: final-only response.
6. Endpoint strategy: fixed Gemini web endpoint.
7. Transport strategy: subprocess runner + NDJSON over stdio.
8. Launch mode: print/pipe only for first phase.

## 5. High-Level Architecture

### 5.1 Provider Selection
Extend provider selection to include `geminiWeb` when `CLAUDE_CODE_USE_GEMINI_WEB` is truthy.

Provider precedence (highest first):
1. `CLAUDE_CODE_USE_BEDROCK`
2. `CLAUDE_CODE_USE_VERTEX`
3. `CLAUDE_CODE_USE_FOUNDRY`
4. `CLAUDE_CODE_USE_GEMINI_WEB`
5. fallback `firstParty`

This preserves existing behavior while adding an explicit Gemini web path.

### 5.2 Query Execution Path
Do not emulate Anthropic SDK objects for Gemini.
Instead, branch at query execution layer:
- Existing providers continue through current SDK client flow.
- `geminiWeb` routes to `queryGeminiWeb()`.

Rationale:
- Avoid fragile Anthropic client shims.
- Keep Web Gemini-specific behavior isolated.
- Reduce blast radius in existing streaming internals.

### 5.3 Process Boundary
Use a child process runner to host Playwright and DOM automation.
Main process and runner communicate via NDJSON over stdin/stdout.

Benefits:
1. Browser crashes do not crash main CLI process.
2. Clear lifecycle boundaries (`init`, `shutdown`, restart).
3. Simple protocol testing with transport mocks.

## 6. Component Design

### 6.1 Main Process Components
1. `Provider Resolver`
   - Detects `geminiWeb` from env.
2. `GeminiWeb Query Adapter`
   - Converts conversation input into one send/wait cycle.
   - Handles one retry on failure.
   - Maps runner errors into user-facing/API error categories.
3. `GeminiWeb Runner Client`
   - Manages child process lifecycle.
   - Sends protocol commands and parses protocol responses.

### 6.2 Runner Components
1. `Playwright Session Manager`
   - Launches browser context with persistent profile.
   - Opens/recovers `gemini.google.com` page.
2. `Gemini DOM Driver`
   - Locates input box, send action, response container.
   - Reads latest assistant response text.
3. `Turn Gate / Mutex`
   - Ensures only one active request at a time.
4. `Completion Detector`
   - Waits until generation is stopped and response text stable for 2s.

## 7. NDJSON Protocol
All messages are single-line JSON objects.

### 7.1 Parent -> Runner Commands
1. `init`
```json
{"type":"init","request_id":"..."}
```
2. `send_prompt`
```json
{"type":"send_prompt","request_id":"...","prompt":"..."}
```
3. `await_response`
```json
{"type":"await_response","request_id":"..."}
```
4. `shutdown`
```json
{"type":"shutdown","request_id":"..."}
```

### 7.2 Runner -> Parent Events
1. `ack`
```json
{"type":"ack","request_id":"...","command":"init"}
```
2. `response_complete`
```json
{"type":"response_complete","request_id":"...","text":"...","timings":{"total_ms":12345}}
```
3. `error`
```json
{"type":"error","request_id":"...","code":"response_timeout","message":"...","retryable":true}
```

### 7.3 Protocol Guarantees
1. One `request_id` corresponds to exactly one terminal event (`response_complete` or `error`).
2. Runner rejects concurrent `send_prompt` while another turn is active.
3. Parent only sends next turn after terminal event for previous turn.

## 8. Turn Serialization & Completion Semantics

### 8.1 Serialization Rules
1. Parent-side queue: at most one active in-flight Gemini request.
2. Runner-side mutex: rejects overlapping commands with `concurrency_violation`.
3. No command interleaving between `send_prompt` and its matching terminal event.

### 8.2 Completion Detector
A turn is complete only if both conditions hold:
1. Gemini is no longer generating (UI generation state ended).
2. Latest response text has not changed for continuous 2000ms.

Polling loop collects latest response text snapshots.
When text changes, stability timer resets.
When generation ended and stable timer reaches 2000ms, return `response_complete`.

## 9. Error Model and Retry Policy

### 9.1 Runner Error Codes
1. `login_required`
2. `navigation_failed`
3. `input_not_ready`
4. `response_timeout`
5. `response_parse_failed`
6. `concurrency_violation`
7. `runner_crashed`

### 9.2 Retry Policy
1. Main process retries one time on retryable errors.
2. If retry also fails, return terminal error upstream.
3. Non-retryable errors fail immediately.

### 9.3 User-Facing Behavior
- In `--print` mode: return final text on success.
- On failure: return clear structured error message; do not emit partial text.

## 10. Config & Runtime Behavior

### 10.1 Required Config
1. `CLAUDE_CODE_USE_GEMINI_WEB=1`

### 10.2 Fixed Config (Phase 1)
1. Endpoint fixed to `https://gemini.google.com`.
2. Stability window fixed to `2000ms`.
3. Response mode fixed to final-only.

### 10.3 Session Storage
Use dedicated profile directory for Playwright persistent context to preserve login session between runs.

## 11. Integration Plan (Code Touch Areas)
1. Provider enum and resolution logic.
2. Query routing in API query path to call `queryGeminiWeb()` for this provider.
3. Non-interactive mode guard:
   - allow in `--print`.
   - reject interactive REPL with explicit error.
4. Status/account provider display updates to include `Gemini Web`.
5. Environment propagation paths that currently propagate provider env vars (teammates/subprocess-managed env constants).
6. Telemetry and error classification branches that currently special-case only bedrock/vertex/foundry.

## 12. Testing Strategy

### 12.1 Unit Tests
1. Provider selection precedence including `geminiWeb`.
2. Serialization guard behavior.
3. Error mapping and retry behavior.
4. Print-only guard behavior.

### 12.2 Protocol Tests
1. NDJSON parsing/serialization.
2. Command-response pairing by `request_id`.
3. Runner terminal event guarantee.

### 12.3 Runner Logic Tests (Mocked)
1. Completion detector behavior under changing/stable text.
2. Timeout and parse failure paths.
3. Concurrency violation handling.

### 12.4 End-to-End Scope (Phase 1)
No live Gemini website e2e in CI.
Use mocked DOM driver contracts for deterministic tests.

## 13. Risks and Mitigations
1. Gemini DOM changes can break selectors.
   - Mitigation: isolate selectors in a single driver module and centralize fallback logic.
2. Browser instability in long sessions.
   - Mitigation: subprocess isolation and explicit restart path.
3. Login expiration.
   - Mitigation: explicit `login_required` error and user guidance.
4. Hidden concurrency bugs.
   - Mitigation: dual lock (parent queue + runner mutex) and protocol-level rejection.

## 14. Rollout Plan
1. Implement behind `CLAUDE_CODE_USE_GEMINI_WEB` only.
2. Keep default provider behavior unchanged.
3. Validate in print/pipe workflows first.
4. After stabilization, plan Phase 2 for REPL and optional streaming.

## 15. Acceptance Criteria (Phase 1)
1. With `CLAUDE_CODE_USE_GEMINI_WEB=1` and valid login session, non-interactive prompt returns final Gemini text.
2. A second prompt is never sent before the first response completes.
3. One automatic retry is attempted on retryable failure.
4. Interactive mode clearly reports unsupported status for this provider.
5. Existing providers continue to behave as before when Gemini provider env var is not enabled.
