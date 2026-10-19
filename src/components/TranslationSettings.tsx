import { useEffect, useState } from "react";
import { defaultTranslationSettings, translationDestination, unwrapTranslationIPC, type TranslationProfile, type TranslationProviderId, type TranslationSettingsSnapshot } from "../lib/desktopTranslation";
import "../styles/translation-settings.css";

export function TranslationSettings() {
  const [settings, setSettings] = useState(defaultTranslationSettings);
  const [selected, setSelected] = useState<TranslationProviderId>("deepseek");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!window.readTaylorDesktop);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [clearConfirm, setClearConfirm] = useState(false);
  const desktop = window.readTaylorDesktop;
  const profile = settings.profiles.find((item) => item.providerId === selected)!;
  const preset = settings.presets.find((item) => item.id === selected)!;
  const destination = translationDestination(profile.endpoint);
  const keyConfigured = destination && profile.keyOrigins ? profile.keyOrigins.includes(new URL(profile.endpoint).origin) : profile.hasKey;
  const keyOptional = selected === "ollama" && destination?.local;
  const disabled = !desktop || busy || !loaded;

  useEffect(() => {
    let mounted = true;
    if (desktop) void unwrapTranslationIPC(desktop.getTranslationSettings()).then((value) => {
      if (mounted) { setSettings(value); setSelected(value.activeProviderId); }
    }).catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : "翻译配置加载失败，请重试。"); })
      .finally(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, [desktop]);

  function update(patch: Partial<TranslationProfile>) {
    setSettings((previous) => ({ ...previous, profiles: previous.profiles.map((item) => item.providerId === selected ? { ...item, ...patch } : item) }));
    setError(""); setMessage(""); setClearConfirm(false);
  }
  function applySnapshot(snapshot: TranslationSettingsSnapshot, all = false) {
    setSettings((previous) => ({ ...previous, activeProviderId: snapshot.activeProviderId, profiles: all ? snapshot.profiles : previous.profiles.map((item) => item.providerId === selected ? snapshot.profiles.find((saved) => saved.providerId === selected)! : item) }));
  }
  async function saveOrEditKey(editKey: boolean) {
    setBusy(true); setError(""); setMessage("");
    const { hasKey: _, keyOrigins: __, ...config } = profile;
    try {
      if (editKey) {
        const result = await unwrapTranslationIPC(desktop?.editTranslationKey(config));
        applySnapshot(result);
        setMessage(result.keySaved ? "API Key 已加密保存。" : "已取消 Key 录入。");
      } else {
        applySnapshot(await unwrapTranslationIPC(desktop?.saveTranslationSettings(config)));
        setMessage("翻译设置已保存，已选为后续批次使用的配置。");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function clearAll() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await unwrapTranslationIPC(desktop?.clearTranslationSettings());
      applySnapshot(result, true); setSelected(result.activeProviderId); setClearConfirm(false);
      setMessage("全部翻译配置和已保存的 Key 已清除，待发送批次已取消。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "清除失败，请重试。"); }
    finally { setBusy(false); }
  }

  return <section className="translation-settings" aria-labelledby="translation-settings-title">
    <header><h2 id="translation-settings-title">翻译设置</h2><span>OpenAI 兼容协议 · 桌面版</span></header>
    <p className="translation-settings-intro">使用你自己的 API Key。调用将按所选服务商计费。现有阅读页翻译保持原有方式，暂不使用此处设置。</p>
    {!desktop && <p className="translation-settings-notice" role="note">此功能需要 ReadTaylor 桌面版。网页仅展示预设，不保存 Key，也不直接发送大模型请求。</p>}
    <form onSubmit={(event) => { event.preventDefault(); void saveOrEditKey(false); }}>
      <div className="translation-settings-grid">
        <label>服务商预设<select value={selected} disabled={busy || !loaded} onChange={(event) => { setSelected(event.target.value as TranslationProviderId); setError(""); setMessage(""); setClearConfirm(false); }}>{settings.presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>目标语言<select value={profile.targetLanguage} disabled={disabled} onChange={(event) => update({ targetLanguage: event.target.value })}>{Object.entries(settings.languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <label className="translation-settings-wide">接口地址<input type="url" value={profile.endpoint} disabled={disabled} required placeholder="https://example.com/v1" autoComplete="off" spellCheck={false} onChange={(event) => update({ endpoint: event.target.value })} /></label>
        <label>模型名称<input value={profile.model} disabled={disabled} required maxLength={200} autoComplete="off" spellCheck={false} placeholder="填写官方模型名称" onChange={(event) => update({ model: event.target.value })} /></label>
        <label>温度（可选）<input type="number" min="0" max="2" step="0.1" value={profile.temperature ?? ""} disabled={disabled} placeholder="留空使用模型默认值" onChange={(event) => update({ temperature: event.target.value === "" ? null : Number(event.target.value) })} /><small>翻译建议 0–0.3；固定温度模型会省略此参数。</small></label>
        <div className="translation-key-field translation-settings-wide"><label htmlFor="translation-key-state">API Key {keyOptional ? "（可留空）" : "（必填）"}</label><div><input id="translation-key-state" value={keyConfigured ? "已加密保存，不回填 Key" : keyOptional ? "本机接口，无需 Key" : "尚未录入"} readOnly disabled={!desktop} /><button type="button" disabled={disabled} onClick={() => void saveOrEditKey(true)}>{keyConfigured ? "更新 API Key" : "录入 API Key"}</button></div><small>在独立的本地窗口录入；主阅读页面只收到配置状态。修改接口域名后，需要为新域名另行录入 Key。</small></div>
      </div>
      <p className="translation-preset-note">{preset.note} {preset.docs && <a href={preset.docs} target="_blank" rel="noreferrer">服务商官方文档 ↗</a>} 接口与模型以服务商官方文档为准，均可手动修改。</p>
      <p className="translation-destination" role="note">{destination ? <>实际接口：<strong>{destination.domain}</strong>。{destination.local ? "使用本地模型时，内容不会离开本机；若本地服务转发云端，以该服务设置为准。" : "发送前会再次提示该域名和“本批约 N 字符”，由你确认后发送。"}</> : "填写接口地址后，这里会显示实际接口域名。"}</p>
      <footer><button type="button" className="translation-clear" disabled={disabled} onClick={() => setClearConfirm(true)}>清除全部翻译配置</button><button type="submit" className="translation-save" disabled={disabled}>保存当前配置</button></footer>
    </form>
    {clearConfirm && <div className="translation-clear-confirm" role="alert"><p>清除所有服务商配置与 Key，并取消待发送批次？书籍和阅读位置不受影响。</p><button type="button" disabled={busy} onClick={() => setClearConfirm(false)}>保留配置</button><button type="button" disabled={busy} onClick={() => void clearAll()}>确认清除</button></div>}
    {message && <p className="translation-settings-feedback" role="status">{message}</p>}
    {error && <p className="translation-settings-feedback" role="alert">{error}</p>}
  </section>;
}
