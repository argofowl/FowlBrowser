# Agent cursor (spec)

Shows the user where an agent acts and what it is doing, only in a tab they can see: a rounded pointer in the
session's colour with a name label, drawn inside the page. Its curved, Fitts-timed travel follows Cua's
`signature_arc` motion (MIT, github.com/trycua/cua); the look is FowlBrowser's own.

## Where and when
- Only in a tab the user can see: the active tab of a normal, app or popup window that is not minimized (`tabs.isShown {tabId}` -> `{shown}`,
  owner only; a slow answer counts as not shown). Not shown: no injection, no waiting, zero cost.
- Every agent action in that tab shows it, not only pointer actions:
  | Tool | Cursor |
  |---|---|
  | click, select_option | travels to the element (or x,y), then press and ring |
  | hover | travels there |
  | type, fill_form (text fields) | travels to the field, "Typing" while it types; without ref, at the last point |
  | fill_form (checks, selects) | travels there, click feedback |
  | press_key | "Pressing keys" (with ref: travels there first) |
  | scroll | travels to the scrolled point (viewport centre, or the element after it scrolled into view), "Scrolling" |
  | drag | travels to the source, "Dragging" on the way to the target |
  | upload_files | travels to the element, "Uploading" |
  | download with ref | as click (it clicks the element) |
  | navigate | "Loading" on the new page once it loaded |
  | snapshot, wait_for, media, export | "Reading" at the last point while it runs |
  | evaluate | "Reading" while it runs; clicks the script makes (`el.click()`, untrusted events) are shown as travel to the clicked element and a click |
  | screenshot | hidden during the capture, "Reading" after it |
- Only the top frame. Agent-opened and claimed tabs alike, while the session controls the tab.
- Injected by the MCP server through the tab's debugger session into an isolated world
  (`Page.createIsolatedWorld` on the main frame, world `fowlbrowser-cursor`, then `Runtime.evaluate` of
  `mcp/src/cursor/overlay.js`). No extension permissions, invisible to page scripts except the host element.
  Re-injected per document (the tab's document generation). Prepared ahead: when a tab comes under control and when
  its main frame commits a new document, the world is made in the background (only where the cursor would show), so
  the first action on a page finds it ready; the host element itself appears with the first action.
- Host: `<fowlbrowser-cursor aria-hidden="true">` on `document.documentElement`, closed shadow root, fixed, inset 0,
  `pointer-events:none`, `z-index:2147483647`, `contain:strict`, hidden in print, and in the top layer as a manual popover
  (above modal dialogs, popovers, fullscreen elements and transformed pages; re-raised on the next move when one opened
  after it).
  Re-attached if the page removes it or replaces its document element. Built with DOM calls and constructed stylesheets
  only: pages with Trusted Types (YouTube, GitHub) refuse HTML strings and a CSP style-src can block `<style>`.
- Hidden for agent screenshots (`display:none` during the capture).
- Fades out 15 s after the last action (an action still running, like a long wait_for, keeps it,
  up to 2 minutes), when the tab is released or closed, and when the session ends. A page entering the back/forward
  cache drops it.
- Targets and the restored point are kept 2 px inside the viewport. In a hidden document (no frames) it goes straight
  to the target; a move whose frames stop (window covered, another Space) still ends on time. Click feedback goes to the
  clicked point (the cursor jumps there if a slow lookup left it more than 12 px away); a target found after the cursor
  budget is shown at once (no travel) while the action still runs, and not at all once it is done.

## Look
- Pointer: a rounded arrow pointing up and a little left, drawn in a 24-unit box and shown at 1.2 CSS px per unit
  (about 14 x 20 px): corners rounded 2.2 units at the tip and the notch, 3.4 at the other two. Hotspot = the apex of
  the rounded tip, so it sits exactly on the point.
- Fill: the session's colour: blue `#0a84ff` for the default label "Claude"; other labels hash (FNV-1a) into orange
  `#ff9f0a`, green `#30d158`, purple `#bf5af2`, pink `#ff375f`, teal `#40c8e0`, indigo `#5e5ce6`, red `#ff453a`,
  brown `#ac8e68`, so parallel sessions are told apart. White rim 1.7 px, an ink hairline (`#131110`, 30%) at the
  edge, and a soft drop shadow (0 1px 1.2px, 32% black).
- Label: a flat pill in the same colour, 17 px tall, 10.5 px semibold system font, white text (ink on light fills,
  relative luminance over 0.4), a 1.5 px white ring and a small shadow; 16 px right of and 24 px below the tip. Where
  that doesn't fit, beside the arrow at the tip's height (right, else left; for a turned arrow, the side away from its
  body), always inside the viewport; moving to another side it glides there (180 ms; during a travel toward where that
  side is as the arrow moves on, and a side change while it glides doesn't start it over). Max 200 px with ellipsis.
- Size on screen: the same at any browser zoom. The server reads the site's zoom (`Page.getLayoutMetrics`
  `cssVisualViewport.zoom`, at most every 2 s per tab, alongside the target lookup) and passes it with each move and
  cue (a cue's end waits for its cue); on an
  unpinched page the overlay draws by its inverse (at 80% the cursor is 1.25 times as many CSS px). A pinched or
  zoomed-out mobile page is drawn by its page scale instead, as before.
- Edges: the arrow's body runs down and to the right of its tip (about 16 x 22 px with rim and shadow). Where the window's
  bottom or right edge would cut it off (a chat box at the foot of a page, a button in a corner), it rests turned around
  its tip, the first that fits of a quarter turn left (body up and right), a quarter turn right (body down and left) and
  a half turn, so all of it shows and it still points at the target. It turns as it travels into such a spot (with the
  lean's smoothing) and when a resize changes what fits (a window made narrower than where it rests brings it back
  inside, 2 px from the edge); with reduced motion it is set at once. A jump (a click far from where it was) takes the
  label along at once, at its new width, without a glide.
- Action words: what the agent is doing takes the name's place in the pill ("Claude" becomes "Typing", then "Claude"
  again): Reading, Scrolling, Typing, Dragging and Uploading stay while the action runs (at least 0.9 s); Pressing keys
  and Loading show for 1.2 s. An action word is drawn at 60% with a light sweeping over it as it arrives and every
  1.8 s while the action lasts.

## Motion
- Travel (after Cua's `signature_arc`): a cubic Bezier from the current tip to the target, handles 0.3 of the distance at each
  end, bent 0.16 of the distance to the natural side (upward for horizontal moves), bend peak shifted 0.15 toward the
  end; walked by arc length with a minimum-jerk profile plus a follow-through bump peaking at 82% of the move
  (0.018 of the distance, at most 6 px). Duration: Fitts, `(150 + 120 log2(D / W + 1))` ms clamped to 300..1000,
  times 0.9, at most 850 ms; W is the target's smaller side (24 px for a bare point). Short hops are quicker:
  never longer than `140 + 1.6 D` ms (about 160 ms at 10 px, 220 ms at 50 px; Fitts' alone from about 220 px). Never longer than
  the time left before the action (Agent timing): a quicker travel when less is left, and with under 120 ms left
  the cursor goes straight to the target (appearing there on a fresh page).
- Arrival (the action may start) when the tip is within 1 px of the target; the follow-through finishes during
  the action. A new target mid-flight plans a new arc from the current tip.
- Land, just before the action: unless the tip is within 2 px of the target and fully opaque, the travel and the
  appear (or exit) fade are cut short and the tip is put on the target at full opacity at once. A busy page (no
  frames for the travel or the fade) still shows the cursor on the target when the action fires.
- Lean: the pointer leans into the direction of travel, at most 0.5 rad, weighted by speed ((v - 40) / 260, clamped
  0..1) and smoothed with `1 - exp(-22 dt)`; it settles back after the move. The label stays upright.
- Click: the pointer presses to 0.86 around its tip (`cubic-bezier(0.23, 1, 0.32, 1)`) and springs back
  (`cubic-bezier(0.34, 1.56, 0.64, 1)`), 220 ms; a press that interrupts the last one starts from its current scale. A
  ring of the session's colour (a circle drawn at 22 px radius with a 2 px border, scaled down, so it stays sharp)
  grows from the tip by transform (scale 0.3 -> 1) over 420 ms while it fades (opacity 0.85 -> 0.55 at 80% -> 0),
  both on `cubic-bezier(0.33, 1, 0.68, 1)`.
- Word change (name to action word, one word to the next, back to the name), about 300 ms in all, a morph by letters:
  letters both words share (in order, longest common subsequence: "Claude" and "Reading" share "a" and "d", "Reading"
  and "Typing" share "ing") slide to their new places over 280 ms (`cubic-bezier(0.77, 0, 0.175, 1)`) and take the next
  word's strength over 140 ms; the other letters of the word going rise 3 px, shrink to 0.92 and fade over 120 ms, 10 ms
  apart from the left; the next word's letters come up from 3 px below and 0.92 over 200 ms, 12 ms apart, from 60 ms;
  `cubic-bezier(0.23, 1, 0.32, 1)` where not said. Text too wide for the pill changes as one piece the same way. The
  pill glides to its new width over 280 ms on the same curve as the shared letters (against the viewport's right edge
  the label glides along, so it stays inside). A word that goes takes its light's animations with it, and so does the
  cursor. An interrupted change goes on from where every letter is. A cursor that has just appeared (under 120 ms)
  shows its first word without a change. The light on an action word: a soft-edged band (60% of the word's width, at
  least 24 px) holding a full-strength copy of the word crosses it in 1.1 s (`cubic-bezier(0.45, 0, 0.55, 1)`),
  starting as the word has arrived (280 ms), then again every 1.8 s.
- Compositor only: the word change, the light, the pill's glide, appear and exit, press and ring animate transform,
  opacity and clip-path, which Chrome runs off the page's main thread, so a page busy with the agent's action (a
  snapshot of a big page) can't stall them. No blur and no width animation. The pill is drawn as two pieces for this:
  a long piece cut off (clip-path) at the centre of its round right end, and the round end, which slides; white rims
  under both fills and one drop shadow over the whole.
- Appear: at the last point, else where the server last had it, else 58% x / 55% y of the viewport; opacity 0 -> 1 and
  scale 0.85 -> 1 around the tip, 220 ms `cubic-bezier(0.23, 1, 0.32, 1)`. Exit: opacity -> 0, scale -> 0.9, 200 ms.
- No frame loop: all motion is WAAPI, the travel too, so Chrome plays it on the compositor and a busy page's main
  thread can't stall it. When a move is planned, its path, lean, edge turn and label side are sampled every 60th of a
  second (on until the lean has settled) and played as linear keyframes of `transform` on the pointer, the arrow and
  the label (a label that never moves gets none), started on the clock the overlay reads; at their end the last values
  go to the inline styles. While they play, the tip the overlay reports (`state()`, a click, a new move's start and
  lean) is read from the same samples at the current time, and arrival is the first sample within 1 px of the target.
  A turn at rest (a resize) is a rotation animation with the lean's smoothing. Planning reads no layout: the
  viewport's size and page scale are kept until a window or visual viewport resize or scroll, and a word is measured
  only when it changes.
- Reduced motion: no travel (120 ms crossfade to the target, the old point fading from the cursor's current opacity),
  no press or ring; appear and exit by opacity only; words change by a 120 ms crossfade (no letters moving, no glide) and
  action words show at full strength without the light. The preference turning on while the cursor shows puts a
  travel under way on its target (crossfade), ends an appear or exit at once and draws the word again without its
  light; turning off brings the light back.

## Agent timing
- Pointer actions wait for arrival, capped at 900 ms for the whole cursor path (visibility, target box, travel), then
  act. The overlay's world is made while the target box is looked up, and the move tells the overlay the wall-clock
  time it must arrive by (60 ms before the cap, so its reply is back in time); the travel fits into that.
- Then one land call (overlay `land`, capped at 150 ms): the page's main thread runs it before it handles the
  action's input events, so the tip and the action paint together.
- Target box of a main-frame ref: one page-side evaluate on the locator (Chromium's `scrollIntoViewIfNeeded`, the
  alignment the action's own scroll uses, then `getBoundingClientRect`), allowed as long as the action (a page whose
  thread stalls past the budget holds the action up too: its target lands late, and the click shows there). Iframe refs use Playwright's scroll and
  `boundingBox` (frame offsets); closed-shadow (s) refs the debugger's box model.
- Late target: a lookup that ends after the budget while the action is still running lands the cursor there at once
  (appears at the target, no travel). Record mode: the point line keeps the state from before the action, plus
  `late: true`.
- Cues during an action (Reading, Scrolling, Typing, Pressing keys, Dragging, Uploading) are painted before it starts:
  the overlay's `cue` answers two frames after the call (at most 100 ms), and the action waits for that answer, at
  most 120 ms from when it would have started (the visibility answer, the overlay's injection and the zoom read
  included). An action that keeps the page's main thread busy (a snapshot of a big page) holds back every frame until
  it is done, so a word not painted before it would first show after it. A pointer action waits after its land, a
  drag with refs not at all (its word comes with the press). Cues after an action (Loading, Reading after a
  screenshot) don't wait, nor does a tab that wasn't shown when last asked (it starts at once; its word still shows
  if the tab is shown by the time the answer comes). Any cursor failure is logged (debug) and
  never fails or delays an action beyond the caps.
