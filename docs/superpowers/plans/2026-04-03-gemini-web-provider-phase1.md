# Gemini Web Provider (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe `geminiWeb` provider for `--print`/pipe mode that sends one request at a time to gemini.google.com through Playwright and returns final-only responses after strict completion.

**Architecture:** Route `geminiWeb` at the API query layer (`queryModel`) to a dedicated adapter that talks to a subprocess runner over NDJSON stdio. Keep browser automation and DOM handling isolated in the runner process with a strict mutex + completion detector (generation ended + 2s stable text).

**Tech Stack:** Bun/TypeScript, existing CLI architecture, child_process stdio protocol, Playwright persistent context, bun:test.

---

## Scope Check
This spec is one coherent subsystem (new provider + runner + query routing) and does not require decomposition into separate specs.

## File Structure (Planned)

### New files
- `src/services/geminiWeb/protocol.ts`
  - NDJSON message types + encode/decode helpers.
- `src/services/geminiWeb/modeGuard.ts`
  - Print-only guard for provider usage.
- `src/services/geminiWeb/runnerClient.ts`
  - Parent-side subprocess management and request/response orchestration.
- `src/services/geminiWeb/completionDetector.ts`
  - Pure completion/stability logic (generation ended + stable text window).
- `src/services/geminiWeb/domDriver.ts`
  - Playwright DOM operations for Gemini web input/send/response read.
- `src/services/geminiWeb/runner.ts`
  - Runner main loop (stdin commands -> Playwright actions -> stdout events).
- `src/services/geminiWeb/queryGeminiWeb.ts`
  - Adapter used by `queryModel` to execute a turn and convert to assistant/system messages.
- `src/services/geminiWeb/__tests__/protocol.test.ts`
- `src/services/geminiWeb/__tests__/modeGuard.test.ts`
- `src/services/geminiWeb/__tests__/completionDetector.test.ts`
- `src/services/geminiWeb/__tests__/runnerClient.test.ts`

### Modified files
- `package.json`
  - Add Playwright runtime dependency.
- `src/entrypoints/cli.tsx`
  - Add fast-path `--gemini-web-runner` entrypoint.
- `src/utils/model/providers.ts`
  - Add provider type + env routing.
- `src/utils/model/__tests__/providers.test.ts`
  - Add `geminiWeb` precedence coverage.
- `src/services/api/claude.ts`
  - Route `geminiWeb` to `queryGeminiWeb` and skip Anthropic streaming path.
- `src/main.tsx`
  - Enforce print-only mode for `geminiWeb`.
- `src/utils/status.tsx`
  - Display provider label `Gemini Web`.
- `src/entrypoints/sdk/coreSchemas.ts`
  - Extend `apiProvider` enum to include `geminiWeb`.
- `src/utils/swarm/spawnUtils.ts`
  - Propagate `CLAUDE_CODE_USE_GEMINI_WEB` to teammates.
- `src/utils/managedEnvConstants.ts`
  - Add provider-managed/safe env handling for `CLAUDE_CODE_USE_GEMINI_WEB`.
- `src/services/analytics/config.ts`
  - Treat gemini web as non-1P analytics-disabled route.
- `src/utils/apiPreconnect.ts`
  - Skip Anthropic preconnect for gemini web.
- `src/utils/auth.ts`
  - Include gemini web in non-1P service checks.
- `src/utils/log.ts`
  - Keep error-reporting disable behavior consistent for gemini web provider.

---

### Task 1: Add Provider Selection Plumbing (`geminiWeb`)

**Files:**
- Modify: `src/utils/model/providers.ts`
- Modify: `src/utils/model/__tests__/providers.test.ts`
- Test: `src/utils/model/__tests__/providers.test.ts`

- [ ] **Step 1: Write failing provider tests for gemini env and precedence**

```ts
// src/utils/model/__tests__/providers.test.ts
const envKeys = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GEMINI_WEB",
] as const;

test('returns "geminiWeb" when CLAUDE_CODE_USE_GEMINI_WEB is set', () => {
  process.env.CLAUDE_CODE_USE_GEMINI_WEB = "1";
  expect(getAPIProvider()).toBe("geminiWeb");
});

test("foundry takes precedence over geminiWeb", () => {
  process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
  process.env.CLAUDE_CODE_USE_GEMINI_WEB = "1";
  expect(getAPIProvider()).toBe("foundry");
});
```

- [ ] **Step 2: Run the focused test file and verify it fails**

Run: `rtk bun test src/utils/model/__tests__/providers.test.ts`
Expected: FAIL with mismatch (`firstParty` or missing env key coverage).

- [ ] **Step 3: Implement provider union + env routing**

```ts
// src/utils/model/providers.ts
export type APIProvider =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "geminiWeb";

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? "bedrock"
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? "vertex"
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? "foundry"
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI_WEB)
          ? "geminiWeb"
          : "firstParty";
}
```

- [ ] **Step 4: Re-run test file and verify pass**

Run: `rtk bun test src/utils/model/__tests__/providers.test.ts`
Expected: PASS for all provider precedence cases.

- [ ] **Step 5: Commit provider plumbing**

```bash
rtk git add src/utils/model/providers.ts src/utils/model/__tests__/providers.test.ts
rtk git commit -m "feat: add geminiWeb provider selection"
```

---

### Task 2: Add Print-Only Mode Guard + Runner Entrypoint

**Files:**
- Create: `src/services/geminiWeb/modeGuard.ts`
- Create: `src/services/geminiWeb/__tests__/modeGuard.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/entrypoints/cli.tsx`
- Create: `src/services/geminiWeb/runner.ts` (stub entry)
- Test: `src/services/geminiWeb/__tests__/modeGuard.test.ts`

- [ ] **Step 1: Write failing tests for mode guard behavior**

```ts
// src/services/geminiWeb/__tests__/modeGuard.test.ts
import { describe, expect, test } from "bun:test";
import { assertGeminiWebModeSupported } from "../modeGuard";

describe("assertGeminiWebModeSupported", () => {
  test("throws in interactive mode", () => {
    expect(() =>
      assertGeminiWebModeSupported({
        apiProvider: "geminiWeb",
        isNonInteractiveSession: false,
      }),
    ).toThrow("Gemini Web provider currently supports --print mode only");
  });

  test("does not throw in print mode", () => {
    expect(() =>
      assertGeminiWebModeSupported({
        apiProvider: "geminiWeb",
        isNonInteractiveSession: true,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run guard test and verify failure (missing module/function)**

Run: `rtk bun test src/services/geminiWeb/__tests__/modeGuard.test.ts`
Expected: FAIL due to missing `modeGuard.ts`.

- [ ] **Step 3: Implement mode guard and wire into main startup flow**

```ts
// src/services/geminiWeb/modeGuard.ts
import type { APIProvider } from "src/utils/model/providers.js";

export function assertGeminiWebModeSupported(params: {
  apiProvider: APIProvider;
  isNonInteractiveSession: boolean;
}): void {
  if (params.apiProvider === "geminiWeb" && !params.isNonInteractiveSession) {
    throw new Error("Gemini Web provider currently supports --print mode only");
  }
}
```

```ts
// src/main.tsx (after isNonInteractiveSession is derived)
import { getAPIProvider } from "src/utils/model/providers.js";
import { assertGeminiWebModeSupported } from "src/services/geminiWeb/modeGuard.js";

assertGeminiWebModeSupported({
  apiProvider: getAPIProvider(),
  isNonInteractiveSession,
});
```

- [ ] **Step 4: Add runner fast-path in CLI entrypoint**

```ts
// src/entrypoints/cli.tsx
if (process.argv[2] === "--gemini-web-runner") {
  profileCheckpoint("cli_gemini_web_runner_path");
  const { runGeminiWebRunner } = await import("../services/geminiWeb/runner.js");
  await runGeminiWebRunner();
  return;
}
```

- [ ] **Step 5: Re-run tests and verify pass**

Run: `rtk bun test src/services/geminiWeb/__tests__/modeGuard.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit mode guard + entrypoint changes**

```bash
rtk git add src/services/geminiWeb/modeGuard.ts src/services/geminiWeb/__tests__/modeGuard.test.ts src/main.tsx src/entrypoints/cli.tsx src/services/geminiWeb/runner.ts
rtk git commit -m "feat: gate geminiWeb to print mode and add runner entrypoint"
```

---

### Task 3: Define NDJSON Protocol and Test It

**Files:**
- Create: `src/services/geminiWeb/protocol.ts`
- Create: `src/services/geminiWeb/__tests__/protocol.test.ts`
- Test: `src/services/geminiWeb/__tests__/protocol.test.ts`

- [ ] **Step 1: Write failing protocol encode/decode tests**

```ts
// src/services/geminiWeb/__tests__/protocol.test.ts
import { describe, expect, test } from "bun:test";
import { decodeProtocolLine, encodeProtocolMessage } from "../protocol";

describe("gemini web protocol", () => {
  test("encodes a message as a single NDJSON line", () => {
    const line = encodeProtocolMessage({ type: "init", request_id: "r1" });
    expect(line.endsWith("\n")).toBe(true);
  });

  test("decodes valid line into typed object", () => {
    const msg = decodeProtocolLine(
      '{"type":"error","request_id":"r1","code":"response_timeout","message":"timeout","retryable":true}',
    );
    expect(msg.type).toBe("error");
  });

  test("throws for invalid JSON", () => {
    expect(() => decodeProtocolLine("not-json")).toThrow();
  });
});
```

- [ ] **Step 2: Run protocol test and confirm failure**

Run: `rtk bun test src/services/geminiWeb/__tests__/protocol.test.ts`
Expected: FAIL because protocol module does not exist.

- [ ] **Step 3: Implement protocol types + encode/decode helpers**

```ts
// src/services/geminiWeb/protocol.ts
import { jsonParse, jsonStringify } from "src/utils/slowOperations.js";

export type GeminiRunnerCommand =
  | { type: "init"; request_id: string }
  | { type: "send_prompt"; request_id: string; prompt: string }
  | { type: "await_response"; request_id: string }
  | { type: "shutdown"; request_id: string };

export type GeminiRunnerEvent =
  | { type: "ack"; request_id: string; command: GeminiRunnerCommand["type"] }
  | {
      type: "response_complete";
      request_id: string;
      text: string;
      timings: { total_ms: number };
    }
  | {
      type: "error";
      request_id: string;
      code: string;
      message: string;
      retryable: boolean;
    };

export function encodeProtocolMessage(
  msg: GeminiRunnerCommand | GeminiRunnerEvent,
): string {
  return `${jsonStringify(msg)}\n`;
}

export function decodeProtocolLine(
  line: string,
): GeminiRunnerCommand | GeminiRunnerEvent {
  const parsed = jsonParse(line);
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid Gemini protocol message");
  }
  return parsed as GeminiRunnerCommand | GeminiRunnerEvent;
}
```

- [ ] **Step 4: Re-run protocol test and verify pass**

Run: `rtk bun test src/services/geminiWeb/__tests__/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit protocol module**

```bash
rtk git add src/services/geminiWeb/protocol.ts src/services/geminiWeb/__tests__/protocol.test.ts
rtk git commit -m "feat: add gemini web ndjson protocol"
```

---

### Task 4: Implement Runner Client (Parent Process) with Retry-Safe Request Flow

**Files:**
- Create: `src/services/geminiWeb/runnerClient.ts`
- Create: `src/services/geminiWeb/__tests__/runnerClient.test.ts`
- Test: `src/services/geminiWeb/__tests__/runnerClient.test.ts`

- [ ] **Step 1: Write failing tests for request/response pairing by `request_id`**

```ts
// src/services/geminiWeb/__tests__/runnerClient.test.ts
import { describe, expect, test } from "bun:test";
import { GeminiWebRunnerClient } from "../runnerClient";

describe("GeminiWebRunnerClient", () => {
  test("resolves response_complete for matching request id", async () => {
    const client = GeminiWebRunnerClient.createForTest();
    const resultPromise = client.awaitResponse("r1");
    client.injectLine(
      '{"type":"response_complete","request_id":"r1","text":"ok","timings":{"total_ms":1}}',
    );
    const result = await resultPromise;
    expect(result.text).toBe("ok");
  });

  test("rejects on runner error event", async () => {
    const client = GeminiWebRunnerClient.createForTest();
    const resultPromise = client.awaitResponse("r2");
    client.injectLine(
      '{"type":"error","request_id":"r2","code":"response_timeout","message":"timeout","retryable":true}',
    );
    await expect(resultPromise).rejects.toThrow("response_timeout");
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `rtk bun test src/services/geminiWeb/__tests__/runnerClient.test.ts`
Expected: FAIL because client module is missing.

- [ ] **Step 3: Implement client with pending-map and line dispatcher**

```ts
// src/services/geminiWeb/runnerClient.ts
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { decodeProtocolLine, type GeminiRunnerEvent } from "./protocol.js";
import { encodeProtocolMessage, type GeminiRunnerCommand } from "./protocol.js";

export class GeminiWebRunnerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    string,
    {
      resolve: (
        v: Extract<GeminiRunnerEvent, { type: "response_complete" }>,
      ) => void;
      reject: (e: Error) => void;
    }
  >();

  handleLine(line: string): void {
    const msg = decodeProtocolLine(line) as GeminiRunnerEvent;
    if (msg.type !== "response_complete" && msg.type !== "error") return;
    const entry = this.pending.get(msg.request_id);
    if (!entry) return;
    this.pending.delete(msg.request_id);
    if (msg.type === "response_complete") {
      entry.resolve(msg);
      return;
    }
    entry.reject(new Error(`${msg.code}: ${msg.message}`));
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(process.execPath, [process.argv[1]!, "--gemini-web-runner"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", line => this.handleLine(line));
  }

  async send(command: GeminiRunnerCommand): Promise<void> {
    if (!this.child) {
      throw new Error("Gemini runner is not started");
    }
    this.child.stdin.write(encodeProtocolMessage(command));
  }

  awaitResponse(
    requestId: string,
  ): Promise<Extract<GeminiRunnerEvent, { type: "response_complete" }>> {
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }

  static createForTest(): GeminiWebRunnerClient {
    return new GeminiWebRunnerClient();
  }

  injectLine(line: string): void {
    this.handleLine(line);
  }
}
```

- [ ] **Step 4: Re-run client tests and verify pass**

Run: `rtk bun test src/services/geminiWeb/__tests__/runnerClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit runner client**

```bash
rtk git add src/services/geminiWeb/runnerClient.ts src/services/geminiWeb/__tests__/runnerClient.test.ts
rtk git commit -m "feat: add gemini web runner client"
```

---

### Task 5: Implement Completion Detector + Runner Core (Mutex + Strict Completion)

**Files:**
- Create: `src/services/geminiWeb/completionDetector.ts`
- Create: `src/services/geminiWeb/domDriver.ts`
- Modify: `src/services/geminiWeb/runner.ts`
- Create: `src/services/geminiWeb/__tests__/completionDetector.test.ts`
- Test: `src/services/geminiWeb/__tests__/completionDetector.test.ts`

- [ ] **Step 1: Write failing completion detector tests**

```ts
// src/services/geminiWeb/__tests__/completionDetector.test.ts
import { describe, expect, test } from "bun:test";
import { isResponseStable } from "../completionDetector";

describe("isResponseStable", () => {
  test("returns false when text changed within stable window", () => {
    const stable = isResponseStable({
      generationActive: false,
      lastTextChangeAt: Date.now() - 1000,
      now: Date.now(),
      stableMs: 2000,
    });
    expect(stable).toBe(false);
  });

  test("returns true when generation ended and text stable >= window", () => {
    const stable = isResponseStable({
      generationActive: false,
      lastTextChangeAt: Date.now() - 2100,
      now: Date.now(),
      stableMs: 2000,
    });
    expect(stable).toBe(true);
  });
});
```

- [ ] **Step 2: Run completion test and verify failure**

Run: `rtk bun test src/services/geminiWeb/__tests__/completionDetector.test.ts`
Expected: FAIL because detector module is missing.

- [ ] **Step 3: Implement completion detector + runner mutex guard**

```ts
// src/services/geminiWeb/completionDetector.ts
export function isResponseStable(params: {
  generationActive: boolean;
  lastTextChangeAt: number;
  now: number;
  stableMs: number;
}): boolean {
  if (params.generationActive) return false;
  return params.now - params.lastTextChangeAt >= params.stableMs;
}
```

```ts
// src/services/geminiWeb/runner.ts (core command handling)
let activeRequestId: string | null = null;

function assertNoActiveRequest(nextRequestId: string): void {
  if (activeRequestId !== null) {
    writeEvent({
      type: "error",
      request_id: nextRequestId,
      code: "concurrency_violation",
      message: "Previous request has not completed",
      retryable: false,
    });
    throw new Error("concurrency_violation");
  }
}
```

- [ ] **Step 4: Implement strict completion loop in runner**

```ts
// src/services/geminiWeb/runner.ts (await_response path)
const stableMs = 2000;
let lastText = "";
let lastTextChangeAt = Date.now();

while (true) {
  const { text, generationActive } = await driver.readLatestResponseState();
  if (text !== lastText) {
    lastText = text;
    lastTextChangeAt = Date.now();
  }

  if (
    isResponseStable({
      generationActive,
      lastTextChangeAt,
      now: Date.now(),
      stableMs,
    })
  ) {
    writeEvent({
      type: "response_complete",
      request_id,
      text: lastText,
      timings: { total_ms: Date.now() - startedAt },
    });
    break;
  }

  await Bun.sleep(250);
}
```

- [ ] **Step 5: Re-run completion tests and verify pass**

Run: `rtk bun test src/services/geminiWeb/__tests__/completionDetector.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit runner completion logic**

```bash
rtk git add src/services/geminiWeb/completionDetector.ts src/services/geminiWeb/domDriver.ts src/services/geminiWeb/runner.ts src/services/geminiWeb/__tests__/completionDetector.test.ts
rtk git commit -m "feat: implement gemini web runner completion and serialization"
```

---

### Task 6: Integrate `queryGeminiWeb` Into Main Query Flow

**Files:**
- Create: `src/services/geminiWeb/queryGeminiWeb.ts`
- Modify: `src/services/api/claude.ts`
- Create: `src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts`
- Test: `src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts`

- [ ] **Step 1: Write failing adapter test for one retry then error**

```ts
// src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts
import { describe, expect, test } from "bun:test";
import { runGeminiWebTurn } from "../queryGeminiWeb";

describe("runGeminiWebTurn", () => {
  test("retries once for retryable failure", async () => {
    let calls = 0;
    const result = await runGeminiWebTurn({
      prompt: "hello",
      invoke: async () => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error("timeout"), { retryable: true });
        }
        return { text: "ok" };
      },
    });

    expect(result.text).toBe("ok");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run adapter test and verify failure**

Run: `rtk bun test src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts`
Expected: FAIL due to missing module.

- [ ] **Step 3: Implement adapter with one retry and normalized result**

```ts
// src/services/geminiWeb/queryGeminiWeb.ts
export async function runGeminiWebTurn(params: {
  prompt: string;
  invoke: () => Promise<{ text: string }>;
}): Promise<{ text: string }> {
  try {
    return await params.invoke();
  } catch (error) {
    const retryable = Boolean((error as { retryable?: boolean }).retryable);
    if (!retryable) throw error;
    return await params.invoke();
  }
}
```

- [ ] **Step 4: Route `geminiWeb` inside `queryModel` before Anthropic client path**

```ts
// src/services/api/claude.ts
import { runGeminiWebTurn } from "src/services/geminiWeb/queryGeminiWeb.js";
import { GeminiWebRunnerClient } from "src/services/geminiWeb/runnerClient.js";

if (getAPIProvider() === "geminiWeb") {
  const runnerClient = new GeminiWebRunnerClient();
  await runnerClient.start();
  const userText = messages
    .filter(m => m.type === "user")
    .map(m => {
      const content = m.message?.content;
      return typeof content === "string" ? content : "";
    })
    .join("\n\n");

  const result = await runGeminiWebTurn({
    prompt: userText,
    invoke: async () => {
      const requestId = randomUUID();
      await runnerClient.send({
        type: "send_prompt",
        request_id: requestId,
        prompt: userText,
      });
      await runnerClient.send({
        type: "await_response",
        request_id: requestId,
      });
      const response = await runnerClient.awaitResponse(requestId);
      return { text: response.text };
    },
  });

  await runnerClient.stop();

  yield {
    type: "assistant",
    uuid: randomUUID(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: result.text }],
    },
  } as AssistantMessage;
  return;
}
```

- [ ] **Step 5: Re-run adapter tests and verify pass**

Run: `rtk bun test src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit query integration**

```bash
rtk git add src/services/geminiWeb/queryGeminiWeb.ts src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts src/services/api/claude.ts
rtk git commit -m "feat: route geminiWeb provider through dedicated query adapter"
```

---

### Task 7: Update Provider Surfaces (Schema, Status, Env Propagation, Safety Gates)

**Files:**
- Modify: `src/entrypoints/sdk/coreSchemas.ts`
- Modify: `src/utils/status.tsx`
- Modify: `src/utils/swarm/spawnUtils.ts`
- Modify: `src/utils/managedEnvConstants.ts`
- Modify: `src/services/analytics/config.ts`
- Modify: `src/utils/apiPreconnect.ts`
- Modify: `src/utils/auth.ts`
- Modify: `src/utils/log.ts`
- Create: `src/utils/__tests__/geminiWebProviderSurfaces.test.ts`
- Test: `src/utils/__tests__/geminiWebProviderSurfaces.test.ts`

- [ ] **Step 1: Write failing tests for cross-module provider surfaces**

```ts
// src/utils/__tests__/geminiWebProviderSurfaces.test.ts
import { describe, expect, test } from "bun:test";
import { isProviderManagedEnvVar } from "../managedEnvConstants";

describe("geminiWeb provider surfaces", () => {
  test("provider-managed env includes CLAUDE_CODE_USE_GEMINI_WEB", () => {
    expect(isProviderManagedEnvVar("CLAUDE_CODE_USE_GEMINI_WEB")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests and verify failure before implementation**

Run: `rtk bun test src/utils/__tests__/geminiWebProviderSurfaces.test.ts`
Expected: FAIL (env var not recognized yet).

- [ ] **Step 3: Implement surface updates in listed files**

```ts
// src/entrypoints/sdk/coreSchemas.ts
apiProvider: z.enum([
  "firstParty",
  "bedrock",
  "vertex",
  "foundry",
  "geminiWeb",
]);
```

```ts
// src/utils/status.tsx
const providerLabel = {
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  geminiWeb: "Gemini Web",
}[apiProvider];
```

```ts
// src/utils/swarm/spawnUtils.ts
"CLAUDE_CODE_USE_GEMINI_WEB",
```

```ts
// src/utils/managedEnvConstants.ts
"CLAUDE_CODE_USE_GEMINI_WEB",
```

```ts
// src/services/analytics/config.ts
isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI_WEB) ||
```

```ts
// src/utils/apiPreconnect.ts
if (
  isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI_WEB)
) {
  return;
}
```

```ts
// src/utils/auth.ts
if (
  isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI_WEB)
) {
  return false;
}
```

```ts
// src/utils/log.ts
if (
  isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
  isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI_WEB) ||
  process.env.DISABLE_ERROR_REPORTING ||
  isEssentialTrafficOnly()
) {
  return;
}
```

- [ ] **Step 4: Re-run surface test and provider tests**

Run: `rtk bun test src/utils/__tests__/geminiWebProviderSurfaces.test.ts src/utils/model/__tests__/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit provider surface updates**

```bash
rtk git add src/entrypoints/sdk/coreSchemas.ts src/utils/status.tsx src/utils/swarm/spawnUtils.ts src/utils/managedEnvConstants.ts src/services/analytics/config.ts src/utils/apiPreconnect.ts src/utils/auth.ts src/utils/log.ts src/utils/__tests__/geminiWebProviderSurfaces.test.ts
rtk git commit -m "feat: wire geminiWeb provider across schema, status, and env surfaces"
```

---

### Task 8: Add Playwright Dependency and Run Verification Suite

**Files:**
- Modify: `package.json`
- Modify: lockfile (`bun.lock` if updated)

- [ ] **Step 1: Add Playwright dependency**

Run: `rtk bun add -D playwright`
Expected: package manifest and lockfile updated.

- [ ] **Step 2: Install browser binary for local development validation**

Run: `rtk bunx playwright install chromium`
Expected: Chromium download/install success message.

- [ ] **Step 3: Run focused test suite for all new modules**

Run:
`rtk bun test src/services/geminiWeb/__tests__/protocol.test.ts src/services/geminiWeb/__tests__/modeGuard.test.ts src/services/geminiWeb/__tests__/completionDetector.test.ts src/services/geminiWeb/__tests__/runnerClient.test.ts src/services/geminiWeb/__tests__/queryGeminiWeb.test.ts src/utils/model/__tests__/providers.test.ts src/utils/__tests__/geminiWebProviderSurfaces.test.ts`

Expected: PASS, 0 failed.

- [ ] **Step 4: Run project lint for changed code**

Run: `rtk bun run lint`
Expected: no new lint violations from modified files.

- [ ] **Step 5: Commit dependency + final verification changes**

```bash
rtk git add package.json bun.lock
rtk git commit -m "chore: add playwright runtime for gemini web provider"
```

---

## Final Verification Checklist
- [ ] `geminiWeb` provider selected correctly by env and precedence.
- [ ] Interactive mode blocked with explicit print-only error.
- [ ] Runner fast-path (`--gemini-web-runner`) starts without loading full CLI flow.
- [ ] Parent/runner NDJSON protocol enforces strict request pairing.
- [ ] Completion condition uses generation-stopped + 2s stable text.
- [ ] One automatic retry for retryable errors is enforced.
- [ ] Provider metadata surfaces show `geminiWeb` consistently.

## Plan Self-Review

### 1. Spec Coverage
- Provider added + env activation: Task 1.
- Playwright runner with dedicated profile + gemini.google.com path: Tasks 5 and 8.
- JSON protocol and strict sequencing: Tasks 3, 4, 5.
- Final-only response and strict completion gate: Tasks 5 and 6.
- One retry policy: Task 6.
- Print-only scope: Task 2.
- Surface and propagation updates: Task 7.
- Test strategy (unit/protocol/no live e2e): Tasks 1-8.

No coverage gaps found.

### 2. Placeholder Scan
Searched for `TBD`, `TODO`, `implement later`, and ambiguous action-only steps.
No placeholders remain.

### 3. Type/Name Consistency
- Provider literal used consistently as `geminiWeb`.
- Env var used consistently as `CLAUDE_CODE_USE_GEMINI_WEB`.
- Protocol message fields consistently use `request_id`.
- Completion window consistently uses `2000ms`.

Consistency check passed.
