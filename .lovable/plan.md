# Fix the Claude connection so the prompt box works again

Two separate problems are stacked on top of each other.

## 1. "Failed to fetch"

The chat box does not talk to this app at all. It posts to an external Cloudflare Worker URL (`poly-view-pulse-api...workers.dev/api/chat`) that is separate from the site. When that worker is unreachable, sleeping, or blocked by CORS, the browser reports "Failed to fetch" — no matter what the prompt says.

Fix: point the chat box back at this app's own `/api/chat` endpoint (same origin, no CORS, always deployed with the site). The external worker URL stays available only as an explicit override, so nothing breaks if you later want to use it again.

## 2. "anthropic-workspace-id is required..."

Your Anthropic key is an identity-linked key. Anthropic requires every request made with that kind of key to also name the workspace it acts in, via an `anthropic-workspace-id` header. The app currently sends only the key, so Anthropic rejects the request and the error surfaces in chat.

Fix: store the workspace id as a project secret (`ANTHROPIC_WORKSPACE_ID`) and send it as a header on every Claude call. If the secret is absent the app behaves exactly as today, so a plain (non-identity-linked) key keeps working too.

You can find the id in the Anthropic Console: switch to the workspace, and the URL contains `wrkspc_...` — that is the value. Alternatively, create a plain workspace API key instead and no id is needed; tell me which you prefer.

## 3. Clearer failure messages

Add a case for this class of error so the chat says "Anthropic needs the workspace id for this key" instead of a raw API message, alongside the existing 401/402/429 handling.

## Technical details

- `src/routes/index.tsx`: default the chat endpoint to `/api/chat`; keep `VITE_CHAT_API_URL` as an override.
- `src/routes/api/chat.ts`: pass `headers: { "anthropic-workspace-id": process.env["ANTHROPIC_WORKSPACE_ID"] }` into `createAnthropic` when set; extend the `onError` mapping for the workspace-id error.
- `worker/index.ts`: same header wiring from `env.ANTHROPIC_WORKSPACE_ID`, so the standalone worker path stays usable.
- Verify with a real POST to `/api/chat` in the running app and read the streamed response — no prompt/tool behaviour changes otherwise.
