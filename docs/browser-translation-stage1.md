# 第 1 步：浏览器翻译设置与请求引擎

范围：设置、Key 存储、连接测试、独立批次请求 API。没有 PDF 提取/分块、阅读页翻译接线、译文展示或块持久化。`src/lib/translation.ts` 与 `api/translate.js` 的百度翻译及“翻译当前页”保持原样。

## 文件与入口

- `src/components/TranslationSettings.tsx`：网页可用的设置表单、隐藏/显示/清除 Key、记住开关、发送前确认、真实连接测试和取消。
- `src/lib/browserTranslation/config.ts`、`presets.json`：公共类型、预设、严格地址校验、隐私文案。保留此前根据服务商官方文档核对的地址/模型，可编辑；不对任何服务商的 CORS 能力作预判。
- `storage.ts`：独立的 `readtaylor.llm.v1.*` 命名空间。公共配置和用户自己的测试结果在 localStorage；默认 Key 在 sessionStorage，显式记住才写 localStorage。Key 按服务商和接口 origin（协议、域名、端口）隔离。关闭记住开关先写会话副本，再删除持久副本；失败会提示，不能保证浏览器拒绝存储操作时的迁移/清除成功。
- `provider.ts`：`TranslationProvider` 接口，当前仅实现 `OpenAICompatibleProvider`。浏览器原生 fetch、AbortSignal、非流式 Chat Completions；依赖注入 fetch/wait/timeout/offline 可做故障测试。JSON 模式不支持时退化 JSON Lines，保留编号校验和有限重试。
- `engine.ts`：纯引擎的批次预览、确认边界、单次消费、过期/配置变化检查、取消。没有接入任何阅读组件。
- `scripts/browser-translation.test.mjs`：假存储、假 Key 和可替换模拟 fetch；不会调用真实模型。
- `scripts/mock-translation-server.mjs`：浏览器手动故障注入用本地服务器，不转发请求。运行 `node scripts/mock-translation-server.mjs`，自定义接口填 `http://127.0.0.1:19877/v1`，Key 只能填公开的假值 `mock-key-not-real`。模型填 `mock-ok` / `mock-model-missing` / `mock-balance` / `mock-rate-limit` / `mock-forbidden` / `mock-server-error` / `mock-bad-format` / `mock-slow` 可触发对应结果；错误 Key 返回 401；接口改为 `http://127.0.0.1:19877/cors-blocked/v1` 可复现浏览器 CORS 拦截。默认允许开发源 `http://127.0.0.1:5173`，其他开发源通过 `MOCK_TRANSLATION_ORIGIN` 环境变量配置。**切勿向模拟服务器填写真实 Key。** 这不能替代真实服务商验收。

旧 `electron/translation/*`、`src/lib/desktopTranslation.ts` 及其测试保留为桌面历史分支，网页入口不引用。网页请求不依赖主进程、IPC 或 safeStorage。没有添加第三方脚本或运行时依赖。

## Key 与隐私边界

输入默认 password，可显示、清除。默认 sessionStorage 刷新保留，正常关闭标签页后清除；浏览器恢复标签页/会话可能恢复数据，不能承诺覆盖所有浏览器的恢复行为。见 [MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)。`rel=noopener` 避免站内打开外部文档时传递 opener。

记住开关旁明确显示：**Key 将以明文保存在本浏览器中，安全性低于系统加密。请勿在公用电脑上开启。** 同源脚本和有相应权限的浏览器扩展可接触浏览器存储；关闭开关/清除全部仅能删除应用能访问的副本，不能撤销备份或已泄露的 Key。WebCrypto 口令加密本轮不实现，代码有 TODO，口令未来也不得保存。

Key 不进入书籍、IndexedDB、译文缓存键、URL、请求正文、日志、错误文案。请求仅在 Authorization 头中带 Key；省略 cookies/referrer，禁用缓存和重定向，防止将 Key 随重定向送给另一域名。接口 URL 不允许用户名、密码、查询参数、片段。只允许 HTTPS；HTTP 仅限精确的 localhost / 127.0.0.1（可指定端口），不包括其他 127.* 地址、IPv6 或局域网地址。用户若误把 Key 填进模型名等非 Key 字段，无法可靠识别任意服务商的密钥格式，切勿这样操作。

设置页和批次预览均包含实际域名与文案：所选正文及必要上下文将由你的浏览器直接发送给 [接口域名]，按该服务商计费。默认不发送图片、表格内部、公式和参考文献。**这是后续阅读页提取策略；当前引擎只接受调用者提供的文本，不会自行判断或剔除表格/公式/参考文献。** 阅读页接入时必须落实此限制，再允许发送。

关闭/休眠标签页可能中断请求；已完成块的保存与恢复留待后续实现。本轮不声称已具备该能力。

## 连接测试与错误

点击测试连接先保存当前配置，再确认目标域名。确认后真实发出一次 `Reply OK.`（9 字符）请求，`stream:false`、`max_tokens:32`，不带书籍正文、不估算金额、不自动重试。部分推理模型可能将小预算全部用于推理：有有效 completion 结构、`finish_reason:length` 的响应可证明可达性与鉴权，不代表译文质量或 JSON 输出能力。

根据 HTTP 状态与上游错误分类：无效 Key、权限不足、余额/额度、模型不存在、限流、服务端网络故障、协议格式错误。上游原始消息只用于分类，不展示，以免包含 Key 或正文。没有 HTTP 响应时，fetch 通常无法让 JS 分辨 CORS、CSP、DNS、TLS、重定向或浏览器本地网络限制，因此显示“疑似跨域（CORS）拦截或浏览器访问限制”，同时给出 Network/控制台检查与服务商配置建议，不武断归因为 CORS。见 [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)。离线、超时、用户取消分别提示。

各预设默认“未测试”；只有用户确认的连接测试更新“可用/不可用”，按 endpoint+model 匹配保存在本机；修改 Key 清除旧结果，普通批次翻译不更新状态。失败状态仅代表该次配置测试失败，不代表服务商永久不支持浏览器直连。

本地 Ollama/其他 loopback 接口允许空 Key。需在本地服务允许本站 Origin（例如 Ollama 的 `OLLAMA_ORIGINS`，只加确切网站来源，不建议通配所有网站），见 [Ollama FAQ](https://docs.ollama.com/faq)。HTTPS 网站访问 HTTP localhost 还会遇到因浏览器而异的本地网络权限/安全限制，CSP 放行也不能覆盖这些限制，见 [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)。仅当本地服务使用真正的本地模型时内容不会离开本机；本地服务如代理云端则另当别论。

## CSP 取舍（用户已确认方案 1，已实现）

原 `index.html` 仅允许同源及开发服务器连接；`vercel.json` 没有额外 CSP 头。静态页面不能在用户保存接口后放宽已经解析的 CSP，修改 meta content 会被忽略，多份 CSP 取交集。见 [W3C CSP meta](https://www.w3.org/TR/CSP3/#meta-element) 与 [多策略规则](https://www.w3.org/TR/CSP3/#multiple-policies)。

可选：

1. **HTTPS 自定义接口（用户已选）**：`connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://127.0.0.1:5173`。最后一项是原有开发 HMR 连接。引擎仍仅向当前配置的精确地址发请求，要求确认、拒绝远程 HTTP、禁止 URL 密钥和重定向。优点是自定义接口无需重新部署。代价是 CSP 不能再限制被攻陷的同源脚本向其他 HTTPS 站点外传数据；应用级校验不能替代 CSP 的这层保护。仍维持严格 `script-src 'self'`，不新增第三方脚本。
2. **固定域名白名单**：仅列预设域名/必要地区域名和 loopback。对自定义域名在 UI 明示“部署白名单未授权”，需要修改部署配置并重新部署。更严格，降低自定义地址的即填即用能力。预设切换也不是只放行当前一个域名。

两种方案都不能替服务商开启 CORS。要精确地随每个用户配置域名生成 CSP，需要页面加载前的动态响应/独立受限文档等额外架构，已经超出当前静态页面的小改造范围。用户确认可接受方案 1 的上述风险；如果以后想收紧，可以将 `https:` 改为固定域名白名单，同时在设置页限制未授权的自定义域名，并重新部署。此时需同步维护地区端点，不能通过修改运行中的 meta 来放宽。

## 代理备选设计（仅设计，未实现）

若用户测试确认某接口不能 CORS 直连，可后续单独确认实现同源 Vercel Function/Edge 转发：

1. 前端逐次携带用户 Key（请求头）与最小翻译正文，绝不把 Key 放 URL。函数只在处理本次请求时使用，不写数据库/磁盘/缓存/队列，响应 `Cache-Control:no-store`。前后端均避免请求体、Authorization、原始异常日志；监控/追踪工具也要禁用相应采集并脱敏。平台仍可能保留访问元数据，不能承诺“Vercel 看不到”。
2. 前端传预设 ID，服务器映射**写死的 HTTPS 主机与 chat-completions 路径**，不接受任意 URL、IP、端口、协议或重定向；拒绝 loopback/私网与用户提供的代理链，避免开放代理及 SSRF。模型/温度/消息等字段逐项校验，丢弃其他上游头和响应头。
3. 本轮引擎上限对应建议请求上限 128 KiB、响应 4 MiB、单请求超时 90 秒、禁止流式和自动代理重试；部署前再按平台限制调整，不把平台更宽的上限当应用上限。见 [Vercel Functions limits](https://vercel.com/docs/functions/limitations)。
4. 仅接受本站来源/同源调用，但 Origin 校验不能阻止伪造来源的服务器滥用。公开部署需要 WAF/可信网关的速率限制，或短期 IP 摘要计数（如每分钟 10 次，按实际用量校准）和并发上限。**跨实例有效限流不能只用函数内存**；WAF 或外部计数存储需要额外配置，可能持有 IP/摘要及时间元数据，但不保存 Key/正文。无状态指转发业务不持久保存 Key/文本，不表示无需限流基础设施。未配置有效限流时不应公开启用该代理。
5. 部署增加函数调用、运行时间、流量/限流设施等配额与潜在费用，服务商仍按用户 Key 计费；平台方案/地区/限制以部署时官方文档为准。超出限额要友好报错，不自动改用其他供应商。

**隐私代价**：直连时正文与 Key 从浏览器到服务商；代理时网站运营方的函数与托管平台成为额外经手方，在内存中可接触 Key/正文。TLS 加密链路无法消除这项信任。即使应用不记录正文/Key，平台访问日志与风控仍可能处理 IP、时间、状态码等元数据。

**界面必须明确区分模式**：“当前使用中转：所选正文和 API Key 将先经过 ReadTaylor 的 [实际代理域名]，再转发至 [服务商域名]。应用不保存 Key 或正文；托管平台可能保留访问元数据。仍按服务商计费。” 首次切换要用户确认；默认保持直连；直连失败只解释原因，不偷偷切代理。代理界面、函数与部署在本轮均未实现。

## 验证

自动测试：

```powershell
node --test scripts/browser-translation.test.mjs scripts/translation-api.test.mjs scripts/pdf-position.test.mjs scripts/desktop-translation.test.mjs electron/converter.test.cjs electron/translation.test.cjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

手动：

1. 网页“设置”里录入一个测试 Key，默认隐藏；显示/隐藏/清除可用。切预设再切回不丢 Key；域名改变不携带旧 Key。
2. 默认模式保存并刷新，Key 保留；正常关闭标签页、重新从地址打开（不要恢复关闭标签页）时 Key 消失。开启记住，刷新/新标签页仍有；关掉记住后 localStorage 不再有该接口 Key。
3. DevTools Application 检查：仅专用会话 credential 项含 Key，未记住时 localStorage 无 Key；书籍和译文 IndexedDB 不应出现 Key。Network 只允许 Key 在 Authorization 头，URL/正文无 Key；控制台不应打印 Key。
4. 由用户**直接在本地设置输入真实 Key，不发聊天**，测试一次成功，再用假 Key/错误模型各一次。若浏览器隐藏 HTTP 错误，显示专用跨域/浏览器限制说明，不能假称鉴权错误已验证。失败不产生金额估算。
5. 测试状态刷新保留，改变模型/地址或更新 Key 后变“未测试”；测试中取消、清除全部均中止请求；清除后所有专用配置/Key/测试记录消失，书籍不变。
6. 窄屏、夜间模式字段和按钮可用；现有 PDF 分栏、恢复位置、页码及百度翻译入口保持原行为。

## 本轮验收记录

- 用户在自己的浏览器中录入阿里云 Key，选择通义千问后确认真实连接测试成功；随后确认错误 Key 显示“API Key 无效或已过期…”，错误模型显示“模型名不存在或账号无调用权限…”。这是**用户本地操作并反馈的验收**，代理未读取、复制或记录真实 Key；自动测试始终只使用假 Key。
- 实际浏览器另用本地模拟服务器验证了成功、401 错误 Key、404 错误模型和真实的 CORS 拦截；不是只靠 Node fetch 模拟跨域。CORS 失败有专门说明。
- 实际浏览器检查了会话保存后刷新、记住开关、服务商切换隔离、清除全部，以及 390px 窄屏和夜间模式。浏览器 DevTools 对用户真实存储、URL、控制台及 IndexedDB 的最终检查仍按上方手动清单执行，不宣称代理检查了用户浏览器里的真实 Key。
- 修复了浏览器原生 fetch 的 Window receiver 绑定问题，并增加针对性回归测试；开发热更新后的错误类型识别也有回归测试，避免把已分类错误吞成泛化提示。
- 最终自动检查：55/55 项测试通过（其中浏览器翻译 21 项），TypeScript `--noEmit` 和 Vite 生产构建通过；未修改 PDF 阅读、百度翻译及原有未提交的 `room.css`。
- 阿里云签发的 Key 需调用阿里云对应地域接口，即便模型是阿里云托管的 DeepSeek，也不能将该 Key 直接用于 DeepSeek 官方域名。界面提示按 Key 的签发平台选择服务商；地区/模型开通以官方文档为准。

发布：本轮不 push、不部署；用户本地验证并明确同意后才推送。
