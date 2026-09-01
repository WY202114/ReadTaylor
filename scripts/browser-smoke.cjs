const path = require("node:path");

const port = process.env.READTAYLOR_CDP_PORT || "9222";
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
  } finally {
    await command("Browser.close").catch(() => undefined);
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
