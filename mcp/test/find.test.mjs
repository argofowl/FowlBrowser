// snapshot find: only the lines with the text, each with the lines it sits in and what it holds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findInSnapshot } from '../src/snapshots.mjs';

const SNAP = `- main [ref=e2]:
  - heading "Inbox" [level=1] [ref=e3]
  - grid "Messages" [ref=e5]:
    - row "Dana Reyes Contract draft" [ref=e6]:
      - generic [ref=e7]: Dana Reyes
    - row "Priya Natarajan Lunch next week Archive Delete" [ref=e8]:
      - generic [ref=e9]: Priya Natarajan
      - button "Archive" [ref=e10] [cursor=pointer]
      - button "Delete" [ref=e11] [cursor=pointer]
- contentinfo [ref=e12]: Footer`;

test('a match comes with its ancestors and its subtree; gaps are marked; case does not matter', () => {
  const { text, matches } = findInSnapshot(SNAP, 'priya');
  assert.equal(matches, 2);
  assert.equal(text, `- main [ref=e2]:
  # …
  - grid "Messages" [ref=e5]:
    # …
    - row "Priya Natarajan Lunch next week Archive Delete" [ref=e8]:
      - generic [ref=e9]: Priya Natarajan
      - button "Archive" [ref=e10] [cursor=pointer]
      - button "Delete" [ref=e11] [cursor=pointer]
# …`);
});

test('no match is no text; a leaf match keeps only its line and ancestors', () => {
  assert.deepEqual(findInSnapshot(SNAP, 'refund'), { text: '', matches: 0 });
  assert.equal(findInSnapshot(SNAP, '"Delete"').text, `- main [ref=e2]:
  # …
  - grid "Messages" [ref=e5]:
    # …
    - row "Priya Natarajan Lunch next week Archive Delete" [ref=e8]:
      # …
      - button "Delete" [ref=e11] [cursor=pointer]
# …`);
});
