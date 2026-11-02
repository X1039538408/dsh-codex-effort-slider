/**
 * 逐供应商手机截图：用**插件真实渲染的 DOM** + 真实 CSS，交真浏览器排版。
 *
 * 与之前手搓 HTML 的区别：DOM 来自 ProviderSlider/CodexEffortSlider 的真渲染，
 * 宽度取自插件桥自报的 availableBandWidth —— 不再由脚本另算一份。
 *
 * 用法：node test/shots.mjs [输出目录]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument, createFakeHost, createOfficialMenu, loadBundle, settle } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || join(tmpdir(), "ces-shots");
mkdirSync(OUT, { recursive: true });

/* 真机 9 家供应商 */
const PROVIDERS = [
  { name: "DeepSeek Account", models: ["DeepSeek V4.1 Flash", "DeepSeek V4 Pro"] },
  { name: "DeepSeek", models: ["DeepSeek V4.1 Flash", "DeepSeek V4 Pro", "DeepSeek R1"] },
  { name: "minimax-cn", models: ["MiniMax M2.7", "MiniMax M2.7 highspeed", "MiniMax M3"] },
  { name: "Pixel Codex", models: ["GPT-6.1 Sol", "GPT-6 Astra", "GPT-6 Luna"] },
  { name: "WOYAO · Claude", models: ["Claude Sonnet 4", "Claude Opus 4"] },
  { name: "WOYAO · GPT", models: ["GPT-6.1 Sol", "GPT-6 Astra"] },
  { name: "WOYAO · 通用", models: ["Gemini 3.8 Flash High", "Gemini 4 Argon", "Grok 4.7", "GLM 5.3", "GLM 5.3-pro", "DeepSeek V4.1 Flash (1017)", "DeepSeek V4 Pro", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "Kimi K3.1 Pro", "Kimi K2.8 Preview", "MiMo V2", "MiMo V2.5", "MiniMax M2.7", "Hunyuan V4", "Hunyuan V4 Pro", "GLM 5.3 Vision", "GPT-Reserve (Experimental)", "MiMo V2 Flash"] },
  { name: "ChatGPT subscription", models: ["ChatGPT Subscription"] },
  { name: "Kimi subscription", models: ["Kimi K3.1 Pro", "Kimi K3.1 Pro Highspeed", "Kimi K3", "Kimi K3-256K", "Kimi K2.8 Preview", "Kimi K2.7 Code Highspeed"] },
];

const GROUPS = PROVIDERS.map((p, gi) => ({
  id: "p" + gi,
  name: p.name,
  models: p.models.map((name, mi) => ({ id: "p" + gi + "-m" + mi, name })),
}));

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serialize(node) {
  if (node.nodeType === 3) return escapeHtml(node.textContent);
  const tag = node.tagName.toLowerCase();
  const attrs = [];
  if (node.className) attrs.push('class="' + escapeHtml(node.className) + '"');
  for (const [k, v] of node.attributes) {
    if (k === "class") continue;
    attrs.push(k + '="' + escapeHtml(String(v)) + '"');
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
  if (styleText) attrs.push('style="' + escapeHtml(styleText) + '"');
  const body = node.children.map(serialize).join("");
  return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + body + "</" + tag + ">";
}

async function render(provider, screen) {
  const document = createDocument();
  const menu = createOfficialMenu(document, {});
  if (menu.menu) menu.menu.rect = { left: 0, top: 0, right: screen.hostWidth, bottom: 300, width: screen.hostWidth, height: 300 };
  const bundle = loadBundle(BUNDLE, document, {});
  bundle.window.innerWidth = screen.viewport;
  bundle.window.innerHeight = 800;
  const target = GROUPS.find((g) => g.name === provider.name) || GROUPS[0];
  const snapshot = () => ({
    current: { provider: target.id, model: target.models[0].id },
    groups: GROUPS,
    status: "ready",
    failures: [],
    pending: null,
    error: null,
  });
  const host = createFakeHost({ snapshot: snapshot() });
  bundle.plugin.apply(host.ctx);
  bundle.react.mount(host.registered[0].Component, { sessionId: "session-abcdef" }, menu.composer);
  await settle();

  let width = 0;
  try {
    const b = bundle.window.__cesBridge;
    if (b && typeof b.availableBandWidth === "function") width = b.availableBandWidth();
  } catch (e) { width = 0; }

  const providerColumn = document.body.querySelector('div[data-ces-part="provider-column"]');
  const modelHost = document.body.querySelector('div[data-ces-part="model-host"]');
  const layout = providerColumn ? providerColumn.getAttribute("data-layout") : null;
  return {
    css: Array.isArray(bundle.plugin.__internals.CSS) ? bundle.plugin.__internals.CSS.join("\n") : String(bundle.plugin.__internals.CSS),
    providerHtml: providerColumn ? serialize(providerColumn) : "",
    modelHtml: modelHost ? serialize(modelHost) : "",
    layout,
    width,
  };
}

function page(r, screen) {
  const stacked = r.layout === "stacked";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;background:#eef0f4;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.stage{padding:12px;box-sizing:border-box}
.menu{background:#fff;border-radius:14px;padding:10px;box-sizing:border-box;display:flex;
  flex-direction:${stacked ? "column" : "row"};align-items:stretch;
  width:${stacked ? screen.hostWidth + 20 : r.width + 240}px}
.menu-left{${stacked ? "width:100%;" : "flex:none;width:" + r.width + "px;"}}
.menu-side{${stacked ? "width:100%;" : "flex:none;width:220px;"}}
body{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f5f5;--dsw-alias-bg-layer-3:#fff;--dsw-menu-surface-fill:#f8f9fa94;--dsw-alias-border-l1:rgb(15 17 21 / 8%);--dsw-alias-border-l2:#0000001a;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#65676b;--dsw-alias-label-tertiary:#81858c;--dsw-alias-label-caption:#a2a4a6;--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-state-business-primary:#4d93f8;--dsw-alias-menu-icon:#979da6;--dsw-radius-md:12px;--dsw-radius-lg:16px;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#4d93f8;color-scheme:light}
${r.css}
</style></head>
<body><div class="stage"><div class="menu"><div class="menu-left">${r.modelHtml}</div><div class="menu-side">${r.providerHtml}</div></div></div></body></html>`;
}

const PHONE = { key: "phone", viewport: 390, hostWidth: 330 };
const dir = mkdtempSync(join(tmpdir(), "ces-shots-"));
for (let i = 0; i < PROVIDERS.length; i += 1) {
  const p = PROVIDERS[i];
  const r = await render(p, PHONE);
  const file = join(dir, "shot" + i + ".html");
  writeFileSync(file, page(r, PHONE), "utf8");
  const png = join(OUT, "phone-" + i + "-" + p.name.replace(/[^\w]+/g, "_") + ".png");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--window-size=390,700", "--screenshot=" + png, "file:///" + file.split("\\").join("/")],
    { stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
  console.log("  [" + i + "] " + p.name + " → " + png + "（宽度 " + r.width + " / " + r.layout + "）");
}
console.log("\n输出目录：" + OUT);
