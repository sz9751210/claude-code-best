# Web Gemini 使用說明

這份文件說明如何在本專案中使用 Web Gemini（Playwright 驅動）作為模型提供者。

## 1. 功能概述

- Provider 切換：`CLAUDE_CODE_USE_GEMINI_WEB=1`
- 執行方式：透過 Playwright 開啟 `https://gemini.google.com/app`，由 runner 送出 prompt 並等待回覆完成
- 可在互動式 REPL 與非互動 `--print`（即 `-p`）流程中使用

## 2. 前置條件

1. 已安裝依賴：`bun install`
2. 可以存取 Google Gemini 網頁
3. 需要一個可重用的瀏覽器 profile 目錄（保存登入狀態）

## 3. 快速開始

### 互動式開發模式

```bash
CLAUDE_CODE_USE_GEMINI_WEB=1 \
GEMINI_WEB_HEADLESS=0 \
GEMINI_WEB_PROFILE_DIR=~/.claude-code-haha/gemini-web-profile \
bun run dev
```

- 這會啟動互動式 REPL，適合在終端直接和 Gemini Web 對話。
- 首次使用時會開啟瀏覽器，請完成 Google/Gemini 登入。
- 登入成功後，profile 目錄會保留 session。

### 非互動式首次使用（建議 headful 登入）

```bash
CLAUDE_CODE_USE_GEMINI_WEB=1 \
GEMINI_WEB_HEADLESS=0 \
GEMINI_WEB_PROFILE_DIR=~/.claude-code-haha/gemini-web-profile \
bun run scripts/dev.ts -p "請簡短回覆：GEMINI_WEB_READY"
```

- 首次會開啟瀏覽器，請完成 Google/Gemini 登入。
- 登入成功後，profile 目錄會保留 session。

### 後續使用（可改 headless）

```bash
CLAUDE_CODE_USE_GEMINI_WEB=1 \
GEMINI_WEB_HEADLESS=1 \
GEMINI_WEB_PROFILE_DIR=~/.claude-code-haha/gemini-web-profile \
bun run scripts/dev.ts -p "請簡短回覆：GEMINI_WEB_OK"
```

## 4. 重要環境變數

- `CLAUDE_CODE_USE_GEMINI_WEB`：`1` 時啟用 Web Gemini provider
- `GEMINI_WEB_PROFILE_DIR`：Playwright persistent profile 路徑  
  預設：`~/.claude-code-haha/gemini-web-profile`
- `GEMINI_WEB_HEADLESS`：`1/true` 無頭，`0/false` 有頭（預設無頭）
- `GEMINI_WEB_RESPONSE_TIMEOUT_MS`：等待回覆超時（預設 `180000`）
- `GEMINI_WEB_RESPONSE_POLL_MS`：輪詢間隔（預設 `250`）
- `GEMINI_WEB_RESPONSE_STABLE_MS`：回覆穩定判定窗口（預設 `2000`）

## 5. 請求序列與通訊

Runner 使用 NDJSON 指令/事件通訊，單請求標準流程如下：

1. `send_prompt`
2. `await_response`
3. 等待 `response_complete`
4. 才允許下一筆請求

如果上一筆尚未完成就送新請求，runner 會回 `concurrency_violation`。  
這可避免在 Gemini 還在生成時被後續訊息打斷。

## 6. 與 API Key 路徑相容

- 啟用 `CLAUDE_CODE_USE_GEMINI_WEB=1` 時，provider 會切到 `geminiWeb`
- 關閉時，回到原本 `firstParty`（沿用既有 API key/OAuth 行為）

範例（同一組 `ANTHROPIC_API_KEY`，透過 env 切換 provider）：

```bash
# 走 geminiWeb
CLAUDE_CODE_USE_GEMINI_WEB=1 ANTHROPIC_API_KEY=sk-invalid-test bun run scripts/dev.ts -p "Reply with GEMINI_PATH"

# 走 firstParty
CLAUDE_CODE_USE_GEMINI_WEB=0 ANTHROPIC_API_KEY=sk-invalid-test bun run scripts/dev.ts -p "Reply with API_KEY_PATH"
```

## 7. 常見問題

- 一直找不到輸入框或送出按鈕  
  - 先用 `GEMINI_WEB_HEADLESS=0` 觀察頁面狀態  
  - 確認已登入且頁面沒有額外驗證流程
- 回覆超時  
  - 提高 `GEMINI_WEB_RESPONSE_TIMEOUT_MS`（例如 `240000`）
