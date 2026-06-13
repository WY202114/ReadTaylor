const sampleParagraphs = [
  "这不是内置书库，而是一张给你私人书籍准备的舞台。上传你自己的文件，阅读页会像演出开场一样慢慢亮起来。",
  "ReadTaylor 的视觉语言来自粉丝熟悉的物件：手写日记、友情手链、舞台追光、雨夜蓝调和一点玫瑰色的高光。它不使用官方封面，也不复制任何商标。",
  "真正的阅读区域保持克制。正文有足够行距，底部工具条悬浮但不抢戏，设置抽屉只在需要时出现。",
  "你可以把它当作移动端浏览器里的随身阅读壳。书从你这里来，氛围由 ReadTaylor 接住。"
];

const state = {
  mode: "empty",
  title: "外观试读稿",
  fileType: "TXT",
  paragraphs: sampleParagraphs,
  theme: "stage",
  settingsOpen: false,
  fontSize: 18,
  lineHeight: 1.78,
  progress: 18,
  toast: ""
};

const themeLabels = {
  stage: "舞台光",
  diary: "日记粉",
  rain: "雨声蓝",
  night: "午夜场"
};

const app = document.querySelector("#app");

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitTextIntoParagraphs(text) {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return sampleParagraphs;
  const blocks = cleaned
    .split(/\n{2,}/)
    .map((item) => item.replace(/\n/g, " ").trim())
    .filter(Boolean);

  if (blocks.length > 1) return blocks.slice(0, 18);

  return cleaned
    .match(/.{1,96}(?:\s|$)/g)
    ?.map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 18) || sampleParagraphs;
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 2200);
}

function renderEmpty() {
  return `
    <section class="hero-panel" aria-labelledby="hero-title">
      <div class="bracelet" aria-label="Swiftie bracelet">
        ${["S", "W", "I", "F", "T", "I", "E"].map((letter) => `<span class="bead">${letter}</span>`).join("")}
      </div>
      <p class="kicker">移动端私人阅读器</p>
      <h1 id="hero-title">你的书 开场</h1>
      <p class="hero-copy">ReadTaylor 不提供书籍内容。上传你自己的 TXT、EPUB 或 PDF，把阅读交给一个更像粉丝日记的界面。</p>
      <div class="actions">
        <label class="primary-action" for="book-upload">上传文件</label>
        <button class="secondary-action" type="button" data-action="sample">试读外观</button>
      </div>
      <input class="hidden-input" id="book-upload" type="file" accept=".txt,.md,.epub,.pdf,text/plain,application/pdf" />
      <div class="notice-strip">
        <span class="notice-mark">i</span>
        <span>所有文件只在本机浏览器中读取。这个原型不会上传、保存或提供任何书籍。</span>
      </div>
    </section>

    <section class="library-row" aria-label="设计要点">
      <article class="mini-card">
        <strong>粉丝感来自细节</strong>
        <span>手链珠、追光色、手写日记质感，贴近 Taylor 氛围但不复制官方物料。</span>
        <div class="swatch-row" aria-hidden="true">
          <span class="swatch" style="background:#c94f74"></span>
          <span class="swatch" style="background:#d8a642"></span>
          <span class="swatch" style="background:#7da7c9"></span>
        </div>
      </article>
      <article class="mini-card">
        <strong>阅读优先</strong>
        <span>正文区域留白充足，工具收进底部，适合手机浏览器单手操作。</span>
        <div class="swatch-row" aria-hidden="true">
          <span class="swatch" style="background:#fffaf2"></span>
          <span class="swatch" style="background:#79896b"></span>
          <span class="swatch" style="background:#191926"></span>
        </div>
      </article>
    </section>
  `;
}

function renderReader() {
  const paragraphs = state.paragraphs
    .map((paragraph, index) => {
      const safe = escapeHTML(paragraph);
      if (index === 1) return `<p><mark>${safe.slice(0, 18)}</mark>${safe.slice(18)}</p>`;
      return `<p>${safe}</p>`;
    })
    .join("");

  return `
    <section
      class="reader"
      style="--reader-font:${state.fontSize}px; --reader-line:${state.lineHeight}; --progress:${state.progress}%"
    >
      <header class="reader-header">
        <button class="icon-button" type="button" data-action="home" aria-label="返回上传页">‹</button>
        <div class="book-meta">
          <strong>${escapeHTML(state.title)}</strong>
          <span>${state.fileType} 文件 · 本地阅读</span>
        </div>
        <button class="icon-button" type="button" data-action="settings" aria-label="阅读设置">Aa</button>
      </header>

      <article class="reading-page" tabindex="0" aria-label="阅读正文">
        <div class="chapter-label">Chapter 01</div>
        <h2>Private pages, stadium light</h2>
        ${paragraphs}
      </article>

      <footer class="reader-footer">
        <div class="progress-card">
          <div class="progress-line">
            <span>${state.progress}%</span>
            <span>${themeLabels[state.theme]}</span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill"></div>
          </div>
          <div class="tool-row">
            <button class="tool-button" type="button" data-action="toc">目录</button>
            <button class="tool-button" type="button" data-action="settings">Aa</button>
            <button class="tool-button" type="button" data-action="upload">上传</button>
            <button class="tool-button" type="button" data-action="bookmark">收藏</button>
          </div>
        </div>
      </footer>

      <input class="hidden-input" id="book-upload" type="file" accept=".txt,.md,.epub,.pdf,text/plain,application/pdf" />
      ${renderSettings()}
    </section>
  `;
}

function renderSettings() {
  return `
    <aside class="sheet" ${state.settingsOpen ? "" : "hidden"} aria-label="阅读设置">
      <div class="sheet-title">
        <strong>阅读设置</strong>
        <button class="icon-button" type="button" data-action="settings" aria-label="关闭设置">×</button>
      </div>
      <div class="setting-group">
        <span class="setting-label">主题</span>
        <div class="segmented">
          ${Object.entries(themeLabels)
            .map(([key, label]) => `<button class="segment ${state.theme === key ? "is-active" : ""}" type="button" data-theme="${key}">${label}</button>`)
            .join("")}
        </div>
      </div>
      <div class="setting-group">
        <span class="setting-label">字号</span>
        <div class="stepper-row">
          <button class="stepper" type="button" data-font="-1">A-</button>
          <button class="stepper" type="button" data-font="1">A+</button>
          <button class="stepper" type="button" data-progress="-8">前页</button>
          <button class="stepper" type="button" data-progress="8">后页</button>
        </div>
      </div>
      <div class="setting-group">
        <span class="setting-label">行距</span>
        <div class="stepper-row">
          <button class="stepper" type="button" data-line="-0.08">紧凑</button>
          <button class="stepper" type="button" data-line="0.08">舒展</button>
          <button class="stepper" type="button" data-action="sample">重置稿</button>
          <button class="stepper" type="button" data-action="home">上传页</button>
        </div>
      </div>
    </aside>
  `;
}

function render() {
  app.innerHTML = `
    <div class="mobile-shell theme-${state.theme}">
      <div class="app-surface">
        <header class="topbar" aria-label="应用顶部栏">
          <button class="icon-button" type="button" data-action="home" aria-label="首页">R</button>
          <div class="wordmark">
            <strong>ReadTaylor</strong>
            <span>bring your own books</span>
          </div>
          <button class="icon-button" type="button" data-action="settings" aria-label="设置">Aa</button>
        </header>
        ${state.mode === "reader" ? renderReader() : renderEmpty()}
      </div>
    </div>
    ${state.toast ? `<div class="toast" role="status">${escapeHTML(state.toast)}</div>` : ""}
  `;

  bindEvents();
}

function bindEvents() {
  app.querySelectorAll("[data-action]").forEach((node) => {
    node.addEventListener("click", () => {
      const action = node.getAttribute("data-action");
      if (action === "sample") {
        state.mode = "reader";
        state.title = "ReadTaylor 外观试读";
        state.fileType = "DEMO";
        state.paragraphs = sampleParagraphs;
        state.settingsOpen = false;
        showToast("已打开外观试读。正式阅读请上传自己的文件。");
      }
      if (action === "home") {
        state.mode = "empty";
        state.settingsOpen = false;
        render();
      }
      if (action === "settings") {
        if (state.mode !== "reader") {
          showToast("上传或试读后，可以在阅读页调整主题、字号和行距。");
          return;
        }
        state.settingsOpen = !state.settingsOpen;
        render();
      }
      if (action === "upload") {
        document.querySelector("#book-upload")?.click();
      }
      if (action === "toc") showToast("目录样式位已预留，接入解析后可显示章节。");
      if (action === "bookmark") showToast("收藏状态已点亮，后续可接入本地存储。");
    });
  });

  app.querySelectorAll("[data-theme]").forEach((node) => {
    node.addEventListener("click", () => {
      state.theme = node.getAttribute("data-theme");
      render();
    });
  });

  app.querySelectorAll("[data-font]").forEach((node) => {
    node.addEventListener("click", () => {
      state.fontSize = Math.min(24, Math.max(15, state.fontSize + Number(node.getAttribute("data-font"))));
      render();
    });
  });

  app.querySelectorAll("[data-line]").forEach((node) => {
    node.addEventListener("click", () => {
      state.lineHeight = Math.min(2.08, Math.max(1.48, state.lineHeight + Number(node.getAttribute("data-line"))));
      render();
    });
  });

  app.querySelectorAll("[data-progress]").forEach((node) => {
    node.addEventListener("click", () => {
      state.progress = Math.min(100, Math.max(0, state.progress + Number(node.getAttribute("data-progress"))));
      render();
    });
  });

  app.querySelectorAll("#book-upload").forEach((input) => {
    input.addEventListener("change", handleFile);
  });
}

function handleFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  state.title = file.name.replace(/\.[^.]+$/, "") || "未命名文件";
  state.fileType = (file.name.split(".").pop() || "FILE").toUpperCase();
  state.progress = 3;
  state.settingsOpen = false;

  const isText = file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name);
  if (!isText) {
    state.paragraphs = [
      `已选择 ${file.name}。这个外观原型先展示阅读壳与控制区，EPUB/PDF 正文解析可以在下一步接入。`,
      "上传入口、阅读页、底部工具、主题切换和字号行距控制都已经准备好。",
      "应用本身不提供书籍内容，文件来源完全由用户决定。"
    ];
    state.mode = "reader";
    showToast("已载入文件外观。EPUB/PDF 解析可作为下一步开发。");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    state.paragraphs = splitTextIntoParagraphs(reader.result || "");
    state.mode = "reader";
    showToast("TXT 已在本地读取。");
  };
  reader.onerror = () => {
    state.paragraphs = sampleParagraphs;
    state.mode = "reader";
    showToast("读取失败，已显示外观试读稿。");
  };
  reader.readAsText(file, "utf-8");
}

render();
