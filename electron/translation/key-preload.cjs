const { ipcRenderer } = require("electron");

// No bridge is exposed here. The main reader cannot access this window or its Key input.
window.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("api-key");
  const save = document.getElementById("save");
  const error = document.getElementById("error");
  const context = await ipcRenderer.invoke("readtaylor:translation:key-context");
  if (!context.ok) { error.textContent = context.error; save.disabled = true; return; }
  document.getElementById("destination").textContent = `${context.data.label} · 绑定接口：${context.data.domain}`;
  const submit = async () => {
    if (save.disabled) return;
    save.disabled = true;
    const key = input.value;
    input.value = "";
    try {
      const result = await ipcRenderer.invoke("readtaylor:translation:key-submit", key);
      if (!result.ok) error.textContent = result.error;
    } catch { error.textContent = "保存未完成，请重新录入后重试。"; }
    finally { save.disabled = false; }
  };
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } });
  document.getElementById("cancel").addEventListener("click", () => { input.value = ""; void ipcRenderer.invoke("readtaylor:translation:key-cancel"); });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; void ipcRenderer.invoke("readtaylor:translation:key-cancel"); } });
});
