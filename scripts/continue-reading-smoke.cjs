// Runs only against a dedicated test Chrome profile; resets its local book library.
const assert = require("node:assert/strict");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = process.env.READTAYLOR_CDP_PORT || "9236";
const origin = process.env.READTAYLOR_TEST_URL || "http://127.0.0.1:4179/";

let socket;
let command;

async function connect(target) {
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (!pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  command = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Runtime.enable");
  await command("Page.enable");
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
}

const featureTitle = "document.querySelector('.reading-feature h2')?.textContent?.trim()";

async function expectContinueTitle(title, label) {
  const actual = await waitFor(`${featureTitle} === ${JSON.stringify(title)} && ${featureTitle}`);
  assert.equal(actual, title, label);
  console.log(`${label}: ${actual}`);
}

async function openShelfBook(title) {
  const titleLiteral = JSON.stringify(title);
  await waitFor(`(() => {
    const button = [...document.querySelectorAll('.shelf-book .book-open')]
      .find((candidate) => candidate.querySelector('h3')?.textContent?.trim() === ${titleLiteral});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor("!!document.querySelector('[aria-label=\"返回书架\"]')");
}

async function returnToShelf() {
  await evaluate("document.querySelector('[aria-label=\"返回书架\"]').click()");
  await waitFor("!!document.querySelector('.reading-feature')");
}

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  await connect(targets.find((target) => target.type === "page" && target.url.startsWith(origin)));

  const chapter = (id) => ({ id, title: id, content: `${id} content` });
  const books = [
    {
      id: "legacy-first",
      title: "Legacy first book",
      author: "Test",
      fileType: "TXT",
      color: "#7a2020",
      chapters: [chapter("a1"), chapter("a2")],
      progress: 10,
      lastChapter: 0,
      lastScroll: 0,
      addedAt: 1,
    },
    {
      id: "recent-second",
      title: "Recently opened book",
      author: "Test",
      fileType: "TXT",
      color: "#3a5fa8",
      chapters: [chapter("b1"), chapter("b2")],
      progress: 10,
      lastChapter: 0,
      lastScroll: 0,
      addedAt: 2,
    },
  ];

  await evaluate(`localStorage.clear(); localStorage.setItem('readtaylor.books.v1', ${JSON.stringify(JSON.stringify(books))})`);
  await command("Page.reload");
  await expectContinueTitle("Legacy first book", "legacy data keeps the existing order");

  await openShelfBook("Recently opened book");
  await returnToShelf();
  await expectContinueTitle("Recently opened book", "opening another book updates continue reading");

  await command("Page.reload");
  await expectContinueTitle("Recently opened book", "recent book survives reload");

  await openShelfBook("Legacy first book");
  await returnToShelf();
  await expectContinueTitle("Legacy first book", "a newer reading session replaces the previous one");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => socket?.close());
