import { useEffect, useMemo, useState } from "react";
import { defaultConfig, endpointInfo, LANGUAGES, PRESETS, privacyNotice, readableError, TranslationError, type ProviderId, type TranslationConfig } from "../lib/browserTranslation/config";
import { createBrowserTranslationStore } from "../lib/browserTranslation/storage";
import { BrowserTranslationEngine } from "../lib/browserTranslation/engine";
import "../styles/translation-settings.css";

function initialize() {
  try {
    const store = createBrowserTranslationStore(), settings = store.load();
    return { store, profiles: settings.profiles, selected: settings.activeProviderId, error: "" };
  } catch (error) { return { store: undefined, profiles: PRESETS.map((p) => defaultConfig(p.id)), selected: "deepseek" as ProviderId, error: readableError(error) }; }
}
const stateLabels = { untested: "未测试", available: "可用", unavailable: "不可用" };

export function TranslationSettings() {
  const [initial] = useState(initialize), store = initial.store;
  const engine = useMemo(() => store ? new BrowserTranslationEngine(store) : undefined, [store]);
  const [profiles, setProfiles] = useState(initial.profiles);
  const [selected, setSelected] = useState<ProviderId>(initial.selected);
  const [apiKey, setApiKey] = useState("");
  const [keyBinding, setKeyBinding] = useState("");
  const [remember, setRemember] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(initial.error);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [testConfirm, setTestConfirm] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, string>>({});
  const profile = profiles.find((item) => item.providerId === selected)!;
  const preset = PRESETS.find((item) => item.id === selected)!;
  let destination: ReturnType<typeof endpointInfo> | undefined;
  try { destination = endpointInfo(profile.endpoint); } catch { /* Invalid draft stays editable. */ }
  const origin = destination?.origin;

  function refreshStates(items = profiles) {
    if (!store) return;
    setTestStates(Object.fromEntries(items.map((p) => [p.providerId, stateLabels[store.connectionState(p)]])));
  }
  useEffect(() => {
    setShowKey(false); setTestConfirm(false);
    if (!store || !origin) { setApiKey(""); setRemember(false); setKeyBinding(""); return; }
    try { const value = store.getKey(selected, origin); setApiKey(value.apiKey); setRemember(value.remember); setKeyBinding(`${selected}:${origin}`); refreshStates(); }
    catch (reason) { setApiKey(""); setRemember(false); setKeyBinding(""); setError(readableError(reason)); }
  }, [store, selected, origin]);
  useEffect(() => {
    const cancel = () => { engine?.cancelAll(); setShowKey(false); };
    const changedInAnotherTab = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith("readtaylor.llm.v1.")) return;
      engine?.cancelAll(); setShowKey(false); setApiKey(""); setKeyBinding(""); setMessage("浏览器中的配置已发生变化，请重新打开设置以加载最新配置。");
    };
    window.addEventListener("pagehide", cancel);
    window.addEventListener("storage", changedInAnotherTab);
    return () => { engine?.cancelAll(); window.removeEventListener("pagehide", cancel); window.removeEventListener("storage", changedInAnotherTab); };
  }, [engine]);
  function update(patch: Partial<TranslationConfig>) {
    const next = profiles.map((item) => item.providerId === selected ? { ...item, ...patch } : item);
    setProfiles(next); setError(""); setMessage(""); setClearConfirm(false); setTestConfirm(false);
    try { refreshStates(next); } catch (reason) { setError(readableError(reason)); }
  }
  function updateKey(value: string, persist = remember) {
    setApiKey(value); setError(""); setMessage(""); setTestConfirm(false);
    try {
      if (!store || !destination) throw new TranslationError("CONFIG", "请先填写有效的接口地址，再录入 Key。");
      store.setKey(selected, profile.endpoint, value, persist);
      setRemember(persist); setKeyBinding(`${selected}:${destination.origin}`); refreshStates();
    } catch (reason) { setError(readableError(reason)); }
  }
  function save(showMessage = true) {
    if (!store) { setError("浏览器存储不可用，请检查网站权限后刷新。"); return false; }
    try {
      if (!destination || keyBinding !== `${selected}:${destination.origin}`) throw new TranslationError("CONFIG_CHANGED", "接口已更改，请重新录入此接口的 Key，或重新打开设置。");
      const saved = store.saveConfig(profile);
      store.setKey(selected, saved.endpoint, apiKey, remember);
      setProfiles((previous) => previous.map((p) => p.providerId === selected ? saved : p));
      setError(""); if (showMessage) setMessage("当前配置已保存。Key " + (remember ? "已在本浏览器中记住。" : "仅保存在当前标签页会话中。"));
      refreshStates(); return true;
    } catch (reason) { setError(readableError(reason)); return false; }
  }
  function prepareTest() { if (save(false)) { setMessage(""); setTestConfirm(true); } }
  async function testConnection() {
    if (!engine) return;
    setBusy(true); setTestConfirm(false); setError(""); setMessage("");
    try {
      await engine.testConnection(selected, () => true);
      setMessage("连接测试成功：浏览器已收到该模型的有效接口响应。此测试不代表译文质量或所有模型参数均可用。");
    } catch (reason) { setError(readableError(reason)); }
    finally { setBusy(false); try { refreshStates(); } catch (reason) { setError(readableError(reason)); } }
  }
  function clearAll() {
    try {
      if (!engine) throw new TranslationError("STORAGE", "存储不可用，请通过浏览器的网站数据设置清除本站翻译配置。");
      engine.clearAll(); setProfiles(PRESETS.map((p) => defaultConfig(p.id))); setSelected("deepseek"); setApiKey(""); setKeyBinding(`deepseek:${endpointInfo(defaultConfig("deepseek").endpoint).origin}`); setRemember(false); setShowKey(false); setTestStates({});
      setClearConfirm(false); setTestConfirm(false); setError(""); setMessage("全部翻译配置、会话 Key、记住的 Key 与连接测试状态已清除，待发送请求已取消。");
    } catch (reason) { setError(readableError(reason)); }
  }

  return <section className="translation-settings" aria-labelledby="translation-settings-title">
    <header><h2 id="translation-settings-title">翻译设置</h2><span>OpenAI 兼容协议 · 浏览器直连</span></header>
    <p className="translation-settings-intro">使用你自己的 API Key。服务商按 Key 的签发平台选择，模型名称可另填。调用将按所选服务商计费。现有“翻译当前页”仍使用原有方式，暂不使用此处设置。</p>
    <form onSubmit={(event) => { event.preventDefault(); save(); }} autoComplete="off">
      <div className="translation-settings-grid">
        <label>服务商预设<select value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value as ProviderId); setError(""); setMessage(""); setClearConfirm(false); }}>{PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label} · 浏览器直连：{testStates[item.id] ?? "未测试"}</option>)}</select></label>
        <label>目标语言<select value={profile.targetLanguage} disabled={busy} onChange={(event) => update({ targetLanguage: event.target.value })}>{Object.entries(LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <label className="translation-settings-wide">接口地址<input type="url" value={profile.endpoint} disabled={busy} required placeholder="https://example.com/v1" autoComplete="off" spellCheck={false} onChange={(event) => update({ endpoint: event.target.value })} /></label>
        <label>模型名称<input value={profile.model} disabled={busy} required maxLength={200} autoComplete="off" spellCheck={false} placeholder="填写官方模型名称" onChange={(event) => update({ model: event.target.value })} /></label>
        <label>温度（可选）<input type="number" min="0" max="2" step="0.1" value={profile.temperature ?? ""} disabled={busy} placeholder="留空使用模型默认值" onChange={(event) => update({ temperature: event.target.value === "" ? null : Number(event.target.value) })} /><small>翻译建议 0–0.3；固定温度模型会省略此参数。</small></label>
        <div className="translation-key-field translation-settings-wide"><label htmlFor="translation-api-key">API Key {destination?.local ? "（本机接口，可留空）" : "（必填）"}</label><div>
          <input id="translation-api-key" type={showKey ? "text" : "password"} value={apiKey} disabled={busy} placeholder={destination?.local ? "本机接口可留空" : "录入当前接口的 API Key"} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} onChange={(event) => updateKey(event.target.value)} />
          <button type="button" disabled={busy} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏 Key" : "显示 Key"}</button>
          <button type="button" disabled={busy || !apiKey} onClick={() => { updateKey(""); setShowKey(false); }}>清除 Key</button>
        </div><small>默认仅保存在当前标签页的 sessionStorage，刷新后保留；正常关闭标签页后清除。按服务商与接口域名分别保存，修改域名后不会带上旧 Key。浏览器恢复会话时可能恢复会话数据。</small></div>
        <div className="translation-settings-wide translation-key-storage"><label><input type="checkbox" checked={remember} disabled={busy} onChange={(event) => updateKey(apiKey, event.target.checked)} />在本机记住 Key</label>
          <p className={remember ? "translation-settings-notice" : "translation-storage-warning"}>Key 将以明文保存在本浏览器中，安全性低于系统加密。请勿在公用电脑上开启。</p>
          <small>未开启时不会把 Key 写入 localStorage；关闭开关会将该 Key 移回当前会话并删除持久副本。</small>
        </div>
      </div>
      <p className="translation-preset-note">{preset.note} {preset.docs && <a href={preset.docs} target="_blank" rel="noreferrer noopener">服务商官方文档 ↗</a>} 接口与模型以服务商官方文档为准，均可手动修改。</p>
      <p className="translation-connection-state">浏览器直连：<strong>{testStates[selected] ?? "未测试"}</strong><small>仅依据你在此浏览器的测试结果；“不可用”表示上次测试失败，可能是 Key、模型、网络或跨域问题。修改地址、模型或 Key 后需重测。</small></p>
      <div className="translation-destination" role="note">{destination ? <>
        <p>实际接口：<strong>{destination.domain}</strong></p><p>{privacyNotice(profile.endpoint)}</p>
        {destination.local && <p>使用真正的本地模型时，内容不会离开本机；若本地服务转发云端，以该服务设置为准。可能需要在本地服务中允许来自本网站的跨域访问。HTTPS 网页连接 HTTP localhost 时，还可能受浏览器本地网络权限或安全策略限制。</p>}
      </> : "填写有效的接口地址后，这里会显示实际接口域名与发送提示。"}</div>
      <p className="translation-settings-intro">关闭或休眠标签页可能中断翻译。已完成块的保留与恢复将在后续阅读页接入时落实，本轮尚未实现。</p>
      <footer><button type="button" className="translation-clear" onClick={() => { setClearConfirm(true); setTestConfirm(false); }}>清除全部翻译配置</button><div className="translation-actions">
        {busy ? <button type="button" onClick={() => engine?.cancelAll()}>取消连接测试</button> : <button type="button" onClick={prepareTest}>测试连接</button>}
        <button type="submit" className="translation-save" disabled={busy}>保存当前配置</button>
      </div></footer>
    </form>
    {testConfirm && destination && <div className="translation-clear-confirm" role="region" aria-label="确认连接测试"><p>将由浏览器直接向 <strong>{destination.domain}</strong> 发送一次最小测试请求，使用当前 Key 和模型。仅发送“Reply OK.”（本批约 9 字符），不发送书籍正文；可能按所选服务商计费。</p><button type="button" onClick={() => setTestConfirm(false)}>取消</button><button type="button" onClick={() => void testConnection()}>确认发送测试</button></div>}
    {clearConfirm && <div className="translation-clear-confirm" role="alert"><p>清除所有服务商配置、Key 与测试状态，并取消待发送请求？书籍和阅读位置不受影响。</p><button type="button" onClick={() => setClearConfirm(false)}>保留配置</button><button type="button" onClick={clearAll}>确认清除</button></div>}
    {message && <p className="translation-settings-feedback" role="status">{message}</p>}
    {error && <p className="translation-settings-feedback" role="alert">{error}</p>}
  </section>;
}
