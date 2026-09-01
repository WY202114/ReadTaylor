const path = require("node:path");

const port = process.env.READTAYLOR_CDP_PORT || "9222";
const mobileViewport = process.env.READTAYLOR_MOBILE_VIEWPORT?.match(/^(\d+)x(\d+)$/);
const files = process.argv.slice(2).map((file) => path.resolve(file));
if (!files.length) {
  console.error("Pass one or more test book paths to browser-smoke.cjs.");
  process.exit(1);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const target = targets.find((item) => (
    item.type === "page"
    && item.title === "ReadTaylor"
    && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url)
  ));
  if (!target) throw new Error("ReadTaylor Chrome target was not found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  const consoleMessages = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.consoleAPICalled") {
      consoleMessages.push(
        (message.params.args || []).map((argument) => argument.value || argument.description || "").join(" ")
      );
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  try {
    await command("Runtime.enable");
    await command("DOM.enable");
    if (mobileViewport) {
      await command("Emulation.setDeviceMetricsOverride", {
        width: Number(mobileViewport[1]),
        height: Number(mobileViewport[2]),
        deviceScaleFactor: 1,
        mobile: true,
      });
    }
    await command("Runtime.evaluate", {
      expression: `localStorage.clear(); indexedDB.deleteDatabase("readtaylor"); location.reload();`,
    }).catch(() => undefined);
    await delay(1200);

    const document = await command("DOM.getDocument", { depth: -1, pierce: true });
    const input = await command("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!input.nodeId) throw new Error("Book file input was not found.");
    await command("DOM.setFileInputFiles", { nodeId: input.nodeId, files });
    await command("Runtime.evaluate", {
      expression: `document.querySelector('input[type="file"]').dispatchEvent(new Event("change", { bubbles: true }));`,
    });

    let books = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(200);
      const state = await command("Runtime.evaluate", {
        expression: `localStorage.getItem("readtaylor.books.v1") || "[]"`,
        returnByValue: true,
      });
      books = JSON.parse(state.result.value);
      if (books.length >= files.length) break;
    }
    if (books.length < files.length) {
      const page = await command("Runtime.evaluate", {
        expression: `document.body.innerText`,
        returnByValue: true,
      });
      throw new Error(
        `Only ${books.length} of ${files.length} smoke-test books reached the shelf.\n`
        + `Books: ${JSON.stringify(books.map((book) => book.fileType))}\n`
        + `Console: ${consoleMessages.join(" | ")}\n`
        + `Page: ${String(page.result.value).slice(-500)}`
      );
    }
    const summary = books.slice(0, files.length).map((book) => ({
      title: book.title,
      fileType: book.fileType,
      chapters: book.chapters.length,
      mode: book.mode || "text",
    }));
    console.log(JSON.stringify(summary, null, 2));

    if (process.env.READTAYLOR_CHECK_MOBILE_LAYOUT === "1") {
      const firstBook = books[0];
      const opened = await command("Runtime.evaluate", {
        expression: `(() => {
          const title = ${JSON.stringify(books[0].title)};
          const button = [...document.querySelectorAll("button")]
            .find((item) => item.textContent.includes(title));
          if (!button) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (!opened.result.value) throw new Error("Mobile layout test book could not be opened.");

      let layout = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(100);
        const result = await command("Runtime.evaluate", {
          expression: `(() => {
            const openButton = document.querySelector('button[aria-label="打开目录"]');
            if (!openButton) return null;
            openButton.click();
            return true;
          })()`,
          returnByValue: true,
        });
        if (result.result.value) break;
      }
      await delay(350);
      const result = await command("Runtime.evaluate", {
        expression: `(() => {
          const drawer = document.querySelector('[aria-label="章节目录"]');
          const backButton = document.querySelector('button[aria-label="返回书架"]');
          const chapterButtons = drawer
            ? [...drawer.lastElementChild.querySelectorAll(":scope > button")]
            : [];
          const firstChapter = chapterButtons[0];
          return drawer && backButton && firstChapter ? {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            drawerWidth: drawer.getBoundingClientRect().width,
            backButtonWidth: backButton.getBoundingClientRect().width,
            chapterRowHeight: firstChapter.getBoundingClientRect().height,
            firstChapterText: firstChapter.firstElementChild?.textContent?.trim() || "",
          } : null;
        })()`,
        returnByValue: true,
      });
      layout = result.result.value;
      if (!layout) throw new Error("Mobile chapter drawer did not open.");
      const expectedChapterTitle = firstBook.chapters[0].title.trim();
      if (
        layout.drawerWidth < layout.viewportWidth * 0.84
        || layout.drawerWidth > layout.viewportWidth * 0.9
        || layout.backButtonWidth < 40
        || layout.chapterRowHeight < 48
        || layout.firstChapterText !== expectedChapterTitle
      ) {
        throw new Error(`Unexpected mobile layout: ${JSON.stringify({ layout, expectedChapterTitle })}`);
      }
      console.log(JSON.stringify({ mobileLayout: layout }, null, 2));
    }

    if (process.env.READTAYLOR_CHECK_PAGINATION === "1") {
      const opened = await command("Runtime.evaluate", {
        expression: `(() => {
          const title = "ReadTaylor 原样排版测试书";
          const button = [...document.querySelectorAll("button")]
            .find((item) => item.textContent.includes(title));
          if (!button) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (!opened.result.value) throw new Error("Pagination test book could not be opened.");

      let pagination = null;
      for (let attempt = 0; attempt < 80; attempt++) {
        await delay(150);
        const result = await command("Runtime.evaluate", {
          expression: `(() => {
            const lines = document.body.innerText.split("\\n").map((line) => line.trim());
            const label = lines.find((line) => (
              line.includes(" / ")
              && !line.includes("计算中")
              && Number.isFinite(Number(line.split(" / ")[0]))
              && Number.isFinite(Number(line.split(" / ")[1]))
            ));
            const frame = [...document.querySelectorAll("iframe")]
              .find((item) => item.style.visibility !== "hidden");
            if (!label || !frame?.contentDocument) return null;
            const scrolling = frame.contentDocument.scrollingElement || frame.contentDocument.documentElement;
            return {
              label,
              previousLabel: lines.includes("上一页"),
              nextLabel: lines.includes("下一页"),
              clientWidth: scrolling.clientWidth,
              scrollWidth: scrolling.scrollWidth,
              clientHeight: scrolling.clientHeight,
              scrollHeight: scrolling.scrollHeight,
              scrollX: frame.contentWindow.scrollX,
              scrollY: frame.contentWindow.scrollY,
            };
          })()`,
          returnByValue: true,
        });
        pagination = result.result.value;
        if (pagination) break;
      }
      if (!pagination) {
        const diagnostic = await command("Runtime.evaluate", {
          expression: `({
            text: document.body.innerText.slice(-800),
            frames: [...document.querySelectorAll("iframe")].map((frame) => ({
              title: frame.title,
              visibility: frame.style.visibility,
              width: frame.clientWidth,
              height: frame.clientHeight,
              loaded: Boolean(frame.contentDocument?.body),
            })),
          })`,
          returnByValue: true,
        });
        throw new Error(
          `Whole-book page count did not finish calculating. `
          + `Diagnostic: ${JSON.stringify(diagnostic.result.value)} `
          + `Console: ${consoleMessages.join(" | ")}`
        );
      }
      const [firstPage, totalPages] = pagination.label.split(" / ").map(Number);
      if (firstPage !== 1 || totalPages <= 2 || !pagination.previousLabel || !pagination.nextLabel) {
        throw new Error(`Unexpected pagination state: ${JSON.stringify(pagination)}`);
      }
      if (pagination.scrollHeight > pagination.clientHeight + 2 || pagination.scrollY !== 0) {
        throw new Error(`Reader still scrolls vertically: ${JSON.stringify(pagination)}`);
      }

      await command("Runtime.evaluate", {
        expression: `([...document.querySelectorAll("button")]
          .find((item) => item.textContent.includes("下一页")))?.click()`,
      });
      await delay(250);
      const afterTurn = await command("Runtime.evaluate", {
        expression: `(() => {
          const lines = document.body.innerText.split("\\n").map((line) => line.trim());
          const frame = [...document.querySelectorAll("iframe")]
            .find((item) => item.style.visibility !== "hidden");
          return {
            label: lines.find((line) => (
              line.includes(" / ")
              && Number.isFinite(Number(line.split(" / ")[0]))
              && Number.isFinite(Number(line.split(" / ")[1]))
            )) || "",
            scrollX: frame?.contentWindow?.scrollX || 0,
            scrollY: frame?.contentWindow?.scrollY || 0,
          };
        })()`,
        returnByValue: true,
      });
      if (!afterTurn.result.value.label.startsWith("2 / ") || afterTurn.result.value.scrollX <= 0) {
        throw new Error(`Next page did not advance horizontally: ${JSON.stringify(afterTurn.result.value)}`);
      }
      const firstChapterPages = Math.max(1, Math.round(pagination.scrollWidth / pagination.clientWidth));
      for (let page = 1; page < firstChapterPages; page++) {
        await command("Runtime.evaluate", {
          expression: `([...document.querySelectorAll("button")]
            .find((item) => item.textContent.includes("下一页")))?.click()`,
        });
        await delay(120);
      }
      let afterChapterTurn = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(120);
        const result = await command("Runtime.evaluate", {
          expression: `(() => {
            const lines = document.body.innerText.split("\\n").map((line) => line.trim());
            return {
              label: lines.find((line) => (
                line.includes(" / ")
                && Number.isFinite(Number(line.split(" / ")[0]))
                && Number.isFinite(Number(line.split(" / ")[1]))
              )) || "",
              chapterTitle: lines[0] || "",
            };
          })()`,
          returnByValue: true,
        });
        afterChapterTurn = result.result.value;
        if (afterChapterTurn.chapterTitle.includes("第二章")) break;
      }
      if (
        !afterChapterTurn?.chapterTitle.includes("第二章")
        || !afterChapterTurn.label.startsWith(`${firstChapterPages + 1} / `)
      ) {
        throw new Error(`Page turn did not cross the chapter boundary: ${JSON.stringify(afterChapterTurn)}`);
      }
      console.log(JSON.stringify({
        pagination,
        afterTurn: afterTurn.result.value,
        afterChapterTurn,
      }, null, 2));
    }

    if (process.env.READTAYLOR_CHECK_FIXED_PAGINATION === "1") {
      const opened = await command("Runtime.evaluate", {
        expression: `(() => {
          const button = [...document.querySelectorAll("button")]
            .find((item) => item.textContent.includes("test"));
          if (!button) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (!opened.result.value) throw new Error("Fixed-layout test book could not be opened.");

      let firstLabel = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(120);
        const result = await command("Runtime.evaluate", {
          expression: `document.body.innerText.split("\\n")
            .map((line) => line.trim()).find((line) => line === "1 / 2") || ""`,
          returnByValue: true,
        });
        firstLabel = result.result.value;
        if (firstLabel) break;
      }
      if (firstLabel !== "1 / 2") throw new Error("Fixed-layout total page count is incorrect.");
      await command("Runtime.evaluate", {
        expression: `([...document.querySelectorAll("button")]
          .find((item) => item.textContent.includes("下一页")))?.click()`,
      });
      await delay(250);
      const secondLabel = await command("Runtime.evaluate", {
        expression: `document.body.innerText.split("\\n")
          .map((line) => line.trim()).find((line) => line === "2 / 2") || ""`,
        returnByValue: true,
      });
      if (secondLabel.result.value !== "2 / 2") {
        throw new Error(`Fixed-layout next page is incorrect: ${secondLabel.result.value}`);
      }
      console.log(JSON.stringify({ fixedLayout: [firstLabel, secondLabel.result.value] }, null, 2));
    }
  } finally {
    await command("Browser.close").catch(() => undefined);
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
