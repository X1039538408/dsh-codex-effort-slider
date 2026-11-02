/**
 * 端到端视觉回归：让**插件自己的渲染函数**产出 DOM，再交给真浏览器排版。
 *
 * 与旧版 visual.test.mjs 的根本区别：
 *   旧版 —— 测试脚本里**自己重写了一遍**宽度计算与 label 生成，
 *           等于「用我算的结果验证我算的结果」，插件算错了也照样全绿。
 *   本版 —— 调 `loadBundle` 加载**真产物**，把 `ProviderSlider` / `CodexEffortSlider`
 *           真的挂进假宿主渲染一遍，**从插件产出的 DOM 里**读出
 *           data-stagger / data-band / data-edge / --ces-cap / --ces-count 等真实决策，
 *           原样序列化成 HTML，再让 Edge 用真实 CSS 引擎排版并测量。
 *           插件决策错了 → 浏览器里就会重叠/裁切 → 测试失败。
 *
 * 覆盖：9 家真实供应商 × 手机/桌面视口，逐个断言：
 *   名字不重叠、不越界、不竖排、菜单不宽出视口、供应商栏可达。
 *
 * 用法：node test/render.test.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDocument, createFakeHost, createOfficialMenu, loadBundle, settle } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/* ── 用户真机上的 9 家供应商（模型清单来自实际配置）── */
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

/* 屏幕档位：手机 / 桌面。hostWidth 取真机上测到的官方内容宽。 */
const SCREENS = [
  { key: "phone", label: "手机 390", viewport: 390, hostWidth: 330 },
  { key: "phone-narrow", label: "手机 360", viewport: 360, hostWidth: 300 },
  { key: "desktop", label: "桌面 1440", viewport: 1440, hostWidth: 620 },
];

/* ── 从插件真实渲染结果里抽取布局决策 ── */

function attrsOf(node) {
  const out = {};
  for (const [k, v] of node.attributes) out[k] = v;
  return out;
}

function serialize(node) {
  if (node.nodeType === 3) return escapeHtml(node.textContent);
  const tag = node.tagName.toLowerCase();
  const attrs = [];
  for (const [k, v] of node.attributes) {
    // style 对象形式（React 桩会把对象摊平到 attributes? 不会，单独处理）
    attrs.push(k + '="' + escapeHtml(String(v)) + '"');
  }
  let styleText = "";
  if (node.style && typeof node.style === "object") {
    const parts = [];
    for (const k of Object.keys(node.style)) {
      const v = node.style[k];
      if (v === undefined || v === null || v === "") continue;
      // 自定义属性（--x）原样保留；只把 camelCase 转 kebab-case。
      const cssKey = k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      parts.push(cssKey + ":" + v);
    }
    if (parts.length) styleText = parts.join(";");
  }
  if (styleText) attrs.push('style="' + escapeHtml(styleText) + '"');
  if (node.className) attrs.unshift('class="' + escapeHtml(node.className) + '"');
  const body = node.children.map(serialize).join("");
  return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + body + "</" + tag + ">";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 把插件渲染出的 provider-column 子树序列化（这就是真机上会出现的 DOM）。 */
function serializeProviderColumn(menuCtx) {
  const column = menuCtx.menu.querySelector('div[data-ces-part="provider-column"]');
  if (!column) throw new Error("插件没有渲染供应商栏");
  return { html: serialize(column), layout: column.getAttribute("data-layout") };
}

/**
 * 从插件渲染的 DOM 反推它认为的「可用宽度」。
 *
 * 依据：渲染层用 layoutWidth 算 --ces-cap（交错模式中间档 capRatio=2）：
 *   layoutWidth = max(可用宽度, count * NAMED_MIN_CELL)
 *   cap = floor(layoutWidth / count * 2 - GAP)
 * 于是 layoutWidth = (cap + GAP) * count / 2，可用宽度 = layoutWidth（>= 下限时）。
 * 拿不到就返回 0 —— 让页面塌成窄条，测试必须失败，而不是悄悄用回退值蒙混过关。
 */
/** 把插件渲染出的模型名区子树序列化。 */
function serializeModelSection(document) {
  // ⚠️ 模型名区挂在 composer 的 anchor 上（portal 渲染），**不在菜单子树里**。
  // 之前用 menu.querySelector 找，一个都找不到 —— 于是它的几何从未被检查过。
  const section = document.body.querySelector('div[data-ces-part="model-host"]')
    || document.body.querySelector('div.ces-model-host');
  if (!section) throw new Error("插件没有渲染模型名区");
  return serialize(section);
}

/* ── 逐个供应商挂载真插件 ── */

async function renderProvider(provider, screen) {
  const document = createDocument();
  // ⚠️ 必须把**全部 9 家**都给进 groups：插件在「只有 1 家供应商」时按设计
  // 不注入供应商栏（没必要给单一选项做滑轨）。之前只塞了 1 家，
  // 于是拿到的 DOM 是空的 —— 这本身也是个真实的行为约束，值得记住。
  const groups = PROVIDERS.map((p, gi) => ({
    id: "prov" + gi,
    name: p.name,
    models: p.models.map((name, mi) => ({ id: "prov" + gi + "-m" + mi, name })),
  }));
  const targetGroup = groups.find((g) => g.name === provider.name) || groups[0];
  const menu = createOfficialMenu(document, {});
  const snapshot = () => ({
    current: { provider: targetGroup.id, model: targetGroup.models[0].id },
    groups,
    status: "ready",
    failures: [],
    pending: null,
    error: null,
  });
  // 给官方菜单真实几何：这就是「官方原始内容宽」，插件据此算可用宽度
  if (menu.menu) menu.menu.rect = { left: 0, top: 0, right: screen.hostWidth, bottom: 300, width: screen.hostWidth, height: 300 };
  const bundle = loadBundle(BUNDLE, document, {});
  bundle.window.innerWidth = screen.viewport;
  bundle.window.innerHeight = 800;
  const host = createFakeHost({ snapshot: snapshot() });
  bundle.plugin.apply(host.ctx);
  const entry = host.registered[0];
  bundle.react.mount(entry.Component, { sessionId: "session-abcdef" }, menu.composer);
  await settle();
  /* 问插件本身：它此刻认为可用宽度是多少？
     ⚠️ 绝不能在这里自己重算 —— 之前用 bandExtraFor 重算，等于
     「用我的算法验证我的算法」，把 availableBandWidth 改成恒返回 0 都测不出来（实测）。
     这里读的是插件正在用的那个值，它错 → 页面就跟着错 → 几何断言才会失败。 */
  let bridgeWidth = 0;
  try {
    const b = bundle.window.__cesBridge;
    if (b && typeof b.availableBandWidth === "function") bridgeWidth = b.availableBandWidth();
  } catch (e) { bridgeWidth = 0; }
  if (process.env.CES_TRACE === "1") {
    console.log("    [trace] " + provider.name + " 反推宽度=" + bridgeWidth
      + " rect=" + JSON.stringify(menu.menu.rect) + " hostWidth=" + screen.hostWidth);
  }
  return { document, menu, bundle, host, bridgeWidth };
}

/* ── 浏览器侧探针：读真实排版几何 ── */

function probeScript() {
  return `
window.__probe = function () {
  var col = document.querySelector(".ces-provider-column");
  var labels = col ? col.querySelectorAll(".ces-named-label") : [];
  var out = [];
  for (var i = 0; i < labels.length; i += 1) {
    var el = labels[i], r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    var cs = getComputedStyle(el);
    out.push({
      i: i, text: (el.textContent || "").slice(0, 40),
      x: Math.round(r.x*10)/10, y: Math.round(r.y*10)/10,
      w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10,
      right: Math.round(r.right*10)/10, bottom: Math.round(r.bottom*10)/10,
      lineHeight: parseFloat(cs.lineHeight) || 0,
      fontSize: parseFloat(cs.fontSize) || 0,
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      whiteSpace: cs.whiteSpace
    });
  }
  var mlabels = document.querySelectorAll(".ces-model-host .ces-named-label");
  var mout = [];
  for (var mi = 0; mi < mlabels.length; mi += 1) {
    var me = mlabels[mi], mr = me.getBoundingClientRect(), mcs = getComputedStyle(me);
    if (mr.width <= 0 && mr.height <= 0) continue;
    mout.push({
      i: mi,
      idx: me.getAttribute("data-index"),
      band: me.getAttribute("data-band"),
      text: (me.textContent || "").slice(0, 30),
      x: Math.round(mr.x*10)/10, y: Math.round(mr.y*10)/10,
      w: Math.round(mr.width*10)/10, h: Math.round(mr.height*10)/10,
      right: Math.round(mr.right*10)/10,
      scrollW: me.scrollWidth, clientW: me.clientWidth,
      scrollH: me.scrollHeight, clientH: me.clientHeight
    });
  }
  var mcontent = document.querySelector(".ces-named-content");
  if (mcontent) { console.log("DEBUG content style", mcontent.getAttribute("style"), "csMinW", getComputedStyle(mcontent).minWidth, "countProp", getComputedStyle(mcontent).getPropertyValue("--ces-count")); }
  var menu = document.querySelector(".ces-provider-column");
  var colBox = menu ? menu.getBoundingClientRect() : null;
  var list = document.querySelector(".ces-provider-list");
  var body = document.querySelector(".ces-provider-sidebar__body");
  return {
    viewport: window.innerWidth,
    total: labels.length,
    labels: out,
    modelLabels: mout,
    modelStagger: mcontent ? mcontent.getAttribute("data-stagger") : null,
    modelContentW: mcontent ? Math.round(mcontent.getBoundingClientRect().width*10)/10 : null,
    modelSectionW: (function(){var s=document.querySelector(".ces-named-section");return s?Math.round(s.getBoundingClientRect().width*10)/10:null;})(),
    modelSectionLeft: (function(){var s=document.querySelector(".ces-named-section");return s?Math.round(s.getBoundingClientRect().left*10)/10:null;})(),
    viewportScrollW: (function(){var v=document.querySelector(".ces-named-viewport");return v?v.scrollWidth:0;})(),
    viewportClientW: (function(){var v=document.querySelector(".ces-named-viewport");return v?v.clientWidth:0;})(),
    modelContentScrollW: mcontent ? mcontent.scrollWidth : null,
    modelViewportW: (function(){ var v=document.querySelector(".ces-named-viewport"); return v?Math.round(v.getBoundingClientRect().width*10)/10:null; })(),
    modelScrollRail: mcontent ? mcontent.getAttribute("data-scroll-rail") : null,
    colBottom: colBox ? Math.round(colBox.bottom*10)/10 : null,
    menuScrollH: (function(){var m=document.querySelector(".menu");return m?m.scrollHeight:0;})(),
    menuClientH: (function(){var m=document.querySelector(".menu");return m?m.clientHeight:0;})(),
    listScrollH: list ? list.scrollHeight : 0,
    listClientH: list ? list.clientHeight : 0,
    bodyScrollH: body ? body.scrollHeight : 0,
    bodyClientH: body ? body.clientHeight : 0
  };
};
window.__done = false;
window.__run = function () {
  window.__result = window.__probe();
  window.__done = true;
};
setTimeout(window.__run, 30);
`;
}

function browserProbe(html) {
  const dir = mkdtempSync(join(tmpdir(), "ces-render-"));
  const file = join(dir, "page.html");
  writeFileSync(file, html, "utf8");
  const dom = execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000", "--dump-dom", "file:///" + file.replace(/\\/g, "/")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
  const m = dom.match(/<title>([\s\S]*?)<\/title>/);
  if (!m) throw new Error("没有取到探针结果");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

/* ── 组装页面：真插件 DOM + 真插件 CSS ── */

function buildPage(pluginHtml, layout, screen, css, modelHtml, bandWidth) {
  const stacked = layout === "stacked";
  /* ⚠️ 必须复刻真机的**两栏骨架**：左栏 = 官方内容宽（模型名区在里面），
     右栏 = 供应商栏 220px。之前把模型区直接铺在整条菜单上，
     它当然够宽 —— 于是「名字超出视口 / 内容宽于盒宽」的判定全是假象。 */
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.stage{padding:0;box-sizing:border-box}
/* 真机骨架：菜单总宽 = 左栏(官方内容宽+名带加宽) + 右栏(220) + 左右内距 20。
   左栏宽度必须等于插件算出的 availableBandWidth，否则名字的百分比定位基准
   与容器宽不一致 —— 那会造出「名字超出视口」的假象（我踩过一次）。 */
.menu{background:#fff;border-radius:14px;padding:10px;box-sizing:border-box;
  display:flex;flex-direction:${stacked ? "column" : "row"};align-items:stretch;
  ${stacked ? "width:" + (screen.hostWidth + 20) + "px"
            : "width:" + (bandWidth + 220 + 20) + "px"}}
.menu-left{${stacked ? "width:100%;" : "flex:none;width:" + bandWidth + "px;"}}
.menu-side{${stacked ? "width:100%;" : "flex:none;width:220px;"}}
body{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f5f5;--dsw-alias-bg-layer-3:#fff;--dsw-menu-surface-fill:#f8f9fa94;--dsw-alias-border-l1:rgb(15 17 21 / 8%);--dsw-alias-border-l2:#0000001a;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#65676b;--dsw-alias-label-tertiary:#81858c;--dsw-alias-label-caption:#a2a4a6;--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-state-business-primary:#4d93f8;--dsw-alias-menu-icon:#979da6;--dsw-radius-md:12px;--dsw-radius-lg:16px;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#4d93f8;color-scheme:light}
${css}
</style></head>
<body><div class="stage"><div class="menu"><div class="menu-left">${modelHtml || ""}</div><div class="menu-side">${pluginHtml}</div></div></div>
<script>${probeScript()}<\/script>
<script>
window.__run();
var mc = document.querySelector(".ces-named-content");
var dbg = mc ? {
  styleAttr: mc.getAttribute("style"),
  minWidth: getComputedStyle(mc).minWidth,
  countProp: getComputedStyle(mc).getPropertyValue("--ces-count"),
  width: getComputedStyle(mc).width,
  display: getComputedStyle(mc).display
} : null;
document.title = JSON.stringify(Object.assign({}, window.__result || {error:"no result"}, {dbg: dbg}));
<\/script>
</body></html>`;
}

/* ── 主流程 ── */

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log("    FAIL " + label + (detail ? " — " + detail : ""));
}

console.log("端到端视觉回归（插件真渲染 → 真浏览器排版）");
console.log(PROVIDERS.length + " 家供应商 × " + SCREENS.length + " 种屏幕\n");

let cssCache = null;
for (const screen of SCREENS) {
  console.log("=== " + screen.label + "（视口 " + screen.viewport + " / 官方内容宽 " + screen.hostWidth + "）===");
  for (const provider of PROVIDERS) {
    const before = failures;
    let rendered;
    try {
      rendered = await renderProvider(provider, screen);
    } catch (e) {
      failures += 1;
      console.log("  FAIL " + provider.name + "：渲染失败 " + String(e.message || e).slice(0, 120));
      continue;
    }
    const rawCss = rendered.bundle.plugin.__internals.CSS;
    const css = Array.isArray(rawCss) ? rawCss.join("\n") : String(rawCss);
    if (cssCache === null) cssCache = css;
    const col = serializeProviderColumn(rendered.menu);
    const modelHtml = serializeModelSection(rendered.document);
    /* ⚠️ 宽度必须**取自插件自己算出来的值**，绝不能在测试里再算一遍。
       之前这里用 bandExtraFor 自己重算，等于「用我的算法验证我的算法」：
       把插件的 availableBandWidth 改成恒返回 0，测试照样全绿（实测）。
       现在直接问桥要它正在用的那个值 —— 它返回 0 或算错，页面就会跟着错，
       浏览器的几何断言才有可能失败。 */
    /* liveWidth = 插件自己认为的可用宽度；-1 表示「单层模式，宽窄都不影响排版」。
       单层时用官方内容宽即可（插件在单层下也不再依赖精确值）。 */
    const liveWidth = rendered.bridgeWidth;
    if (process.env.CES_DEBUG === "1" && provider.name.includes("Kimi")) {
      const dbgLabels = rendered.document.body.querySelector('div[data-ces-part="model-host"]')?.querySelectorAll('.ces-named-label') ?? [];
      console.log("    [dbg] layout=" + col.layout + " count=" + dbgLabels.length);
      for (const el of dbgLabels) {
        console.log("      idx=" + el.getAttribute("data-index") + " edge=" + el.getAttribute("data-edge")
          + " band=" + el.getAttribute("data-band")
          + " style=" + JSON.stringify(el.style));
      }
    }
    const page = buildPage(col.html, col.layout, screen, css, modelHtml, liveWidth);
    if (process.env.CES_DUMP === "1" && provider.models.length >= 20) {
      const dumpPath = join(tmpdir(), "ces-dump-" + screen.key + ".html");
      writeFileSync(dumpPath, page, "utf8");
      console.log("    [dump] " + dumpPath);
    }
    let result;
    try {
      result = browserProbe(page);
    } catch (e) {
      failures += 1;
      console.log("  FAIL " + provider.name + "：浏览器排版失败 " + String(e.message || e).slice(0, 120));
      continue;
    }
    check(provider.name + "：供应商全部渲染", result.total === PROVIDERS.length,
      "实际 " + result.total);

    // 名字不能被压成竖排 / 折行
    let squeezed = null;
    for (const l of result.labels) {
      // 宽度：被挤成竖排时宽度会塌到十几像素
      if (l.w < 40) { squeezed = "第 " + l.i + " 家宽仅 " + l.w + "px（被挤压）"; break; }
      // 高度：固定行高是设计（22px 盒 + 12px 行高），要看的是**文本有没有被裁**，
      // 而不是盒子比行高。折行/竖排会让内容高度超过盒子 → scrollH > clientH。
      if (l.scrollH > l.clientH + 1) {
        squeezed = "第 " + l.i + " 家内容高 " + l.scrollH + " > 盒高 " + l.clientH + "（文本溢出/折行）";
        break;
      }
      if (l.scrollW > l.clientW + 1) { squeezed = "第 " + l.i + " 家内容宽 " + l.scrollW + " > 盒宽 " + l.clientW; break; }
    }
    check(provider.name + "：名字未被挤压/裁切", squeezed === null, squeezed || "");

    // 名字右边界不能超出列
    let overflow = null;
    for (const l of result.labels) {
      if (l.right > result.viewport + 1) { overflow = "第 " + l.i + " 家右边 " + l.right + " > 视口 " + result.viewport; break; }
    }
    check(provider.name + "：名字不超出视口", overflow === null, overflow || "");

    /* 供应商栏可达：不是「没溢出」就算过 —— 名字被压扁时也不溢出。
       要求每家名字都有正常高度（没被压成薄条）**且**最后一家能到达
       （要么全部装下，要么容器/菜单能滚到它）。 */
    const allFit = result.bodyScrollH <= result.bodyClientH + 1;
    const canScrollBody = result.bodyScrollH > result.bodyClientH + 1;
    const canScrollMenu = result.menuScrollH > result.menuClientH + 1;
    const lastProvider = result.labels[result.labels.length - 1];
    /* 名字行高：被压扁时会明显低于正常一行（12px 行高 + padding ≈ 22px） */
    let squashedProvider = null;
    for (const l of result.labels) {
      if (l.h < 14) { squashedProvider = "第 " + l.i + " 家高仅 " + l.h + "px（被压扁）"; break; }
    }
    check(provider.name + "：供应商栏不被压扁", squashedProvider === null, squashedProvider || "");
    check(provider.name + "：供应商栏可达", allFit || canScrollBody || canScrollMenu,
      "body " + result.bodyScrollH + "/" + result.bodyClientH
      + " menu " + result.menuScrollH + "/" + result.menuClientH
      + (lastProvider ? " 末家底 " + lastProvider.bottom : ""));

    /* ── 模型名区：这才是可用宽度真正影响的地方 ── */
    check(provider.name + "：模型名全部渲染",
      result.modelLabels.length === provider.models.length,
      "实际 " + result.modelLabels.length + " / 期望 " + provider.models.length);

    // 名字不能被压成竖排。竖排时盒宽塌到十几像素、盒高远大于行高。
    let modelSqueezed = null;
    for (const l of result.modelLabels) {
      if (l.w < 16) {
        modelSqueezed = "第 " + l.idx + " 个宽仅 " + l.w + "px（竖排）"
          + " [viewport=" + result.modelViewportW + " content=" + result.modelContentW
          + " scrollRail=" + result.modelScrollRail + " stagger=" + result.modelStagger
          + " contentScrollW=" + result.modelContentScrollW + "]";
        break;
      }
      if (l.scrollW > l.clientW + 2) {
        modelSqueezed = "第 " + l.idx + " 个内容宽 " + l.scrollW + " > 盒宽 " + l.clientW + "（文字溢出）"
          + " [viewport=" + result.modelViewportW + " content=" + result.modelContentW
          + " scrollW=" + result.modelContentScrollW + " stagger=" + result.modelStagger + "]";
        break;
      }
    }
    check(provider.name + "：模型名不竖排/不溢出", modelSqueezed === null, modelSqueezed || "");

    // 同层名字不能重叠（重叠是真实可见的严重问题）
    const byBand = new Map();
    for (const l of result.modelLabels) {
      const key = l.band || "single";
      if (!byBand.has(key)) byBand.set(key, []);
      byBand.get(key).push(l);
    }
    let overlap = null;
    for (const [bandName, list] of byBand) {
      list.sort((a, b) => a.x - b.x);
      for (let k = 1; k < list.length; k += 1) {
        if (list[k].x < list[k - 1].right - 1) {
          overlap = "层 " + bandName + "：第 " + list[k - 1].idx + " 与 " + list[k].idx
            + " 重叠（" + list[k - 1].right.toFixed(1) + " > " + list[k].x.toFixed(1) + "）";
          break;
        }
      }
      if (overlap) break;
    }
    check(provider.name + "：模型名不重叠", overlap === null, overlap || "");

    // 名字不能超出视口（真机截图里 GPT-6.1-Sol 右侧被切）。
    // 但**滚动模式**下内容本来就比视口宽 —— 那是设计（可以横滚看到），不算越界。
    // 真正要防的是「明明没开滚动，却宽出视口」（= 内容被裁且没法滚到）。
    let modelOverflow = null;
    if (result.modelScrollRail !== "1") {
      /* 判定基准是**模型名区自身**的右边界，不是整个视口：
         菜单有内距、右侧还有供应商栏，名字只要不超出自己的容器就不算被裁。
         另外：外层视口 overflow-x:auto 时，内容宽于容器是**能滚到**的，不算被裁
         （交错/min-width 模式正是这样工作）。 */
      const rightLimit = (result.modelSectionW || 0) + (result.modelSectionLeft || 0);
      const viewportScrollable = result.viewportScrollW > result.viewportClientW + 1;
      if (viewportScrollable) modelOverflow = null;
      else
      for (const l of result.modelLabels) {
        if (l.right > rightLimit + 2) {
          modelOverflow = "第 " + l.idx + " 个右边 " + l.right + " > 名区右界 " + rightLimit
            + "（未开滚动，名字被裁）";
          break;
        }
      }
    } else {
      // 滚动模式下：至少第一个名字要从容器左边开始可见（不是被推到视口外）
      const first = result.modelLabels[0];
      if (first && first.x < -1) modelOverflow = "滚动模式下首个名字左边 " + first.x + " < 0";
    }
    check(provider.name + "：模型名不超出视口", modelOverflow === null, modelOverflow || "");

    const failed = failures - before;
    console.log("  " + (failed === 0 ? "ok  " : "FAIL") + " " + provider.name
      + "（" + provider.models.length + " 模型 / " + col.layout + "）"
      + (failed === 0 ? "" : "  ← " + failed + " 项失败"));
  }
}

console.log("\n共 " + checks + " 项检查");
if (failures > 0) { console.log("有失败 ❌（" + failures + " 项）"); process.exit(1); }
console.log("全部通过 ✅ 插件真渲染 × 真浏览器排版：无竖排、无越界、供应商栏可达");
