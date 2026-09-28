import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, obsidian } from "./harness.mjs";

const { NoticeLimiter } = loadModule("src/noticeLimiter.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a notice inside the interval is shown when the interval ends, not dropped", async () => {
  // Up to 0.2.0 a sync failure within 60 s of another notice was never shown.
  const n0 = obsidian.Notice.shown.length;
  const limiter = new NoticeLimiter(40);
  limiter.show("first");
  limiter.show("second");
  limiter.show("third");
  assert.deepEqual(obsidian.Notice.shown.slice(n0), ["first"]);
  await wait(80);
  assert.deepEqual(obsidian.Notice.shown.slice(n0), ["first", "third (suppressed 1)"]);
  limiter.dispose();
});

test("dispose cancels a notice still waiting for its interval", async () => {
  const n0 = obsidian.Notice.shown.length;
  const limiter = new NoticeLimiter(40);
  limiter.show("first");
  limiter.show("second");
  limiter.dispose();
  await wait(80);
  assert.deepEqual(obsidian.Notice.shown.slice(n0), ["first"]);
});
