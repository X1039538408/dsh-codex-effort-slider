import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument, createFakeHost, createOfficialMenu, loadBundle, settle } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/**
 * 验证「供应商装不下时能滑动」。
 * 造 20 家供应商（远超手机上一屏能放下的数量），检查：
 *   1) 供应商列表确实溢出
 *   2) 溢出时容器可纵向滚动（scrollHeight > clientHeight 且 overflow-y 可滚）
 *   3) 最后一家能滚到（scrollTop 拉到底时它的底部落在容器内）
 */
const MANY = Array.from({ length: 20 }, (_, i) => ({
  id: "p" + i,
  name: "Provider " + String(i + 1).padStart(2, "0"),
  models: [{ id: "p" + i + "-m0", name: "Model A" }, { id: "p" + i + "-m1", name: "Model B" }],
}));

const document = createDocument();
const menu = createOfficialMenu(document, {});
menu.menu.rect = { left: 0, top: 0, right: 330, bottom: 300, width: 330, height: 300 };
const bundle = loadBundle(BUNDLE, document, {});
bundle.window.innerWidth = 390;
bundle.window.innerHeight = 800;
const snap = { current: { provider: "p0", model: "p0-m0" }, groups: MANY, status: "ready", failures: [], pending: null, error: null };
const host = createFakeHost({ snapshot: snap });
bundle.plugin.apply(host.ctx);
bundle.react.mount(host.registered[0].Component, { sessionId: "session-abcdef" }, menu.composer);
await settle();

const css = Array.isArray(bundle.plugin.__internals.CSS)
  ? bundle.plugin.__internals.CSS.join("\n")
  : String(bundle.plugin.__internals.CSS);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function serialize(node) {
  if (node.nodeType === 3) return esc(node.textContent);
  const tag = node.tagName.toLowerCase();
  const attrs = [];
  if (node.className) attrs.push('class="' + esc(node.className) + '"');
  for (const [k, v] of node.attributes) {
    if (k === "class") continue;
    attrs.push(k + '="' + esc(String(v)) + '"');
  }
  let styleText = "";
  if (node.style && typeof node.style === "object") {
    const parts = [];
    for (const k of Object.keys(node.style)) {
      const v = node.style[k];
      if (v === undefined || v === null || v === "") continue;
      const cssKey = k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      parts.push(cssKey + ":" + v);
    }
    if (parts.length) styleText = parts.join(";");
  }
  if (styleText) attrs.push('style="' + esc(styleText) + '"');
  return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + node.children.map(serialize).join("") + "</" + tag + ">";
}

const col = document.body.querySelector('div[data-ces-part="provider-column"]');
const providerHtml = col ? serialize(col) : "";

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.menu{width:350px;padding:10px;box-sizing:border-box;background:#fff}
body{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f5f5;--dsw-alias-bg-layer-3:#fff;--dsw-menu-surface-fill:#f8f9fa94;--dsw-alias-border-l1:rgb(15 17 21 / 8%);--dsw-alias-border-l2:#0000001a;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#65676b;--dsw-alias-label-tertiary:#81858c;--dsw-alias-label-caption:#a2a4a6;--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-state-business-primary:#4d93f8;--dsw-alias-menu-icon:#979da6;--dsw-radius-md:12px;--dsw-radius-lg:16px;color-scheme:light}
${css}
</style></head>
<body><div class="menu">${providerHtml}</div>
<script>
window.__probe = function () {
  var body = document.querySelector(".ces-provider-sidebar__body");
  var list = document.querySelector(".ces-provider-list");
  var labels = document.querySelectorAll(".ces-provider-list .ces-named-label");
  if (!body) return { error: "no body" };
  var cs = getComputedStyle(body);
  var result = {
    total: labels.length,
    scrollH: body.scrollHeight,
    clientH: body.clientHeight,
    scrollable: body.scrollHeight > body.clientHeight + 1,
    overflowY: cs.overflowY,
    maxH: cs.maxHeight
  };
  /* 滚到底，看最后一家是否落在容器可视区内 */
  body.scrollTop = body.scrollHeight;
  var last = labels[labels.length - 1];
  var br = body.getBoundingClientRect();
  var lr = last.getBoundingClientRect();
  result.lastVisibleAfterScroll = lr.bottom <= br.bottom + 1 && lr.top >= br.top - 1;
  result.lastText = (last.textContent || "").slice(0, 20);
  result.afterScrollTop = body.scrollTop;
  return result;
};
<\/script>
<script>document.title = JSON.stringify(window.__probe());<\/script>
</body></html>`;

const dir = mkdtempSync(join(tmpdir(), "ces-scroll-"));
const file = join(dir, "p.html");
writeFileSync(file, page, "utf8");
const dom = execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000", "--dump-dom", "file:///" + file.split("\\").join("/")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const m = dom.match(/<title>([\s\S]*?)<\/title>/);
const r = JSON.parse(m[1].replace(/&quot;/g, '"'));

console.log("供应商装不下时能否滑动：");
console.log("  供应商数量        " + r.total);
console.log("  内容高 / 可视高   " + r.scrollH + " / " + r.clientH + " px");
console.log("  overflow-y        " + r.overflowY);
console.log("  max-height        " + r.maxH);
console.log("  可滚动            " + (r.scrollable ? "是" : "否"));
console.log("  滚到底后末家可见  " + (r.lastVisibleAfterScroll ? "是（" + r.lastText + "）" : "否（" + r.lastText + "）"));

const ok = r.scrollable && r.overflowY !== "visible" && r.lastVisibleAfterScroll;
console.log("\n" + (ok ? "✅ 装不下时可滑动，且能滚到最后一家" : "❌ 装不下时无法完整到达最后一家"));
process.exit(ok ? 0 : 1);
