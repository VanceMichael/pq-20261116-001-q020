import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, normalizeCandidates } from "../../src/feed/normalize.js";
import { normalizeLinkRules, applyLinkRules, previewUrlGroups, DEFAULT_CANONICAL_KEY } from "../../src/feed/link-rules.js";

const baseUrl = "https://news.example.test/scroll-news/news1.html";
const enabled = { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] };

test("disabled rules leave item and item_id parameters completely untouched", () => {
  const rules = { enabled: false };
  assert.equal(
    canonicalizeUrl("/story.shtml?item_id=7&page=2", baseUrl, [], rules),
    "https://news.example.test/story.shtml?item_id=7&page=2"
  );
});

test("unconfigured feeds keep the legacy canonicalization without an identity rewrite", () => {
  assert.equal(
    canonicalizeUrl("/story.shtml?item_id=7", baseUrl),
    "https://news.example.test/story.shtml?item_id=7"
  );
});

test("renames item_id to the canonical item key for an enabled feed", () => {
  assert.equal(
    canonicalizeUrl("/story.shtml?item_id=42", baseUrl, [], enabled),
    "https://news.example.test/story.shtml?item=42"
  );
});

test("accepts an already canonical item key and keeps its value", () => {
  assert.equal(
    canonicalizeUrl("/story.shtml?item=42&from=app", baseUrl, [], enabled),
    "https://news.example.test/story.shtml?item=42"
  );
});

test("tracking parameters are still stripped before the identity rule runs", () => {
  assert.equal(
    canonicalizeUrl("/story.shtml?item_id=9&utm_source=push&spm=a1b2&ref=home", baseUrl, [], enabled),
    "https://news.example.test/story.shtml?item=9"
  );
});

test("collapses item_id and item carrying the same business number into one key", () => {
  assert.equal(
    canonicalizeUrl("/story.shtml?item_id=5&item=5", baseUrl, [], enabled),
    "https://news.example.test/story.shtml?item=5"
  );
});

test("refuses to pick a side when item and item_id carry different numbers", () => {
  assert.throws(
    () => canonicalizeUrl("/story.shtml?item_id=5&item=6", baseUrl, [], enabled),
    /competing business numbers 5 vs 6/
  );
});

test("rejects a repeated alias with conflicting values instead of choosing one", () => {
  assert.throws(() => applyLinkRules(new URL("https://h.test/a.shtml?item_id=1&item_id=2"), enabled), /competing/);
});

test("supports custom canonical and alias key names per feed", () => {
  const custom = { enabled: true, canonicalKey: "doc", aliasKeys: ["docid", "doc_id"] };
  assert.equal(
    canonicalizeUrl("/paper.shtml?docid=88&doc_id=88", baseUrl, [], custom),
    "https://news.example.test/paper.shtml?doc=88"
  );
});

test("validates rule configuration before it can affect any URL", () => {
  assert.throws(() => normalizeLinkRules({ enabled: true, canonicalKey: "bad key" }), /canonicalKey/);
  assert.throws(() => normalizeLinkRules({ enabled: true, canonicalKey: "item", aliasKeys: ["item"] }), /must not contain/);
  assert.throws(() => normalizeLinkRules({ enabled: true, aliasKeys: "item_id" }), /aliasKeys/);
  assert.equal(normalizeLinkRules().canonicalKey, DEFAULT_CANONICAL_KEY);
});

test("normalizeCandidates routes conflicting pages to rejected without a stored record", () => {
  const result = normalizeCandidates([
    { href: "/good.shtml?item_id=1", title: "正常稿件" },
    { href: "/bad.shtml?item_id=2&item=3", title: "冲突稿件" },
    { href: "/other.shtml?item_id=4", title: "另一条稿件" }
  ], { baseUrl, linkRules: enabled });
  assert.equal(result.records.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /competing business numbers/);
});

test("normalizeCandidates keeps a pre-rule observed URL alongside the canonical URL", () => {
  const result = normalizeCandidates([
    { href: "/story.shtml?item_id=7&utm_source=x", title: "留证稿件" }
  ], { baseUrl, linkRules: enabled });
  assert.equal(result.records[0].canonicalUrl, "https://news.example.test/story.shtml?item=7");
  assert.equal(result.records[0].observedUrl, "https://news.example.test/story.shtml?item_id=7");
});

test("preview groups safe renames separately from many-to-one collisions", () => {
  const preview = previewUrlGroups([
    "https://h.test/a.shtml?item_id=1",
    "https://h.test/b.shtml?item_id=2",
    "https://h.test/c.shtml?item_id=3",
    "https://h.test/c.shtml?item=3"
  ], enabled);
  assert.equal(preview.unchanged, 0);
  assert.equal(preview.renames.length, 2);
  assert.equal(preview.collisions.length, 1);
  assert.deepEqual(preview.collisions[0].sourceUrls, [
    "https://h.test/c.shtml?item=3",
    "https://h.test/c.shtml?item_id=3"
  ]);
  assert.equal(preview.collisions[0].targetUrl, "https://h.test/c.shtml?item=3");
});

test("preview reports unchanged URLs and surfaces intra-url conflicts without dropping them silently", () => {
  const preview = previewUrlGroups([
    "https://h.test/keep.shtml?item=1",
    "https://h.test/clash.shtml?item=2&item_id=9"
  ], enabled);
  assert.equal(preview.unchanged, 1);
  assert.equal(preview.collisions.length, 0);
  assert.equal(preview.conflicts.length, 1);
  assert.match(preview.conflicts[0].reason, /competing/);
});
