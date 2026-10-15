// FowlBrowser agent cursor: evaluated by the MCP server in the isolated world "fowlbrowser-cursor" of a tab's top
// frame (see docs/cursor-spec.md). Defines globalThis.__fbCursor once per document:
//   move(x, y, opts) -> Promise<arrived>   opts { label, from, w, h, until }: from is the last point the server knows
//                                           (for a fresh document), w,h the target's box (bigger targets are quicker),
//                                           until the wall-clock ms by which it must arrive
//   land(x, y, opts) -> changed             the tip on (x, y) at full opacity at once (travel and appear fade cut short)
//   cue(kind, opts) -> Promise<shown> / cueEnd()   the action as a word in place of the label: observe, scroll, text, key,
//                                          navigate, drag, transfer ("Claude" morphs into "Typing" and back)
//   click()                                press and ring at the current point
//   follow(on, record)                     while on, travels to and clicks on clicks a script makes (an agent's evaluate);
//                                          record: also keep them for drainClicks
//   hide()                                 exit animation, then the host is removed; resolves when gone
//   capture(on)                            display:none while the agent takes a screenshot
//   state() / drainClicks()                record mode: what a viewer sees now; script clicks shown since the last drain
// No dependencies and no frame loop: all motion is WAAPI, the travel too (worked out ahead, so the compositor plays it).
(() => {
  if (globalThis.__fbCursor) return;

  // FowlBrowser's pointer: a rounded arrow filled with the session's colour, a white rim and a soft shadow. Drawn in
  // a 24-unit box with the tip's corner at 0,0 and shown at SCALE px per unit; TIP is the rounded tip's apex, which
  // sits on the target point.
  const POINTER = 'M1.52 1.59Q0 0 0 2.2L0 13.6Q0 17 2.76 15.01L3.21 14.69Q5 13.4 7.19 13.15L8.62 12.99Q12 12.6 9.66 10.14Z';
  const SCALE = 1.2;
  const TIP = { x: 0.38, y: 0.95 };
  const BLUE = [10, 132, 255];
  const PALETTE = [[255, 159, 10], [48, 209, 88], [191, 90, 242], [255, 55, 95], [64, 200, 224], [94, 92, 230],
    [255, 69, 58], [172, 142, 104]];
  const CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const IDLE_MS = 15_000; // the cursor fades this long after the last action
  const TIMING = 0.9; // Fitts' law durations, a little quick: agents wait for arrival
  const MAX_MOVE_MS = 850;
  const SHORT_MS = 140; // a move's time grows from this by 1.6 ms a px while that is quicker than Fitts' (under ~220 px)
  const MIN_MOVE_MS = 120; // less time left than this before the action: the cursor appears at the target
  const TIP_ANGLE = -0.63 * Math.PI; // where the tip points at rest (up and a little to the left)
  const LEAN = 0.5; // at most this far (radians) the tip leans into the direction of travel
  const BADGE = { x: 12 * SCALE + 2, y: 18 * SCALE + 2 }; // the label, from the tip
  const PAD = 7; // the label's text inset
  const MAX_PILL = 200;
  const RING_R = 22; // the click ring's radius when it has spread
  const WORD_MS = 180; // the label gliding to another side of the arrow
  const MORPH_MS = 280; // a word change: letters both words share slide over, the pill glides to its width
  const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)'; // for what moves on screen (shared letters, the pill's end)
  const DIM = 0.6; // an action word at rest; the light sweeping over it is full strength
  const SHIMMER_MS = 1100; // one pass of the light over an action word
  const SHIMMER_EVERY_MS = 1800; // and the next pass this long after the last one began
  const MIN_CUE_MS = 900; // an action word for a quick action stays long enough to be read
  const ONE_SHOT_MS = 1200; // a key press or a page load: its word shows this long
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let still = motionQuery.matches;
  const reduced = () => still;

  // Actions shown as a word in place of the label. Held words stay while the action runs; the others show for a moment.
  const VERBS = { observe: 'Reading', scroll: 'Scrolling', text: 'Typing', key: 'Pressing keys', navigate: 'Loading',
    drag: 'Dragging', transfer: 'Uploading' };
  const HELD = new Set(['observe', 'scroll', 'text', 'drag', 'transfer']);

  // Session colours: "Claude" (the default label) is blue, other labels hash into the palette, so parallel agents
  // are told apart. Labels on light fills are written in ink.
  function fillFor(label) {
    if (!label || label === 'Claude') return BLUE;
    let hash = 2166136261;
    for (const ch of label) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  const luminance = (c) => c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

  const STYLE = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important;
      z-index: 2147483647 !important; contain: strict !important; display: block !important; }
    @media print { :host { display: none !important; } }
    .cursor, .fx { position: absolute; left: 0; top: 0; }
    .cursor { will-change: transform; } /* not .fx: in a layer of its own, a click ring spreads blurred */
    .body, .art, .press { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    svg { position: absolute; overflow: visible; }
    .pointer { left: ${(-4 - TIP.x) * SCALE}px; top: ${(-4 - TIP.y) * SCALE}px; width: ${24 * SCALE}px; height: ${28 * SCALE}px;
      filter: drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.32)); }
    .arrow { fill: var(--fill); stroke: #fff; stroke-width: ${1.7 / SCALE}; stroke-linejoin: round; paint-order: stroke; }
    .edge { fill: none; stroke: #131110; stroke-opacity: 0.3; stroke-width: ${0.45 / SCALE}; }
    .badge { position: absolute; left: 0; top: 0; }
    .pill { position: relative; height: 17px; }
    /* The pill as two pieces that only move by transform and clip-path, so its width glides on the compositor: a long
       left piece cut off at the right end's centre, and a round right end that slides. White rims under both fills. */
    .shape { position: absolute; left: 0; top: 0; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.3)); }
    .shape > div { position: absolute; left: 0; top: 0; height: 17px; border-radius: 8.5px; background: var(--fill); }
    .shape > .rim { left: -1.5px; top: -1.5px; height: 20px; border-radius: 10px; background: #fff; }
    .shape > .long { width: ${MAX_PILL}px; }
    .shape > .long.rim { width: ${MAX_PILL + 3}px; }
    .shape > .end { width: 17px; }
    .shape > .end.rim { width: 20px; }
    .text { position: absolute; left: 0; top: 0; width: ${MAX_PILL}px; height: 17px; }
    .word, .measure { position: absolute; left: ${PAD}px; top: 0; white-space: nowrap; color: var(--text); letter-spacing: 0.01em;
      font: 600 10.5px/17px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    .word { height: 17px; }
    .ch { position: absolute; left: 0; top: 0; transform-origin: 50% 60%; }
    .ch.whole { max-width: ${MAX_PILL - 2 * PAD}px; overflow: hidden; text-overflow: ellipsis; transform-origin: 0 50%; }
    .word.busy > .ch { opacity: ${DIM}; }
    .ring { position: absolute; left: ${-RING_R}px; top: ${-RING_R}px; width: ${2 * RING_R}px; height: ${2 * RING_R}px;
      box-sizing: border-box; border: 2px solid; border-radius: 50%; }
    .measure { left: 0; visibility: hidden; }
    .glint { position: absolute; left: 0; top: 0; height: 100%; overflow: hidden;
      -webkit-mask-image: linear-gradient(90deg, transparent, #000, transparent); mask-image: linear-gradient(90deg, transparent, #000, transparent); }
    .glint span { position: absolute; left: 0; top: 0; color: var(--text); }`;

  let host = null; // the <fowlbrowser-cursor> element while shown
  let parts = null;
  let observer = null;
  let idleTimer = 0;
  let exiting = null; // Promise while the exit animation runs
  let last = null; // last rendered tip { x, y }, kept after the cursor fades
  let label = '';
  let action = ''; // the action word shown in place of the label, '' for the label
  let badgeWidth = 0;
  let pos = { x: 0, y: 0 }; // where the tip is drawn
  let rot = 0; // the arrow's turn away from its upright rest, radians (its pose plus the lean of travel)
  let pose = 0; // the turn it rests in: 0, or a quarter or half turn where the window's edge would cut it off
  let placed = ''; // which side of the arrow the label is on
  let travel = null; // the planned move: bezier, arc-length table, duration
  let motion = null; // { start, frames, anims }: the travel, lean or turn playing; the state above is read from it
  let waiting = []; // resolvers of move() promises for the current target
  let cueing = null; // { kind, started, ending }: the action word shown
  let following = 0; // follow(true) calls not yet ended (script clicks shown)
  let scriptClicks = []; // script clicks shown in follow mode, until the server drains them (record mode)
  let keepClicks = false; // record mode: the last follow(true) asked to keep them

  // DOM without HTML strings: pages with Trusted Types (YouTube, GitHub) refuse innerHTML even in this world.
  const SVG = 'http://www.w3.org/2000/svg';
  function node(tag, attrs = {}, children = [], ns = null) {
    const made = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, String(value));
    made.append(...children);
    return made;
  }
  const svgNode = (tag, attrs, children) => node(tag, attrs, children, SVG);

  // Styles as constructed sheets, which a page's CSP (style-src) can't block the way it blocks a <style>.
  function sheet(css) {
    try {
      const made = new CSSStyleSheet();
      made.replaceSync(css);
      return made;
    } catch {
      return null;
    }
  }

  function build() {
    // A host left by an earlier world in this document (another server session) gives way to this one.
    for (const old of document.querySelectorAll('fowlbrowser-cursor')) old.remove();
    host = document.createElement('fowlbrowser-cursor');
    host.setAttribute('aria-hidden', 'true');
    const root = host.attachShadow({ mode: 'closed' });
    const base = sheet(STYLE);
    let hiding = sheet('');
    let captureStyle = null;
    if (base && hiding) root.adoptedStyleSheets = [base, hiding];
    else {
      hiding = null; // capture() must toggle the style that is actually attached
      root.append(node('style', {}, [STYLE]), captureStyle = node('style'));
    }
    const div = (name, children = []) => node('div', { class: name }, children);
    const pointer = svgNode('svg', { class: 'pointer', viewBox: '-4 -4 24 28' }, [
      svgNode('path', { class: 'arrow', d: POINTER }),
      svgNode('path', { class: 'edge', d: POINTER }),
    ]);
    const press = div('press', [pointer]);
    const art = div('art', [press]);
    const piece = { longRim: div('long rim'), endRim: div('end rim'), long: div('long'), end: div('end') };
    const shape = div('shape', [piece.longRim, piece.endRim, piece.long, piece.end]);
    const text = div('text');
    const pill = div('pill', [shape, text]);
    const badge = div('badge', [pill]);
    const body = div('body', [art, badge]);
    const cursor = div('cursor', [body]);
    const fx = div('fx');
    // Words are measured outside the cursor, whose zoom and appear scale would skew the box.
    const measure = node('span', { class: 'measure' });
    root.append(fx, cursor, measure);
    parts = { root, cursor, body, art, press, pill, shape, text, piece, badge, measure, fx, hiding, captureStyle, born: performance.now() };
    attach();
    setLabel(label, true); // after attaching, so the badge can be measured
  }

  // In the top layer (a manual popover), so modal dialogs, popovers, fullscreen elements and transformed pages can't
  // cover or shift it; browsers without popovers still get the z-index.
  function attach() {
    document.documentElement.appendChild(host);
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch {}
    // The page may rebuild <html>'s children (frameworks hydrating the document): put the host back.
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (!host || host.isConnected || !document.documentElement) return;
      if (document.documentElement.querySelector(':scope > fowlbrowser-cursor')) teardown(); // a newer world took over
      else attach();
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // Back on top when something entered the top layer after the cursor (a dialog or popover opened later).
  function raise() {
    if (!host?.isConnected || !host.matches(':popover-open')) return;
    if (!document.querySelector(':modal, :popover-open:not(fowlbrowser-cursor), :fullscreen')) return;
    try {
      host.hidePopover();
      host.showPopover();
    } catch {}
  }

  function teardown() {
    observer?.disconnect();
    // Endless animations (an action word's light) would run on in the timeline after their elements are gone.
    for (const a of parts?.root.getAnimations() ?? []) a.cancel();
    host?.remove();
    host = parts = observer = cueing = null;
    action = '';
    // A document leaving (pagehide, bfcache) or a cursor going away stops showing script clicks: a restored page's
    // own clicks must never bring the cursor back.
    if (following) removeEventListener('click', onScriptClick, true);
    following = 0;
    if (motion) {
      halt();
      last = { x: pos.x, y: pos.y }; // a travel cut short: the next cursor appears where it had got to
    }
    travel = null;
    rot = pose = 0;
    placed = '';
    settle(false);
  }

  function setLabel(text, force) {
    if (text === undefined || (!force && text === label)) return;
    label = String(text);
    if (!parts) return;
    const fill = fillFor(label);
    const style = parts.cursor.style; // inside the closed root, never on the page-visible host
    const ink = luminance(fill) > 0.4;
    style.setProperty('--fill', rgb(fill));
    style.setProperty('--text', ink ? '#131110' : '#fff');
    parts.fill = fill;
    showWord(force);
  }

  // The action word in place of the label ("Claude" -> "Typing"); '' brings the label back.
  function setVerb(text) {
    action = text;
    showWord();
    render();
  }

  // The word's letters and where each starts (kerning kept), measured outside the cursor. Text too wide for the pill
  // stays whole, cut with an ellipsis.
  const graphemes = (text) => (globalThis.Intl?.Segmenter ? [...new Intl.Segmenter().segment(text)].map((s) => s.segment) : [...text]);
  function measureWord(text) {
    const { measure } = parts;
    measure.textContent = text;
    const box = measure.getBoundingClientRect();
    const chars = graphemes(text);
    if (!box.width || box.width > MAX_PILL - 2 * PAD) return { width: box.width, chars: [text], xs: [0], whole: true };
    const range = document.createRange();
    const xs = [];
    let at = 0;
    for (const ch of chars) {
      range.setStart(measure.firstChild, at);
      range.setEnd(measure.firstChild, at + ch.length);
      xs.push(range.getBoundingClientRect().left - box.left);
      at += ch.length;
    }
    return { width: box.width, chars, xs, whole: false };
  }

  // Pairs of letters the two words share, in order (longest common subsequence): those slide to their new places.
  function shared(a, b) {
    const n = a.length;
    const m = b.length;
    const len = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    const pairs = new Map(); // index in b -> index in a
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) pairs.set(j++, i++);
      else if (len[i + 1][j] >= len[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  // The pill's width: the long piece is cut off at the right end's centre, the round end slides there. Transforms and
  // clip-path only, which the compositor animates, so a page busy with the agent's action can't stall the glide.
  // The words are cut off at the pill's end too, so a long one never shows past it while the pill grows.
  const pieces = (w) => ({ long: `inset(0 ${MAX_PILL - w + 8.5}px 0 0)`, longRim: `inset(0 ${MAX_PILL - w + 10}px 0 0)`,
    end: `translateX(${w - 17}px)`, text: `inset(0 ${MAX_PILL - w}px 0 0 round 8.5px)` });
  function pillWidth() {
    const glide = parts.glide;
    if (!glide) return parts.width ?? NaN;
    const p = glide.anim.effect.getComputedTiming().progress;
    return p === null ? glide.to : glide.from + (glide.to - glide.from) * p;
  }
  function setPillWidth(to, animate) {
    const { piece } = parts;
    const from = pillWidth();
    for (const a of [...parts.shape.getAnimations({ subtree: true }), ...parts.text.getAnimations()]) a.cancel();
    const at = pieces(to);
    parts.text.style.clipPath = at.text;
    piece.long.style.clipPath = at.long;
    piece.longRim.style.clipPath = at.longRim;
    piece.end.style.transform = piece.endRim.style.transform = at.end;
    parts.glide = null;
    parts.width = to;
    if (!animate || !(Math.abs(from - to) > 0.5)) return;
    const was = pieces(from);
    const timing = { duration: MORPH_MS, easing: EASE_IN_OUT };
    parts.glide = { from, to, anim: piece.long.animate([{ clipPath: was.long }, { clipPath: at.long }], timing) };
    piece.longRim.animate([{ clipPath: was.longRim }, { clipPath: at.longRim }], timing);
    for (const el of [piece.end, piece.endRim]) el.animate([{ transform: was.end }, { transform: at.end }], timing);
    parts.text.animate([{ clipPath: was.text }, { clipPath: at.text }], timing);
  }

  // Where a letter is drawn now, its animations stopped: an interrupted change goes on from there.
  function letterAt(el) {
    const style = getComputedStyle(el);
    const v = matrix(style.transform);
    const at = { x: v[4], y: v[5], scale: v[0], opacity: Number(style.opacity) }; // read before the animations go
    for (const a of el.getAnimations()) a.cancel();
    return at;
  }
  function matrix(transform) {
    const m = transform.match(/^matrix\(([^)]+)\)/);
    return m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
  }
  // Where the label is drawn now, its animations included.
  const shownAt = () => { const v = matrix(getComputedStyle(parts.badge).transform); return { x: v[4], y: v[5] }; };

  // The pill shows the action word while there is one, else the label. A change morphs: letters both words share slide
  // to their new places, the others rise away and come up in turn, and the pill glides to its width. While an action
  // word shows, a light runs over it. Transforms, opacity and clip-path only, so a busy page can't stall any of it.
  function showWord(instant) {
    if (!parts) return;
    const { pill, badge } = parts;
    const text = action || label;
    const shown = `${action ? 'action' : 'label'}:${text}`; // a label spelled like an action word is still a label
    badge.style.display = text ? '' : 'none';
    if (shown === parts.shown && !instant) return;
    // A cursor just appearing shows its first word as it fades in, without a change on top.
    const morph = !instant && parts.shown !== undefined && performance.now() - parts.born > 120;
    parts.shown = shown;
    const m = measureWord(text);
    parts.unmeasured = !m.width && !!text; // hidden for a screenshot: measured again after it
    const placed = morph && !still ? getComputedStyle(badge).transform : 'none';
    badgeWidth = Math.min(Math.ceil(m.width) + 2 * PAD, MAX_PILL);
    const old = parts.word;
    const word = node('span', { class: action && !still ? 'word busy' : 'word' });
    const letters = m.chars.map((ch, i) => {
      const el = node('span', { class: m.whole ? 'ch whole' : 'ch' }, [ch]);
      el.style.transform = `translateX(${m.xs[i]}px)`;
      return el;
    });
    word.append(...letters);
    parts.text.appendChild(word);
    parts.word = word;
    const rest = action && !still ? DIM : 1;
    if (!morph) {
      for (const el of parts.text.querySelectorAll('.word')) if (el !== word) leave(el);
    } else if (still) {
      if (old) {
        const { opacity } = current(old); // a word still coming in goes from where it got to
        for (const a of old.getAnimations()) a.cancel();
        fade(old, [old.animate([{ opacity }, { opacity: 0 }], { duration: 120, easing: CURVE, fill: 'forwards' })]);
      }
      word.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: CURVE, fill: 'backwards' });
    } else {
      const before = old && !old.classList.contains('out') ? [...old.querySelectorAll('.ch')] : [];
      const pairs = old && !m.whole && !before.some((el) => el.classList.contains('whole'))
        ? shared(before.map((el) => el.textContent), m.chars) : new Map();
      const kept = new Set(pairs.values());
      const from = new Map([...pairs].map(([j, i]) => [j, letterAt(before[i])]));
      // Going: letters the next word doesn't have rise a little and fade, from the left.
      if (old) {
        old.classList.add('out');
        for (const a of old.getAnimations({ subtree: true })) if (a.effect.target.closest('.glint')) a.cancel();
        old.querySelector('.glint')?.remove();
        let k = 0;
        const going = [];
        for (const [i, el] of before.entries()) {
          if (kept.has(i) || !el.textContent.trim()) { el.style.visibility = 'hidden'; continue; } // a space has nothing to animate
          const at = letterAt(el);
          going[going.length] = el.animate([{ transform: `translate(${at.x}px, ${at.y}px) scale(${at.scale})`, opacity: at.opacity },
            { transform: `translate(${at.x}px, -3px) scale(0.92)`, opacity: 0 }],
          { duration: 120, delay: 10 * k++, easing: CURVE, fill: 'both' });
        }
        fade(old, going);
      }
      // Coming: shared letters slide over from where they were; the rest come up in turn.
      let k = 0;
      for (const [j, el] of letters.entries()) {
        const was = from.get(j);
        if (!m.chars[j].trim()) continue;
        if (was) {
          // It takes the next word's strength by halfway, so it doesn't stand out while it slides.
          el.animate([{ transform: `translate(${was.x}px, ${was.y}px) scale(${was.scale})`, opacity: was.opacity, easing: EASE_IN_OUT },
            { opacity: rest, offset: 0.5, easing: EASE_IN_OUT }, { transform: el.style.transform, opacity: rest }],
          { duration: MORPH_MS, fill: 'backwards' });
        } else {
          el.animate([{ transform: `translate(${m.xs[j]}px, 3px) scale(0.92)`, opacity: 0 }, { transform: el.style.transform, opacity: rest }],
            { duration: 200, delay: 60 + 12 * k++, easing: CURVE, fill: 'backwards' });
        }
      }
    }
    // The light: a soft-edged window sweeping across the word as it arrives and every 1.8 s while the action lasts,
    // holding a full-strength copy that stays in place.
    if (action && !still) {
      const band = Math.max(24, Math.round(m.width * 0.6));
      const lit = node('span', {}, [text]);
      const glint = node('span', { class: 'glint' }, [lit]);
      glint.style.width = `${band}px`;
      word.appendChild(glint);
      const swept = SHIMMER_MS / SHIMMER_EVERY_MS;
      const pass = { duration: SHIMMER_EVERY_MS, delay: morph ? MORPH_MS : 0, iterations: Infinity, fill: 'backwards' };
      const sweep = (a, b) => [{ transform: `translateX(${a}px)`, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
        { transform: `translateX(${b}px)`, offset: swept }, { transform: `translateX(${b}px)` }];
      glint.animate(sweep(-band, m.width), pass);
      lit.animate(sweep(band, -m.width), pass);
    }
    setPillWidth(badgeWidth, morph && !still);
    // A travel places the label as it goes: the rest of its way is worked out again for the new width.
    if (travel && motion && relabel()) return;
    // Against the viewport's right edge the label moves as it grows or shrinks: it glides there with the width.
    for (const a of badge.getAnimations()) a.cancel();
    badge.style.transform = badgeAt();
    if (placed !== 'none' && placed !== getComputedStyle(badge).transform) {
      badge.animate([{ transform: placed }, { transform: badge.style.transform }], { duration: MORPH_MS, easing: EASE_IN_OUT });
    }
  }

  // A word that has gone: removed with every animation on it (its light is endless).
  function leave(el) {
    for (const a of el.getAnimations({ subtree: true })) a.cancel();
    el.remove();
  }
  // A word on its way out: removed once its animations have played (a word interrupted mid-change stays until then).
  function fade(el, animations) {
    el.classList.add('out');
    Promise.all(animations.map((a) => a.finished)).then(() => leave(el), () => {});
  }

  // The viewport's size and the page scale, read once and kept until the window or the visual viewport changes, so a
  // frame never forces a layout.
  let view = null;
  // The browser's zoom for the site (the server reads it, move opts.zoom; 0.8 at 80%). An unpinched page draws the
  // cursor by its inverse, so it keeps its size on screen; a pinched or zoomed-out mobile page by its page scale.
  let browserZoom = 1;
  function viewport() {
    if (view) return view;
    // In quirks mode <html>'s client size is the content's, not the viewport's.
    const el = document.compatMode === 'BackCompat' ? null : document.documentElement;
    const scale = globalThis.visualViewport?.scale || 1;
    view = { w: el?.clientWidth || innerWidth, h: el?.clientHeight || innerHeight, zoom: 1 / (scale === 1 ? browserZoom : scale) };
    return view;
  }
  const forget = () => { view = null; };
  // A resize at rest can leave the arrow or its label where they no longer fit (or the arrow outside a narrower
  // window): placed again, inside it.
  addEventListener('resize', () => {
    forget();
    if (!parts || travel) return;
    halt(); // a lean settling or a turn goes on from here into the pose that fits now
    pos = inside(pos);
    render();
  });
  globalThis.visualViewport?.addEventListener('resize', forget);
  globalThis.visualViewport?.addEventListener('scroll', forget);

  const zoom = () => viewport().zoom;

  // A point inside the viewport: an element taller than it, or not scrolled into view, still gets a visible cursor.
  function inside(point) {
    const { w, h } = viewport();
    return { x: Math.min(Math.max(point.x, 2), Math.max(w - 2, 2)), y: Math.min(Math.max(point.y, 2), Math.max(h - 2, 2)) };
  }

  function render() {
    sync();
    last = { x: pos.x, y: pos.y };
    if (!parts) return;
    // A page zoomed out (a mobile viewport without a viewport meta) would shrink the cursor with it: undo the page scale.
    const k = zoom();
    // At rest, a window resize can leave the arrow where its pose no longer fits: it turns again (and a lean cut short
    // settles back).
    if (!motion && (poseAt(pos) !== pose || rot !== pose)) {
      pose = poseAt(pos);
      if (still || Math.abs(wrap(rot - pose)) < 0.002) rot = pose;
      else play(null);
    }
    parts.cursor.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)${k === 1 ? '' : ` scale(${k})`}`;
    parts.art.style.transform = rot ? `rotate(${rot}rad)` : '';
    const [side, at] = badgePlace();
    // The label gliding to its other side (the arrow turned near an edge, or met one) rather than jumping there.
    if (placed && side !== placed && !still && !parts.badge.getAnimations().length) {
      parts.badge.animate([{ transform: parts.badge.style.transform }, { transform: at }], { duration: WORD_MS, easing: CURVE });
    }
    placed = side;
    parts.badge.style.transform = at;
  }

  // The arrow's body runs down and to the right of its tip (CSS px, rim and shadow included). Near the window's bottom or
  // right edge it would be cut off (a chat box at the foot of a page, a button in a corner): there it turns a quarter or
  // half turn around its tip, so all of it shows and it still points at the target. The turns tried, in order.
  const BODY = [[-2, -2], [16, -2], [-2, 22], [16, 22]];
  const POSES = [0, -Math.PI / 2, Math.PI / 2, Math.PI];
  function poseAt(p) {
    const { w, h } = viewport();
    const k = zoom();
    // How far the turned body's corners stick out of the window, in px (0: it fits).
    const out = (angle) => BODY.reduce((sum, [bx, by]) => {
      const x = p.x + (bx * Math.cos(angle) - by * Math.sin(angle)) * k;
      const y = p.y + (bx * Math.sin(angle) + by * Math.cos(angle)) * k;
      return sum + Math.max(0, -x, x - w) + Math.max(0, -y, y - h);
    }, 0);
    // The first that fits, else (a page zoomed far out scales the cursor up) the one least cut off.
    return POSES.find((angle) => !out(angle)) ?? POSES.reduce((best, angle) => (out(angle) < out(best) ? angle : best));
  }

  // The label: below and to the right of the arrow; where that doesn't fit, beside the arrow at the tip's height, on the
  // side away from its body when it is turned; always inside the window. [side, transform], for the tip at p in pose turn.
  function badgePlace(p = pos, turn = pose) {
    const k = zoom();
    const { w, h } = viewport();
    const bh = 17;
    const right = [BADGE.x + 2, -bh / 2];
    const left = (gap) => [-badgeWidth - gap, -bh / 2];
    const sides = {
      [0]: [['below', [BADGE.x, BADGE.y]], ['right', right], ['left', left(6)]],
      [-Math.PI / 2]: [['right', [24, -bh / 2]], ['left', left(6)]],
      [Math.PI / 2]: [['left', left(24)], ['right', [6, -bh / 2]]],
      [Math.PI]: [['left', left(20)], ['right', [6, -bh / 2]]],
    }[turn] ?? [['below', [BADGE.x, BADGE.y]]];
    const inside = ([bx, by]) => p.x + bx * k >= 2 && p.y + by * k >= 2 && p.x + (bx + badgeWidth) * k <= w - 2 && p.y + (by + bh) * k <= h - 2;
    const [side, [bx, by]] = sides.find(([, at]) => inside(at)) ?? sides[0];
    const x = Math.min(Math.max(bx, (2 - p.x) / k), (w - 2 - p.x) / k - badgeWidth);
    const y = Math.min(Math.max(by, (2 - p.y) / k), (h - 2 - p.y) / k - bh);
    return [side, `translate(${x}px, ${y}px)`, x, y];
  }
  const badgeAt = () => badgePlace()[1];

  // Current opacity and scale of an element, so a new animation starts where the running one is.
  function current(el) {
    const style = getComputedStyle(el);
    const m = style.transform.match(/^matrix\(([^,]+)/);
    return { opacity: Number(style.opacity), scale: m ? Number(m[1]) : 1 };
  }

  function animateBody(toOpacity, toScale, duration, from = current(parts.body)) {
    for (const a of parts.body.getAnimations()) a.cancel();
    return parts.body.animate([
      { opacity: from.opacity, transform: `scale(${from.scale})` },
      { opacity: toOpacity, transform: `scale(${toScale})` },
    ], { duration, easing: CURVE, fill: 'forwards' });
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    // An action still running (its cue loops until the server ends it) is no idle time: a long wait_for or
    // evaluate keeps the cursor up.
    // (A cue whose end never arrived stops counting as running after 2 minutes.)
    idleTimer = setTimeout(() => (cueing && !cueing.ending && HELD.has(cueing.kind) && performance.now() - cueing.started < 120_000
      ? resetIdle() : hide()), IDLE_MS);
  }

  function settle(arrived) {
    const done = waiting;
    waiting = [];
    for (const resolve of done) resolve(arrived);
  }

  // Shows the cursor (first call, or after it faded): at the last known point, else where the server last had it,
  // else a little right of and below the viewport's centre.
  function ensure(opts = {}) {
    let fresh = false;
    if (!host) {
      build();
      fresh = true;
      const { w, h } = viewport();
      const from = opts.from && Number.isFinite(opts.from.x) && Number.isFinite(opts.from.y) ? opts.from : null;
      pos = inside(last ?? (from ? { x: Number(from.x), y: Number(from.y) } : { x: w * 0.58, y: h * 0.55 }));
      rot = pose = poseAt(pos);
      travel = null;
    } else if (!host.isConnected && document.documentElement) {
      attach(); // the page replaced its document element (document.open, a rebuilt <html>)
    }
    setLabel(opts.label);
    const z = Number(opts.zoom);
    if (Number.isFinite(z) && z >= 0.25 && z <= 5 && z !== browserZoom) {
      browserZoom = z;
      view = null;
    }
    if (fresh || exiting) {
      exiting = null;
      animateBody(1, 1, 220, fresh ? { opacity: 0, scale: still ? 1 : 0.85 } : undefined);
    }
    render();
    resetIdle();
  }

  // --- travel (a curved, Fitts-timed path, after Cua's signature_arc; MIT, see THIRD_PARTY_NOTICES.md) ---

  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  // A smooth bump that peaks at `at`: the follow-through past the target, then back.
  const A = 8.2;
  const B = 1.8;
  const PEAK = (A / (A + B)) ** A * (B / (A + B)) ** B;
  const bump = (t) => (t ** A * (1 - t) ** B) / PEAK;
  const wrap = (a) => {
    let r = a % (2 * Math.PI);
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r < -Math.PI) r += 2 * Math.PI;
    return r;
  };

  // A cubic Bezier bending upward for horizontal moves, timed by Fitts' law, walked by arc length.
  function plan(to, box, left) {
    const from = { ...pos };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) return null;
    const side = dx >= 0 ? -1 : 1;
    const bend = d * 0.16 * side;
    const flow = (0.15 + 1) / 2;
    const n = { x: -dy / d, y: dx / d };
    const c1 = { x: from.x + dx * 0.3 + n.x * bend * (1 - 0.5 * flow), y: from.y + dy * 0.3 + n.y * bend * (1 - 0.5 * flow) };
    const c2 = { x: to.x - dx * 0.3 + n.x * bend * (1 - 0.5 * (1 - flow)), y: to.y - dy * 0.3 + n.y * bend * (1 - 0.5 * (1 - flow)) };
    const point = (u) => {
      const v = 1 - u;
      const a = v * v * v;
      const b = 3 * v * v * u;
      const c = 3 * v * u * u;
      const e = u * u * u;
      return { x: a * from.x + b * c1.x + c * c2.x + e * to.x, y: a * from.y + b * c1.y + c * c2.y + e * to.y };
    };
    const lengths = [0];
    let prev = from;
    for (let i = 1; i <= 64; i++) {
      const p = point(i / 64);
      lengths.push(lengths[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    const total = lengths[64];
    const near = point(1 - 1e-3);
    const tail = Math.hypot(to.x - near.x, to.y - near.y) || 1;
    const width = Math.max(Math.min(box?.w ?? 24, box?.h ?? 24), 4);
    // Short hops (a form's next field) are quicker than Fitts' floor: about 160 ms at 10 px, 220 ms at 50 px.
    const fitts = Math.min(Math.max(150 + 120 * Math.log2(d / width + 1), 300), 1000) * TIMING;
    const ms = Math.min(fitts, SHORT_MS + 1.6 * d, MAX_MOVE_MS, left);
    return {
      to, ms, over: Math.min(0.018, 6 / d),
      // The point `frac` of the way along by distance; past 1 it carries on along the end tangent.
      at(frac) {
        if (frac > 1) return { x: to.x + ((to.x - near.x) / tail) * (frac - 1) * total, y: to.y + ((to.y - near.y) / tail) * (frac - 1) * total };
        const s = Math.max(frac, 0) * total;
        let lo = 0;
        let hi = 64;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (lengths[mid] < s) lo = mid;
          else hi = mid;
        }
        const f = (s - lengths[lo]) / Math.max(lengths[hi] - lengths[lo], 1e-9);
        return point((lo + f) / 64);
      },
    };
  }

  // CURVE at u (0..1 of the time), for the label's glides worked out ahead.
  const cubic = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  function ease(u) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      if (cubic(t, 0.23, 0.32) < u) lo = t;
      else hi = t;
    }
    return cubic((lo + hi) / 2, 1, 1);
  }

  // A move's travel, lean and turn, worked out ahead the way a frame loop would draw them: a sample every 60th of a
  // second, on until the lean has settled into the pose. m: a planned move, or null to turn in place into the pose.
  const STEP = 1000 / 60;
  function sample(m) {
    const ms = m ? m.ms : 0;
    const profile = (t) => m.at(minJerk(t) + m.over * bump(t));
    const frames = [];
    let r = rot;
    for (let at = 0, prev = 0; ; prev = at, at = at < ms ? Math.min(at + STEP, ms) : at + STEP) {
      let p = m ? m.to : pos;
      let vx = 0;
      let vy = 0;
      if (m && at <= ms) {
        const t = at / ms;
        if (t < 1) p = profile(t);
        // Velocity from the neighbouring samples (about 17 ms either side), for the lean.
        const h = STEP / ms;
        const t0 = Math.max(t - h, 0);
        const t1 = Math.min(t + h, 1);
        const a = profile(t0);
        const b = profile(t1);
        const span = ((t1 - t0) * ms) / 1000;
        vx = (b.x - a.x) / span;
        vy = (b.y - a.y) / span;
      }
      const speed = Math.hypot(vx, vy);
      // The tip leans a little into the direction of travel once it moves fast enough, and settles back after, into the
      // pose that fits where it is (turned near the window's bottom or right edge).
      const turn = poseAt(p);
      const toward = Math.min(Math.max(wrap(Math.atan2(vy, vx) - TIP_ANGLE - turn), -LEAN), LEAN);
      const want = turn + (speed > 0 ? toward * Math.min(Math.max((speed - 40) / 260, 0), 1) : 0);
      r += wrap(want - r) * (1 - Math.exp(-((at - prev) / 1000) * 22));
      const settled = at >= ms && Math.abs(wrap(r - turn)) < 0.002;
      if (settled) r -= wrap(r - turn); // the pose, or a whole turn from it: a keyframe at the pose itself would spin
      const [side, , bx, by] = badgePlace(p, turn);
      frames.push({ at, x: p.x, y: p.y, rot: r, side, bx, by });
      if (settled) return frames;
    }
  }

  // Plays a move (or, m null, a turn in place) as WAAPI animations of transform, which Chrome runs on the compositor:
  // a busy page's main thread can't stall them. When they end, their last values go to the inline styles.
  function play(m) {
    const frames = sample(m);
    const start = performance.now();
    const old = motion;
    const anims = [];
    let end = 0;
    const run = (el, keys) => {
      const anim = track(el, keys, start);
      if (!anim) return;
      anims.push(anim);
      end = Math.max(end, keys.at(-1).at);
    };
    run(parts.art, frames.map((f) => ({ at: f.at, transform: `rotate(${f.rot}rad)` })));
    if (m) {
      const k = zoom();
      run(parts.cursor, frames.filter((f) => f.at <= m.ms)
        .map((f) => ({ at: f.at, transform: `translate3d(${f.x}px, ${f.y}px, 0)${k === 1 ? '' : ` scale(${k})`}` })));
      const from = shownAt();
      for (const a of parts.badge.getAnimations()) if (!old?.anims.includes(a)) a.cancel(); // a word's glide: the travel's own takes over
      run(parts.badge, labelKeys(frames, from));
      // Arrival: the tip within 1 px of the target (the follow-through finishes during the action).
      m.arrive = frames.find((f) => Math.hypot(m.to.x - f.x, m.to.y - f.y) <= 1).at;
    }
    const played = { start, frames, anims, end };
    motion = played;
    for (const anim of old?.anims ?? []) anim.cancel(); // after the new ones started: no frame of the inline styles
    // At the end (later if relabel() gave the label a longer way), the last values go to the inline styles.
    const finish = () => {
      if (motion !== played) return;
      const wait = played.start + played.end - performance.now();
      if (wait > 1) return void setTimeout(finish, wait);
      sync();
      rot = pose;
      motion = null;
      render();
      for (const anim of played.anims) anim.cancel();
    };
    setTimeout(finish, end);
  }

  // Keyframes ({ at, transform }, at 0 first) played from `start` on the clock sync() reads, whenever the page gets to
  // its next frame; none when they hold still (the label, mostly: its inline style holds).
  function track(el, keys, start) {
    if (keys.every((key) => key.transform === keys[0].transform)) return null;
    const duration = keys.at(-1).at;
    const anim = el.animate(keys.map(({ at, ...key }) => ({ easing: 'linear', ...key, offset: at / duration })), { duration, fill: 'forwards' });
    anim.startTime = start;
    return anim;
  }

  // The label along a travel's frames, from where it is drawn now (`from`): it glides (WORD_MS) rather than jumps, to its
  // other side when the arrow turns near an edge or meets one, and from wherever it was, toward where that side is as
  // the arrow moves on, so it stays inside the window.
  function labelKeys(frames, from) {
    const keys = [];
    let side = placed;
    let { x, y } = from;
    let glide = Math.hypot(x - frames[0].bx, y - frames[0].by) > 0.5 ? { at: frames[0].at, x, y } : null; // { at, x, y }: when and from where it last set off
    const place = (at, f) => {
      if (side && f.side !== side && !(at < glide?.at + WORD_MS)) glide = { at, x, y }; // (one running goes on)
      side = f.side;
      const k = glide ? ease(Math.min((at - glide.at) / WORD_MS, 1)) : 1;
      x = (glide?.x ?? f.bx) + (f.bx - (glide?.x ?? f.bx)) * k;
      y = (glide?.y ?? f.by) + (f.by - (glide?.y ?? f.by)) * k;
      keys.push({ at, transform: `translate(${x}px, ${y}px)` });
    };
    for (const f of frames) place(f.at, f);
    for (let at = frames.at(-1).at; glide && at < glide.at + WORD_MS;) place(at = Math.min(at + STEP, glide.at + WORD_MS), frames.at(-1));
    return keys;
  }

  // The label's width changed during a travel: the rest of its way, placed for the new width. False when the travel has
  // no frames left (it is placed where it ends).
  function relabel() {
    sync();
    const now = performance.now();
    const at = now - motion.start;
    const left = motion.frames.filter((f) => f.at > at);
    if (!left.length) return false;
    const frames = [{ ...left[0], at }, ...left].map((f) => {
      const [side, , bx, by] = badgePlace(f, poseAt(f));
      return { ...f, at: f.at - at, side, bx, by };
    });
    const keys = labelKeys(frames, shownAt());
    const anim = track(parts.badge, keys, now);
    for (const a of motion.anims) if (a.effect.target === parts.badge) a.cancel();
    motion.anims = [...motion.anims.filter((a) => a.effect.target !== parts.badge), ...(anim ? [anim] : [])];
    if (anim) motion.end = Math.max(motion.end, at + keys.at(-1).at);
    if (!anim) parts.badge.style.transform = badgeAt();
    return true;
  }

  // While a motion plays, the tip, its turn and the label's side are where its animations have got to.
  function sync() {
    if (!motion) return;
    const { frames, start } = motion;
    const at = performance.now() - start;
    let i = 0;
    while (i < frames.length - 1 && frames[i + 1].at <= at) i++;
    const f = frames[i];
    const g = frames[i + 1] ?? f;
    const u = g === f ? 0 : Math.max((at - f.at) / (g.at - f.at), 0);
    pos = { x: f.x + (g.x - f.x) * u, y: f.y + (g.y - f.y) * u };
    rot = f.rot + (g.rot - f.rot) * u;
    pose = poseAt(pos);
    placed = f.side;
  }

  // A motion cut short: the state stays where it got to (the caller renders it), its animations go.
  function halt() {
    sync();
    for (const anim of motion?.anims ?? []) anim.cancel();
    motion = travel = null;
  }

  // Reduced motion: no travel, the pointer crossfades from where it was to the target in 120 ms.
  function jump(to) {
    halt();
    render(); // the ghost below starts where the cursor is
    rot = pose = poseAt(to);
    // The ghost starts as visible as the cursor is (a cursor still fading in leaves no flash where it was).
    const { opacity } = current(parts.body);
    const ghost = parts.cursor.cloneNode(true);
    parts.root.appendChild(ghost);
    ghost.animate([{ opacity }, { opacity: 0 }], { duration: 120, easing: CURVE, fill: 'forwards' }).finished
      .then(() => ghost.remove(), () => ghost.remove());
    pos = { ...to };
    render();
    return parts.cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: CURVE }).finished
      .then(() => true, () => true);
  }

  // --- action words ---

  // The word goes once the action has shown long enough to be read (at once when another action takes over).
  function endCue(fast) {
    const c = cueing;
    if (!c || c.ending) return;
    c.ending = true;
    const wait = fast ? 0 : Math.max(0, MIN_CUE_MS - (performance.now() - c.started));
    setTimeout(() => {
      if (cueing !== c) return;
      cueing = null;
      setVerb('');
    }, wait);
  }

  function playCue(kind) {
    const verb = VERBS[kind];
    if (!verb || !parts) return;
    if (cueing?.kind === kind && !cueing.ending) return; // already showing
    const c = { kind, started: performance.now(), ending: false };
    cueing = c;
    setVerb(verb);
    if (!HELD.has(kind)) setTimeout(() => cueing === c && endCue(false), ONE_SHOT_MS);
  }

  // --- API ---

  function move(x, y, opts = {}) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return Promise.resolve(false);
    ensure(opts);
    raise();
    const to = inside({ x: Number(x), y: Number(y) });
    settle(false); // an earlier target was not reached
    let resolveOwn;
    const arrived = new Promise((resolve) => { resolveOwn = resolve; waiting.push(resolve); });
    const own = (ok) => {
      if (!waiting.includes(resolveOwn)) return;
      waiting = waiting.filter((r) => r !== resolveOwn);
      resolveOwn(ok);
    };
    // opts.until (wall clock ms): when the action goes ahead. The travel fits into the time left.
    const left = Number.isFinite(opts.until) ? opts.until - Date.now() : Infinity;
    // A hidden document gets no frames (rAF and animations stop), and too little time left shows no travel:
    // the cursor just goes there.
    if (document.hidden || left < MIN_MOVE_MS) {
      snap(to);
      own(true);
      return arrived;
    }
    if (reduced()) {
      if (pos.x === to.x && pos.y === to.y) own(true);
      else jump(to).then((ok) => own(host ? ok : false));
      return arrived;
    }
    const box = Number.isFinite(opts.w) && Number.isFinite(opts.h) ? { w: opts.w, h: opts.h } : null;
    const planned = plan(to, box, left);
    if (!planned) {
      halt();
      pos = { ...to };
      render();
      own(true);
      return arrived;
    }
    travel = planned;
    play(planned); // from the tip and lean where a travel under way has got to
    setTimeout(() => { if (travel === planned) settle(true); }, planned.arrive);
    setTimeout(() => {
      if (travel !== planned) return;
      travel = null;
      settle(true);
    }, planned.ms);
    // Frames can stop under us (the window covered or on another Space): the move still ends on time.
    setTimeout(() => { if (travel === planned) snap(planned.to); }, Math.min(planned.ms + 150, left));
    return arrived;
  }

  // Just before the action: the tip on the target at full opacity now, whatever travel or appear fade is left (a busy
  // page gave them no frames). The page runs this before the action's input events, so they paint together.
  function land(x, y, opts = {}) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false;
    const to = inside({ x: Number(x), y: Number(y) });
    sync();
    if (host && !exiting && Math.hypot(to.x - pos.x, to.y - pos.y) <= 2 && current(parts.body).opacity >= 0.99) return false;
    ensure(opts);
    exiting = null;
    for (const a of [...parts.body.getAnimations(), ...parts.cursor.getAnimations()]) a.cancel();
    snap(to);
    return true;
  }

  // Straight to a point, done: no travel left, everyone waiting has arrived.
  function snap(to) {
    halt();
    rot = pose = poseAt(to);
    pos = { ...to };
    // The label goes with it at once, at its new width: a glide from where it sat by the old point (or toward it) would
    // start it off the window's edge.
    for (const a of [...parts?.badge.getAnimations() ?? [], ...parts?.shape.getAnimations({ subtree: true }) ?? [], ...parts?.text.getAnimations() ?? []]) a.cancel();
    placed = '';
    render();
    settle(true);
  }

  // Resolves once the word is on screen (two frames on, at most 100 ms), so the server can start the action after it:
  // a page busy with the action can't hold the change back, and the compositor plays it from there.
  function cue(kind, opts = {}) {
    ensure(opts);
    playCue(kind);
    if (!parts || !VERBS[kind]) return Promise.resolve(false);
    if (document.hidden) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 100, true);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }));
    });
  }

  function cueEnd() {
    if (cueing && HELD.has(cueing.kind)) endCue(false);
  }

  // x, y: where the click happened. A cursor that hasn't got there yet (a late or slow move) jumps there first, so
  // the feedback is on the clicked spot.
  function click(x, y) {
    if (!host) return;
    resetIdle();
    sync();
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const at = inside({ x, y });
      if (Math.hypot(at.x - pos.x, at.y - pos.y) > 12) snap(at); // (a few px off is the follow-through settling)
    }
    if (reduced()) return;
    // The pointer presses in around its tip (a press that interrupts the last one goes on from where it is), and a
    // ring of the session's colour spreads from the point: drawn at its full size and scaled down, so it stays sharp.
    const { scale } = current(parts.press);
    for (const a of parts.press.getAnimations()) a.cancel();
    parts.press.animate([
      { transform: `scale(${scale})`, easing: CURVE },
      { transform: 'scale(0.86)', offset: 0.35, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
      { transform: 'scale(1)' },
    ], { duration: 220 });
    const circle = node('div', { class: 'ring' });
    circle.style.borderColor = rgb(parts.fill);
    const ring = node('div', { class: 'fx' }, [circle]);
    ring.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${zoom()})`;
    parts.fx.appendChild(ring);
    circle.animate([{ transform: 'scale(0.3)', opacity: 0.85 }, { opacity: 0.55, offset: 0.8 }, { transform: 'scale(1)', opacity: 0 }],
      { duration: 420, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'forwards' })
      .finished.then(() => ring.remove(), () => ring.remove());
  }

  // An agent that clicks from a script (evaluate) sends no real input, so the tools can't animate it: the overlay
  // hears those clicks itself and shows them, so the user still sees each one. Real input (isTrusted) is either a tool's
  // own, already animated, or the user's.
  function onScriptClick(event) {
    if (event.isTrusted) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || target === host) return;
    const box = target.getBoundingClientRect();
    if (!box.width && !box.height) return;
    if (keepClicks) {
      scriptClicks.push({ t: Date.now(), x: box.left + box.width / 2, y: box.top + box.height / 2 });
      if (scriptClicks.length > 50) scriptClicks.shift();
    }
    move(box.left + box.width / 2, box.top + box.height / 2, { w: box.width, h: box.height }).then((arrived) => { if (arrived) click(); });
  }

  function follow(on, record = false) {
    if (on) keepClicks = record;
    if (on && following++ === 0) addEventListener('click', onScriptClick, true);
    if (!on && following > 0 && --following === 0) removeEventListener('click', onScriptClick, true);
  }

  function hide() {
    clearTimeout(idleTimer);
    if (!host) return Promise.resolve();
    if (exiting) return exiting;
    halt();
    render(); // the exit plays where the cursor is
    settle(false);
    const anim = animateBody(0, still ? current(parts.body).scale : 0.9, 200);
    const done = anim.finished.then(() => true, () => false).then((finished) => {
      if (exiting === done && finished) {
        exiting = null;
        teardown();
      }
    });
    exiting = done;
    return done;
  }

  function capture(on) {
    const css = on ? ':host { display: none !important; }' : '';
    if (parts?.hiding) parts.hiding.replaceSync(css);
    else if (parts?.captureStyle) parts.captureStyle.textContent = css;
    if (!on && parts?.unmeasured) {
      showWord(true);
      render();
    }
    return !!parts;
  }

  // What a viewer sees (record mode): the host attached and displayed, the arrow's effective opacity (its own times
  // its ancestors' in the shadow tree) and the tip in viewport CSS px.
  function state() {
    sync();
    const attached = !!host?.isConnected;
    const displayed = attached && host.checkVisibility();
    let opacity = 0;
    if (parts) {
      opacity = 1;
      for (let el = parts.root.querySelector('.arrow'); el && el !== parts.root; el = el.parentNode) opacity *= Number(getComputedStyle(el).opacity);
    }
    const { w, h } = viewport();
    const inView = pos.x >= 0 && pos.y >= 0 && pos.x <= w && pos.y <= h;
    return { attached, displayed, opacity, x: pos.x, y: pos.y, visible: displayed && opacity > 0.5 && inView, hidden: document.hidden };
  }

  function drainClicks() {
    const drained = scriptClicks;
    scriptClicks = [];
    return drained;
  }

  // Reduced motion turned on or off while the cursor shows: a travel under way crossfades to its target, an appear or
  // exit ends at once, and the word is drawn again with or without its light.
  motionQuery.addEventListener('change', (event) => {
    still = event.matches;
    if (!parts) return;
    if (still) {
      for (const a of parts.body.getAnimations()) a.finish();
      if (travel) {
        jump(travel.to);
        settle(true);
      }
    }
    showWord(true);
  });

  // A page going into the back/forward cache drops its cursor, so a restored page never brings back a stale one
  // (the server tracks the cursor per document and would not hide it for screenshots).
  addEventListener('pagehide', () => { exiting = null; teardown(); });

  Object.defineProperty(globalThis, '__fbCursor', { value: Object.freeze({ move, land, cue, cueEnd, click, follow, hide, capture, state, drainClicks }) });
})();
