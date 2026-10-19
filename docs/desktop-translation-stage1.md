# 桌面翻译基础：自备 API Key

本阶段只新增「设置 → 翻译设置」与 Electron 批次接口。没有接入 PDF、EPUB 等阅读页面；既有百度翻译路径保持原样。网页可查看预设，但不能保存 Key 或发送大模型请求。

## 进程与存储边界

- 主页面仅通过 preload 暴露的具名方法调用 IPC，不得到 API Key 或加密密文；不向服务商直接发请求。
- Key 通过独立的本地窗口录入。该窗口没有页面脚本和联网权限，只有隔离的 preload 将输入提交至主进程。主进程仅接受该窗口顶层 frame 的 Key 提交。
- `safeStorage.encryptString/decryptString` 只在主进程使用。文件为 `app.getPath("userData")/translation-config.v1.json`，Key 按服务商及实际接口 origin 分开加密保存。切换服务商或切回旧域名可恢复对应 Key 的配置状态，不回填 Key。
- 系统安全存储不可用或 Linux 退回 `basic_text` 时拒绝存储和使用 Key，不降级为明文。
- 远程接口要求 HTTPS。请求禁止自动跟随重定向，以防 Key 被转发到其他域名。接口地址不得包含 URL 账号、密码、查询参数或片段。
- 清除全部配置会移除配置文件、取消待确认/进行中的批次；已经到达服务商的内容无法撤回。
- 本地接口识别 localhost、IPv4 回环和 IPv6 回环。本地 Ollama 允许 Key 为空；远程地址及其他预设必须填写 Key。本地预设拒绝云模型标签；本地服务若自行代理到云端，其内容流向以该服务设置为准。

## 官方预设核对

核对日期：2026-10-19。下列是可修改的起始值，不代表全部模型，也不保证账号已获得模型权限。没有记录或估算价格。

- DeepSeek：`https://api.deepseek.com`，`deepseek-flash`。[官方快速开始](https://api-docs.deepseek.com/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`，`qwen-plus`。该北京地域通用域名仍可使用；官方建议迁移到业务空间专属域名，需按账号业务空间与地域修改地址和 Key。[官方 OpenAI 兼容文档](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[qwen-plus 调用示例](https://help.aliyun.com/zh/model-studio/model-calling-in-sub-workspace)。
- Kimi：`https://api.moonshot.cn/v1`，`kimi-k3`。K3 / K2.7 Code / K2.6 固定温度，当前实现按官方要求不发送该参数。[官方快速开始](https://platform.kimi.com/docs/get-api-key)、[模型参数参考](https://platform.kimi.com/docs/api/models-overview)、[JSON Mode](https://platform.kimi.com/docs/guide/use-json-mode-feature-of-kimi-api)。
- 智谱：`https://open.bigmodel.cn/api/paas/v4`，`glm-5.3`。使用标准模型 API 凭证，套餐端点及权限需按账号核对。[官方快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start)。
- OpenRouter：`https://openrouter.ai/api/v1`，`~openai/gpt-sol-latest`。使用官方快速开始的模型别名，可手动改为其他可用模型；是否支持 JSON 与温度由具体模型决定。[官方快速开始](https://openrouter.ai/docs/quickstart)。
- 本地 Ollama：`http://localhost:11434/v1`，`gpt-oss:20b`。先下载本地模型，也可填写本机已安装的其他模型名。[官方 OpenAI 兼容文档](https://docs.ollama.com/api/openai-compatibility)。
- 自定义：地址与模型均由用户输入，支持基础地址或完整 `/chat/completions` 地址。

请求结构依据 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat)，存储边界依据 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) 与 [contextIsolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。

## 批次接口（暂未接入阅读页）

页面侧封装：`src/lib/desktopTranslation.ts`。

1. 调用 `previewDesktopTranslationBatch({ providerId?, segments: [{ id: "p16-1", text: "Source text" }] })`。
2. 预览不发网络请求，返回 `previewId`、实际域名/完整接口、模型、目标语言、字符数和提示；原文与 Key 不在预览返回值中。
3. 调用 `sendDesktopTranslationBatch(previewId)`；主进程弹出原生确认，显示「本批约 N 字符」、实际域名、模型、语言和计费/重试说明。用户取消时不会发送。
4. 确认后主进程解密并使用对应 Key，发送非流式 Chat Completions 请求。`previewId` 只能用一次、5 分钟过期；配置变化使旧预览失效。
5. 返回 `{ translations: [{ id, text }], targetLanguage, characterCount, attempts, warnings }`。不会返回 Key、原始响应或上游报错全文。

每批 1–100 段、最多 12000 个 Unicode 字符。编号必须唯一，使用字母/数字/下划线/点/连字符，不会自动合并或改变原文。优先 `response_format: {type: "json_object"}`；明确不支持时省略参数并改用 JSON Lines 提示词约束。结果逐条校验编号、数量、非空译文，再按输入顺序返回；不把输出直接交给页面执行。

格式错误、网络失败、限流和临时服务故障最多重试两次；JSON/温度兼容性降级各至多一次，总请求数最多五次。无效 Key、余额不足、模型错误等不会自动重试；长度截断提示缩小批次。温度默认 0.2，可留空；固定温度的 Kimi 模型默认留空，已知限制会提前省略；其他模型明确拒绝温度时可降级并返回提示。

## 测试与故障注入

```powershell
node --test electron/*.test.cjs scripts/desktop-translation.test.mjs scripts/pdf-position.test.mjs scripts/translation-api.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

`electron/translation/mock.cjs` 提供 `createMockTranslationFetch(steps)` 和 `mockCompletion(rows)`。将模拟的 `fetchImpl` 传给 `new OpenAICompatibleProvider({ fetchImpl, wait, timeoutMs })`，即可按顺序注入正常响应、HTTP 错误、格式错误、网络异常和超时；不会联网。`createTranslationService` 还可替换 `providerFactory`、`confirmSend` 与时钟，测试取消、过期和配置变化。

测试 Key 是明确标记的假字符串，存储测试使用进程内临时 AES 加密器替代系统服务；不读取用户配置、不使用真实 Key。单元测试不能替代真实操作系统凭据服务及各账号权限验收。
