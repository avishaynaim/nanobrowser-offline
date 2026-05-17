# Nanobrowser — Offline Setup Guide

Nanobrowser v0.1.13, patched for offline / local-model use.

## What was changed from the original

Passed a 20-aspect offline audit. All automatic external fetches eliminated.

| # | Issue | Fix |
|---|---|---|
| 1 | PostHog hardcoded key (`phc_Y0gG…`) → called `app.posthog.com` on startup | Key cleared to `""` |
| 2 | `posthog.init()` still ran even with empty key (bundler dropped the `return`) | Restored `return;` before init |
| 3 | tiktoken vocabulary fetched from `tiktoken.pages.dev` CDN on every token count | Replaced fetch with `Promise.reject()` → falls back to approximate count |
| 4 | `refresh.js` content script → tried `ws://localhost:8081` on every page load | Removed from `content_scripts` in manifest |
| 5 | `chrome.sidePanel.setPanelBehavior()` crashes on Chrome/Edge < 114 | Added optional-chaining guard |
| 6 | No UI entry point on older Chrome (no popup defined) | Added `popup.html` fallback |

**Verified safe (never auto-fetched):**
- LangSmith tracing — gated by `process.env` (undefined in browser service worker → always off)
- All provider APIs (OpenAI, Anthropic, Gemini, etc.) — only called if user configures that provider
- No external CSS fonts, no CDN `<script>` or `<link>` tags in any HTML file
- No `XMLHttpRequest`, no `WebSocket`, no `sendBeacon` paths reachable after the PostHog patch
- UI links (Discord, GitHub, HuggingFace) — clickable only, never auto-fetched

**Only network traffic produced:** calls to your configured local model endpoint.

## Install in Chrome / Edge (offline)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the folder: `/root/browser-ai-extension`
5. The extension appears — click its icon in the toolbar

## Configure your local model

1. Click the extension icon → **Settings / Add Model**
2. In the **Model Settings** tab → **Add Provider** → choose **Custom OpenAI**
3. Set:
   - **Base URL**: your local API endpoint, e.g. `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio)
   - **API Key**: leave blank or set `ollama` / any string (local models ignore it)
   - **Model name**: add your model name (e.g. `qwen2.5-coder:14b`, `mistral`, `llama3`)
4. Save, then go to the **Agent Models** section and assign your provider to both **Planner** and **Navigator**

## Chrome / Edge version requirements

| Feature | Minimum version |
|---|---|
| Manifest V3 (extension works at all) | Chrome/Edge 88 |
| Side Panel UI | Chrome/Edge 114 |
| Extension action popup (fallback) | Chrome/Edge 88 |

If you have Chrome/Edge < 114: the side panel won't open, but you can still access Settings via the popup.

## How to use

1. Open any webpage
2. Click the extension icon → **Open Side Panel** (or pin the side panel from the panel itself)
3. Type a task in natural language, e.g.:
   - "Fill in the login form with user: test@test.com"
   - "Scroll down and summarize this page"
   - "Click the Submit button"
4. The AI agent (Planner + Navigator) will automate the browser

## Firewall (block accidental external calls)

In Settings → **Firewall**, you can add a deny-list to block any domains you don't want the agent to visit.
