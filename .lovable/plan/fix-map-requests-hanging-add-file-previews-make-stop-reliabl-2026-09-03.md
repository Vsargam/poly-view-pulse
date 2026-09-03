# Fix map requests hanging, add file previews, make Stop reliable

Three separate issues. One of them needs a reproduction step before the fix is chosen; the other two are straightforward.

## 1. Map / visualization requests that load forever

What I confirmed by reading the code: the map atlases are small local files (112 KB states, 823 KB counties, 106 KB world), so the geography data itself is not the bottleneck. What is not yet confirmed is where the request actually stalls, so guessing a cause would be wrong.

Likely candidates, in the order they will be checked:
- The assistant enters a repeated tool-call loop (aggregate → aggregate → …) and never produces a final answer, so the "Thinking…" state never ends.
- A heavy client-side analysis step runs on the main thread and freezes the page (this would also explain the Stop button doing nothing, see item 3).
- The map atlas load has no error or timeout handling: if the fetch of the geography data fails, the component sits on a blank loading state forever with no message.

Work:
- Reproduce a "US map by region" prompt end to end against the running app and capture the chat request/response and the console, to identify which of the above it is.
- Fix the confirmed cause.
- Regardless of cause, add safety nets so a stall is never silent and never permanent:
  - Cap the assistant's tool-call rounds and force a written answer when the cap is hit.
  - Add a visible elapsed-time indicator while generating, and a hard timeout that surfaces a plain-language message plus a Retry.
  - Give the map component explicit loading / failed states with a readable message instead of an endless blank panel.
  - Move the map geography load off the render-blocking path so a slow map never blocks the rest of the answer.

## 2. Preview of generated / combined files

Today a merged, joined, split, or tool-generated file only gets a Download button, so the only way to see it is to download it.

Work:
- Add an expandable inline preview to each file card: click the file name (or a "Preview" control) to open the first ~10 rows in a compact scrollable table, with column headers and a row/column count.
- Show the same preview inline in the chat whenever a tool creates a new file, right next to the download link, so combining or splitting files immediately shows a sample of the result.
- Keep the Download button unchanged for the full file.
- Previews come from the rows already held in the session — no re-upload, no extra request.

## 3. Stop button that does nothing

Work:
- Make Stop cancel the whole in-flight turn, not just the network stream: abort the request, cancel any pending client-side analysis step, and prevent the automatic follow-up request that currently fires after a tool result finishes.
- Give the button immediate feedback: it switches to a stopped state on the first press and the "Thinking…" indicator disappears at once instead of lingering.
- Keep the partial answer already on screen, so stopping never blanks the response.
- If a long analysis step is what freezes the page, move that work so the UI stays responsive and the button can be clicked.

## Technical notes

- Files touched: `src/routes/index.tsx` (turn lifecycle, abort handling, automatic follow-up gate), `src/components/DatasetCard.tsx` (expandable preview), `src/components/AssistantAnswer.tsx` (inline generated-file preview), `src/components/MapBlock.tsx` (atlas load states, deferred load), `src/routes/api/chat.ts` (tool-round cap, forced final answer).
- New small component for the row preview table, reused by the file card and the chat answer.
- Verification: a Playwright run that uploads sample files, requests a US-state map, requests a merge, previews the generated file, and presses Stop mid-response.
