/** Injectable test transport: no network and no real API Key. */
function createMockTranslationFetch(steps = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url: String(url), body: JSON.parse(options.body), headers: options.headers, signal: options.signal, redirect: options.redirect };
    calls.push(call);
    if (options.signal?.aborted) throw new Error("aborted");
    const step = steps.shift();
    if (!step) throw new Error("Mock response script exhausted");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(call);
    return new Response(JSON.stringify(step.body), { status: step.status || 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, calls };
}
function mockCompletion(translations, finishReason = "stop") {
  return { choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: finishReason }] };
}
module.exports = { createMockTranslationFetch, mockCompletion };
