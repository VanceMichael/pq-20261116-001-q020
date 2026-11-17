// End-to-end offline verification of the item/item_id link-rule migration.
// Runs entirely against a throw-away SQLite database and synthetic HTML:
//   1. legacy library preview (renames + collisions + opposing reviews)
//   2. activation with conflict quarantine and manual resolution
//   3. interleaved new collection while a collision is unresolved
//   4. rollback that preserves real observations and human decisions
//
// Usage: node --experimental-sqlite scripts/verify-link-rules.js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NewsArchive } from "../src/service/archive.js";

const FEED = {
  feedId: "rolling-local",
  baseUrl: "https://news.example.test/scroll-news/news1.html",
  allowedHosts: ["news.example.test"],
  minimumItems: 3,
  missingThreshold: 3
};
const RULES = { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] };
const STORY = "/2026/11-16/article-3.shtml";

function page(items, marker = "") {
  return `<!doctype html><html><body><main id="news-list" data-batch="${marker}">${items.map((item, index) =>
    `<article><time datetime="2026-11-16T10:0${index}:00+08:00"></time><a href="${item.url}">${item.title}</a></article>`
  ).join("")}</main></body></html>`;
}
const legacy = (id) => ({ url: `/2026/11-16/article-${id}.shtml?item_id=${id}`, title: `旧键${id}` });
const modern = (id) => ({ url: `/2026/11-16/article-${id}.shtml?item=${id}`, title: `新键${id}` });
const at = (second) => `2026-11-16T02:00:${String(second).padStart(2, "0")}.000Z`;

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const directory = await mkdtemp(join(tmpdir(), "link-rules-verify-"));
const archive = new NewsArchive(join(directory, "archive.sqlite"));
try {
  process.stdout.write("== 场景 1：旧库预览（重命名 / 碰撞 / 相反审核） ==\n");
  archive.registerFeed(FEED);
  archive.importSnapshot("rolling-local", page([
    legacy(1), legacy(2),
    { url: `${STORY}?item_id=3`, title: "甲版本" },
    { url: `${STORY}?item=3`, title: "乙版本" }
  ], "legacy-baseline"), at(1));
  const items = archive.listItems("rolling-local").items;
  const jia = items.find((item) => item.title === "甲版本");
  const yi = items.find((item) => item.title === "乙版本");
  archive.reviewArticle("rolling-local", jia.articleId, { state: "confirmed", expectedRevision: 0 });
  archive.reviewArticle("rolling-local", yi.articleId, { state: "withdrawn", expectedRevision: 0 });

  const preview = archive.previewLinkRules("rolling-local", RULES);
  check("预览只读，文章行数不变", preview.storedArticleCount === 4);
  check("识别出安全重命名", preview.renameCount === 2, `${preview.renameCount} 条`);
  check("识别出同键碰撞", preview.collisions.length === 1);
  const collision = preview.collisions[0];
  check("碰撞双方审核相反被标记", collision.reviewConflict &&
    collision.reviewStates.length === 2, collision.reviewStates.join(" / "));
  check("预览不产生身份行", archive.identities.identitiesFor("rolling-local").length === 0);

  process.stdout.write("== 场景 2：安全上线，碰撞进入隔离而非静默合并 ==\n");
  const activated = archive.activateLinkRules("rolling-local", RULES);
  check("激活返回 200 且仅 1 个碰撞", activated.status === 200 && activated.collisionCount === 1);
  const conflicts = archive.listLinkConflicts("rolling-local");
  check("碰撞身份处于 quarantined", conflicts.length === 1 && conflicts[0].members.length === 2);
  check("两套出现历史都保留", conflicts[0].members.every((member) => member.seenCount === 1));
  check("两套审核记录都保留", conflicts[0].members.every((member) =>
    archive.reviewEvents("rolling-local", member.articleId).events.length === 1));

  process.stdout.write("== 场景 3：新采集与未处理碰撞交错，禁止随意覆盖 ==\n");
  const incoming = archive.importSnapshot("rolling-local", page([modern(1), modern(2), modern(3)], "incoming"), at(2));
  check("新页面被接纳", incoming.accepted);
  check("碰撞条目被隔离计数", incoming.quarantinedCount === 1);
  const stillConflicted = archive.listLinkConflicts("rolling-local")[0];
  check("隔离观察被留证", stillConflicted.quarantinedObservations.length === 1);
  check("碰撞双方均未被覆盖", stillConflicted.members.every((member) => member.seenCount === 1));
  const safeOne = archive.articles.get("rolling-local",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  check("非碰撞文章正常累计新观察", safeOne.seenCount === 2);

  process.stdout.write("== 场景 4：人工裁决后恢复采集，回滚不撤销真实历史 ==\n");
  const winner = stillConflicted.members.find((member) => member.title === "乙版本");
  const resolved = archive.resolveLinkConflict("rolling-local", stillConflicted.identityId,
    { primaryArticleId: winner.articleId, reason: "离线验证裁决" });
  check("裁决成功", resolved.status === 200 && archive.listLinkConflicts("rolling-local").length === 0);
  const afterResolve = archive.importSnapshot("rolling-local", page([modern(1), modern(2), modern(3)], "resolved"), at(3));
  check("裁决后不再隔离", afterResolve.quarantinedCount === 0);
  const winnerRow = archive.articles.byId(winner.articleId);
  check("主条目接收新观察并更新标题", winnerRow.seenCount === 2 && winnerRow.title === "新键3");
  const aliasRow = archive.articles.byId(resolved.members.find((m) => m.role === "alias").articleId);
  check("别名条目历史原样保留", aliasRow.seenCount === 1 && aliasRow.title === "甲版本");

  const snapshotEvidence = archive.articleTimeline("rolling-local", safeOne.articleId).observations;
  check("历史快照仍可定位当时来源链接",
    snapshotEvidence.some((o) => o.observedUrl.includes("item_id=1")) &&
    snapshotEvidence.some((o) => o.observedUrl.includes("item=1")));

  const rollback = archive.deactivateLinkRules("rolling-local");
  check("回滚关闭规则且保留身份层", rollback.status === 200 && rollback.retainedIdentityCount === 3);
  const legacyAgain = archive.importSnapshot("rolling-local", page([legacy(1), legacy(2),
    { url: `${STORY}?item_id=3`, title: "回滚后旧键" }], "after-rollback"), at(4));
  check("回滚后旧键采集恢复且无隔离", legacyAgain.accepted && legacyAgain.quarantinedCount === 0);
  check("回滚不撤销新观察", archive.articles.byId(winner.articleId).seenCount === 2);
  check("回滚不撤销人工审核", archive.reviewEvents("rolling-local", jia.articleId).events.length === 1);
  check("审计事件链完整", ["deactivate", "resolve", "activate", "preview"].every((type) =>
    archive.linkRuleEvents("rolling-local", 20).some((event) => event.eventType === type)));
  check("完整性审计一致", archive.auditIntegrity().status === "consistent",
    archive.auditIntegrity().checks.filter((c) => !c.passed).map((c) => c.name).join(",") || "all checks passed");
} finally {
  archive.close();
  await rm(directory, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 项离线验证通过\n`);
if (failed.length) process.exit(1);
