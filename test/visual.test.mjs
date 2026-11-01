/**
 * 真实浏览器布局回归测试（动态 + 覆盖全部真实供应商 × 宽屏/窄屏）。
 *
 * 为什么需要它：单元测试跑在 mini-DOM 上，**没有真实布局**，
 * 所以历史上多次出现「测试全绿、界面上名字重叠/闪烁」。这个测试用无头 Edge
 * 打开用**真实插件 CSS** 渲染的页面，逐场景检查：
 *
 *   1) 名字全部渲染
 *   2) 同层相邻名字不重叠
 *   3) 名字不超出所在层（超出会盖住下面那排）
 *   4) 上下两层不相交
 *   5) 连续 12 帧布局一致 → 抓闪烁
 *
 * 覆盖面：9 家真实供应商 × 4 种屏幕（桌面宽屏 / 桌面窄窗 / 手机竖屏 / 极窄）。
 *
 * 用法：node test/visual.test.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/* ── 从 lib/client.js 抽取真实常量与完整 CSS，确保测的就是线上那份 ── */
function loadRealStyle() {
  const src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8");
  const start = src.indexOf("var CSS = [");
  const open = src.indexOf("[", start);
  let depth = 0;
  let close = -1;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "[") depth += 1;
    else if (src[j] === "]") { depth -= 1; if (depth === 0) { close = j; break; } }
  }
  if (close < 0) throw new Error("没能定位 CSS 数组结尾");

  /* CSS 里引用了许多常量（KNOB_RADIUS、FILL_RADIUS 等，彼此还有依赖）。
     直接把 CSS 之前那段声明原样求值，得到所有常量，再取 CSS。 */
  const prefix = src.slice(0, start);
  /* 只保留 var 声明与必要的函数声明，去掉 React 组件等无关代码：
     逐个收集 `var NAME = ...;` 语句，按出现顺序拼接后求值（依赖都在前面）。 */
  /* 常量分散在 CSS 数组前后，所以扫**整个文件**的顶层 var 声明，
     按出现顺序拼接（依赖都写在前面）。 */
  const decls = [];
  const lineRe = /^ {4}var ([A-Za-z_$][\w$]*)\s*=\s*(.+);$/gm;
  let m;
  while ((m = lineRe.exec(src)) !== null) {
    const name = m[1];
    const value = m[2];
    if (/function\s*\(/.test(value) || /\brequire\s*\(/.test(value)) continue;
    if (/__CSS__/.test(name)) continue;
    decls.push("var " + name + " = " + value + ";");
  }
  const sandbox = decls.join("\n") + "\n" + "var __CSS__ = " + src.slice(open, close + 1) + ";";
  /* ⚠️ 求值得到的是**数组**，必须 join("\n")：
     直接插进 <style> 会被转成逗号分隔，浏览器把它当成一个畸形选择器列表，
     导致后面所有规则失效（实测只剩 2 条生效，名字全部失去定位）。 */
  const rawCss = Function(sandbox + "\nreturn __CSS__;")();
  const CSS = Array.isArray(rawCss) ? rawCss.join("\n") : String(rawCss);
  const get = (name) => Function(sandbox + "\nreturn " + name + ";")();

  return {
    CSS,
    NAMED_BAND_ROW: get("NAMED_BAND_ROW"),
    NAMED_BAND_GAP: get("NAMED_BAND_GAP"),
    NAMED_MIN_CELL: get("NAMED_MIN_CELL"),
    NAME_MIN_SLOT: get("NAME_MIN_SLOT"),
    MODEL_SLOT_TARGET: get("MODEL_SLOT_TARGET"),
    MODEL_BAND_EXTRA_MIN: get("MODEL_BAND_EXTRA_MIN"),
    MODEL_BAND_EXTRA_MAX: get("MODEL_BAND_EXTRA_MAX"),
  };
}

/* ── 9 家真实供应商（与 preview/panel.html 同步）── */
const PROVIDERS = [
  { id: "deepseek-account", name: "DeepSeek Account", models: ["DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro"] },
  { id: "deepseek", name: "DeepSeek", models: ["DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro", "DeepSeek-R1"] },
  { id: "minimax-cn", name: "minimax-cn", models: ["MiniMax M2.7", "MiniMax-M2.7-highspeed", "MiniMax M3"] },
  { id: "pixel-codex", name: "Pixel Codex", models: ["GPT-6 Astra", "GPT-6 Sol", "GPT-6.1 Sol", "GPT-6.1 Terra"] },
  { id: "woyao-claude", name: "WOYAO · Claude", models: ["Claude Sonnet 4", "Claude Opus 4"] },
  { id: "woyao-gpt", name: "WOYAO · GPT", models: ["GPT-6 Astra", "GPT-6 Sol"] },
  { id: "woyao-general", name: "WOYAO · 通用", models: ["Gemini 3.8 Flash High","Gemini 4 Argon","Grok 4.7","GLM 5.3","GLM 5.3-pro","DeepSeek V4.1 Flash (1017)","DeepSeek V4 Pro","GPT-5.6 Sol","GPT-5.6 Terra","GPT-5.6 Luna","Kimi K3.1 Pro","Kimi K2.8 Preview","MiMo V2","MiMo V2.5","MiniMax M2.7","Hunyuan V4","Hunyuan V4 Pro","GLM 5.3 Vision","GPT-Reserve (Experimental)","MiMo V2 Flash"] },
  { id: "chatgpt", name: "ChatGPT subscription", models: ["ChatGPT Subscription"] },
  { id: "kimi", name: "Kimi subscription", models: ["Kimi K3.1 Pro","Kimi K3.1 Pro Highspeed","Kimi K3","Kimi K3-256K","Kimi K2.8 Preview","Kimi K2.7 Code Highspeed"] },
];

/* ── 4 种屏幕 ── */
const SCREENS = [
  { key: "desktop-wide", label: "桌面宽屏", viewport: 1440, hostWidth: 420 },
  { key: "desktop-narrow", label: "桌面窄窗", viewport: 820, hostWidth: 360 },
  { key: "phone", label: "手机竖屏", viewport: 390, hostWidth: 330 },
  { key: "phone-tiny", label: "极窄", viewport: 320, hostWidth: 280 },
];

const REAL = loadRealStyle();

function bandExtraFor(count, hostWidth) {
  const host = hostWidth > 0 ? hostWidth : 360;
  const wanted = count * REAL.MODEL_SLOT_TARGET - host;
  if (!(wanted > REAL.MODEL_BAND_EXTRA_MIN)) return REAL.MODEL_BAND_EXTRA_MIN;
  return wanted > REAL.MODEL_BAND_EXTRA_MAX ? REAL.MODEL_BAND_EXTRA_MAX : Math.round(wanted);
}
function staggerRowsFor(availableWidth, count) {
  if (!(count > 1)) return 1;
  const slot = availableWidth / count;
  return slot > 0 && slot < REAL.NAME_MIN_SLOT ? 2 : 1;
}
function staggerLeft(i, c) {
  if (!(c > 1)) return 50;
  return ((i + 0.5) / c) * 100;
}

const SEP = /^[-\s·_]$/;
function tokenize(label) {
  const pieces = label.split(/([-\s·_])/);
  const out = [];
  for (let tp = 0; tp < pieces.length; tp += 1) {
    const piece = pieces[tp];
    if (!piece) continue;
    if (SEP.test(piece)) {
      if (piece !== " ") {
        const np = pieces[tp + 1];
        if (typeof np === "string" && np.length > 0) { pieces[tp + 1] = piece + np; continue; }
        continue;
      }
      out.push(piece);
      continue;
    }
    out.push('<span class="ces-name-token">' + piece + "</span>");
  }
  return out.join("");
}

function buildPage(models, contentWidth) {
  const N = models.length;
  const stagger = staggerRowsFor(contentWidth, N);
  const bands = stagger >= 2;
  /* 与插件一致：宽度上限用 JS 算成 px，写进内联 --ces-cap */
  const cap = Math.max(24, Math.floor((contentWidth / Math.max(1, N)) * 2 - REAL.NAMED_BAND_GAP));
  const label = (name, i) => '<span class="ces-named-label" data-index="' + i + '"'
    + (bands ? ' data-band="' + (i % 2 ? "bottom" : "top") + '"' : "")
    + (i === 0 ? ' data-selected="1"' : "")
    + (bands ? ' style="left:' + staggerLeft(i, N) + '%;--ces-cap:' + cap + 'px"' : "")
    + '><span class="ces-name-text">' + tokenize(name) + "</span></span>";
  const ticks = models.map((_, i) => '<div class="ces-named-tick" style="left:' + (((i + 0.5) / N) * 100) + '%"></div>').join("");

  let inner;
  if (bands) {
    const top = models.map((m, i) => (i % 2 === 0 ? label(m, i) : "")).join("");
    const bot = models.map((m, i) => (i % 2 !== 0 ? label(m, i) : "")).join("");
    inner = '<div class="ces-named-labels ces-named-labels--band" data-band="top">' + top + "</div>"
      + '<div class="ces-named-hit"><div class="ces-named-track">' + ticks + "</div></div>"
      + '<div class="ces-named-labels ces-named-labels--band" data-band="bottom">' + bot + "</div>";
  } else {
    inner = '<div class="ces-named-labels">' + models.map((m) => label(m, 0)).join("") + "</div>"
      + '<div class="ces-named-hit"><div class="ces-named-track">' + ticks + "</div></div>";
  }

  return `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;background:#fff;font-family:system-ui,sans-serif}
${REAL.CSS}
</style>
<div class="ces-named-section" style="width:${contentWidth}px">
  <div class="ces-named-viewport" id="vp">
    <div class="ces-named-content" id="content" ${bands ? 'data-stagger="1"' : ""} style="--ces-count:${N}">
      ${inner}
    </div>
  </div>
</div>
<script>
window.__snapshot = function () {
  var vp = document.getElementById("vp");
  var content = document.getElementById("content");
  var labels = [];
  var nodes = content.querySelectorAll(".ces-named-label");
  for (var k = 0; k < nodes.length; k += 1) {
    var el = nodes[k];
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    labels.push({
      /* ⚠️ 用元素自己的 data-index，不能按查询顺序重新编号：
         querySelectorAll 会先返回 top 层的所有名字，再返回 bottom 层，
         重新编号会把两层混在一起，导致「同层重叠」误报。 */
      i: el.hasAttribute("data-index") ? Number(el.getAttribute("data-index")) : k,
      band: el.getAttribute("data-band") || "single",
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10
    });
  }
  var bandEl = content.querySelector(".ces-named-labels--band");
  return {
    scrollW: vp.scrollWidth,
    clientW: vp.clientWidth,
    contentW: Math.round(content.getBoundingClientRect().width * 10) / 10,
    bandW: bandEl ? Math.round(bandEl.getBoundingClientRect().width * 10) / 10 : -1,
    cellVar: bandEl ? getComputedStyle(bandEl).getPropertyValue("--ces-cell") : "",
    labels: labels
  };
};
window.__samples = [];
window.__runFrames = function (count, done) {
  var n = 0;
  function step() {
    window.__samples.push(JSON.stringify(window.__snapshot().labels));
    n += 1;
    if (n >= count) { done(); return; }
    /* 用 setTimeout 而不是 requestAnimationFrame：无头 + virtual-time 下 rAF 不推进，
       会让采样永远停在第一帧（测不出闪烁）。 */
    setTimeout(step, 16);
  }
  setTimeout(step, 0);
};
window.__runFrames(12, function () {
  var s = window.__snapshot();
  var changed = 0;
  for (var k = 1; k < window.__samples.length; k += 1) {
    if (window.__samples[k] !== window.__samples[0]) changed += 1;
  }
  s.frameChanges = changed;
  document.title = JSON.stringify(s);
});
<\/script>`;
}

function runPage(file) {
  const url = "file:///" + file.replace(/\\/g, "/");
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const html = execFileSync(EDGE, [
        "--headless=new", "--disable-gpu", "--no-sandbox",
        "--virtual-time-budget=2500", "--dump-dom", url,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
      const m = html.match(/<title>([\s\S]*?)<\/title>/);
      if (m && m[1] && m[1].trim().startsWith("{")) {
        return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      }
      lastErr = new Error("页面没有回传探针结果（title 为空）");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log("      FAIL " + label + (detail ? " — " + detail : ""));
}

const dir = mkdtempSync(join(tmpdir(), "ces-visual-"));
const rowH = REAL.NAMED_BAND_ROW;

console.log("真实浏览器布局回归：9 家供应商 × 4 种屏幕 = " + PROVIDERS.length * SCREENS.length + " 个场景");
console.log("（层高 " + rowH + "px，最小格 " + REAL.NAMED_MIN_CELL + "px，单层阈值 " + REAL.NAME_MIN_SLOT + "px）\n");

let scenarios = 0;
for (const screen of SCREENS) {
  console.log("=== " + screen.label + "（视口 " + screen.viewport + "px / 官方内容 " + screen.hostWidth + "px）===");
  for (const provider of PROVIDERS) {
    scenarios += 1;
    const models = provider.models;
    const extra = bandExtraFor(models.length, screen.hostWidth);
    const contentW = screen.hostWidth + extra;
    const stagger = staggerRowsFor(contentW, models.length);
    const file = join(dir, "s-" + screen.key + "-" + provider.id + ".html");
    const pageHtml = buildPage(models, contentW);
    writeFileSync(file, pageHtml, "utf8");
    if (process.env.CES_DUMP && provider.id === "woyao-general" && screen.key === "desktop-wide") {
      writeFileSync("C:/Users/10395/AppData/Local/Temp/dump-" + provider.id + ".html", pageHtml, "utf8");
      console.log("    [dump] 已写入调试页，含 ces-cap 次数 = " + (pageHtml.match(/--ces-cap/g) || []).length);
    }
    const before = failures;
    let snap;
    try {
      snap = runPage(file);
    } catch (e) {
      failures += 1;
      console.log("  FAIL " + provider.name + " — 无法取回布局：" + String(e.message || e).slice(0, 80));
      continue;
    }

    const labelList = snap.labels;
    if (process.env.CES_DEBUG) {
      console.log("    [debug] " + provider.id + " labels=" + labelList.length + " idx=" + labelList.map((l) => l.i).join(","));
      console.log("    [debug] bandW=" + snap.bandW + " cell=" + snap.cellVar + " contentW=" + snap.contentW);
      console.log("    [debug] boxes=" + labelList.map((l) => l.i + ":" + l.band + "@" + l.x + "+" + l.w + "h" + l.h).join(" | "));
      console.log("    [debug] leftAttrs=" + Array.from({length: labelList.length}, (_, k) => labelList[k].i + "=" + labelList[k].x).join(","));
    }
    check("名字全部渲染", labelList.length === models.length, "实际 " + labelList.length + " / 期望 " + models.length);

    if (stagger >= 2) {
      const byBand = {};
      for (const l of labelList) (byBand[l.band] || (byBand[l.band] = [])).push(l);
      let overlap = null;
      for (const key of Object.keys(byBand)) {
        const arr = byBand[key].sort((a, b) => a.i - b.i);
        for (let k = 1; k < arr.length; k += 1) {
          const prev = arr[k - 1];
          const cur = arr[k];
          if (cur.x < prev.right - 0.6) {
            overlap = key + " 层 #" + prev.i + "(x=" + prev.x + ",right=" + prev.right + ") 与 #" + cur.i + "(x=" + cur.x + ") 重叠 " + (prev.right - cur.x).toFixed(1) + "px";
            break;
          }
        }
        if (overlap) break;
      }
      check("同层名字不重叠", overlap === null, overlap || "");

      let vert = null;
      for (const l of labelList) {
        if (l.h > rowH + 0.6) { vert = "#" + l.i + " 高 " + l.h + "px 超出层高 " + rowH + "px"; break; }
      }
      check("名字不超出所在层", vert === null, vert || "");

      const tops = labelList.filter((l) => l.band === "top");
      const bottoms = labelList.filter((l) => l.band === "bottom");
      let cross = null;
      for (const t of tops) {
        for (const b of bottoms) {
          if (Math.abs(t.i - b.i) !== 1) continue;
          if (t.bottom > b.y + 0.6) cross = "#" + t.i + "(上) 底 " + t.bottom + " > #" + b.i + "(下) 顶 " + b.y;
        }
        if (cross) break;
      }
      check("上下两层不相交", cross === null, cross || "");
    }

    check("12 帧内布局稳定（无闪烁）", snap.frameChanges === 0, "变化帧数 " + snap.frameChanges);

    const failed = failures - before;
    console.log("  " + (failed === 0 ? "ok  " : "FAIL") + " " + provider.name
      + "（" + models.length + " 模型 / 内容 " + contentW + "px / " + (stagger >= 2 ? "两层" : "单层")
      + (snap.scrollW > snap.clientW + 1 ? " / 横向滚动" : "") + "）");
  }
  console.log("");
}

console.log("共 " + checks + " 项检查，覆盖 " + scenarios + " 个场景");
if (failures > 0) {
  console.log("有失败 ❌（" + failures + " 项）");
  process.exit(1);
}
console.log("全部通过 ✅ 所有供应商 × 所有屏幕：无重叠、无溢出、无闪烁");
