# CC Switch 生产验收矩阵（2026-05-19）

## 目标

这份矩阵用于替代“测试全绿但仍有页面细节和交互漏洞”的失真验证方式。
核心原则不是堆更多单元测试，而是按真实用户入口、真实页面结构、真实配置写入和真实请求链路做逐项验收。

## 验收标准

只有同时满足以下条件，某一项才可判定为“通过”：

1. 页面或功能有明确入口。
2. 关键用户交互经过模拟操作验证。
3. 涉及配置写入时，验证写入目标和结果状态。
4. 涉及请求链路时，验证前端请求参数和后端返回后的 UI 状态。
5. 涉及跨页面/跨页签状态时，验证切换前后不会串页、串状态、误覆盖。

## 当前批次重点

本批次优先覆盖过去最容易“测试通过但实际出错”的高风险区域：

- 顶层页面切换与工具栏入口
- `SettingsPage` 真实页签结构
- `Api-Hub` 页签挂载、隐藏、切换和状态保持
- 供应商页核心交互链路
- 会话管理页核心交互链路
- 代理 / 接管 / 故障转移相关状态可视化和入口行为

## 页面与功能矩阵

| 模块 | 页面 / 入口 | 关键验收点 | 配置 / 请求风险 | 当前覆盖状态 |
| --- | --- | --- | --- | --- |
| 顶层导航 | `App.tsx` 主界面 | 顶层按钮切换到各视图、返回逻辑、不同 app 的工具栏按钮隔离 | `currentView`、`activeApp` 串页、入口错乱 | 已补真实导航验收 |
| 设置 | `SettingsPage` | `general / proxy / auth / advanced / usage / apiHub / about` 顺序、切换、显示隔离 | 页签内容串页、隐藏态内容误显示 | 已补真实页签验收 |
| Api-Hub | `SettingsPage` -> `ApiHubPanel` | 页签切换后状态保持、列表筛选、批量同步、批量对齐、清理 / 删除确认、导入弹窗 | 会话态污染、请求参数错误、状态错位、导入供应商后 live 配置被 direct base URL 覆盖 | 已补真实 SettingsPage + Api-Hub 页面级验收；已覆盖挂载 / 隐藏 / 状态保持、筛选、清理、删除、同步、对齐、导入请求参数，以及 Claude 接管 + 故障转移下 Api-Hub 操作后 live 配置不漂移 |
| 供应商管理 | `ProviderList` / `AddProviderDialog` / `EditProviderDialog` | 增删改查、搜索、排序、批量启用、模板应用、故障转移入口、代理活动状态 | 配置覆盖、排序错乱、模板误写入、活动请求串 app 或串 provider | 已补真实 App + ProviderList 以及 Add / Edit ProviderForm 页面级验收；已覆盖 OpenCode / OpenClaw 新增和编辑表单链路、additive 批量写入 / 移出、单项移出确认、删除确认、模板批量套用保留凭据；已补 Claude 接管 + 故障转移队列清空后 live 配置不漂移验收；已补 `proxy-activity-updated` 事件驱动的「请求中」行状态隔离验收；仍需继续扩展 Hermes 表单链路和故障转移 UI 面板验收 |
| 会话管理 | `SessionManagerPage` | 搜索、项目分组、删除、批量删除、重命名、导出、恢复终端、过滤 | 选择态和搜索态错乱、删除后 UI 不一致、标题映射串 app、恢复 / 导出请求参数错误 | 已补真实 App + SessionManagerPage 页面级验收；已覆盖搜索隔离、单删、批量删除、重命名、恢复终端、导出 Markdown |
| Prompts | `PromptPanel` | 打开、返回、新建、编辑、启用、删除、导入事件刷新 | 与顶层视图切换耦合、请求 app 归属串页、提示词启用状态误覆盖 | 已补真实 App + PromptPanel 页面级验收；已覆盖启用互斥、编辑、新增、删除确认、跨 app 隔离、`prompt-imported` 事件按 app 刷新 |
| Skills | `UnifiedSkillsPanel` / `SkillsPage` | 管理页、发现页切换、导入、安装 ZIP、恢复备份、应用开关 | 面板状态丢失、入口错乱、安装来源错写、应用归属串页 | 已补真实 App + Skills 页面级验收 |
| MCP | `UnifiedMcpPanel` | 打开、导入现有、添加、应用开关、删除 | 配置写入和入口错乱 | 已补真实 App + MCP 页面级验收 |
| Workspace / OpenClaw | `WorkspaceFilesPanel` / `EnvPanel` / `ToolsPanel` / `AgentsDefaultsPanel` | OpenClaw 专属入口切换和按钮隔离、Workspace 文件存在探测、打开目录、编辑保存、缺失文件创建、Env JSON 加载 / 保存 / 非法输入拦截、Tools allow / deny 配置写入、Agents 默认模型和运行参数写入 | app 切换后工具栏按钮错位、workspace 写错文件、Env 误提交非法 JSON、保存后状态不刷新、Tools / Agents 配置被覆盖或 legacy 字段迁移错误 | 已补真实 App + WorkspaceFilesPanel、EnvPanel、ToolsPanel、AgentsDefaultsPanel 页面级验收；已覆盖配置写入、未知字段保留、legacy timeout 迁移和不支持值保留 |
| Hermes | `HermesMemoryPanel` | Hermes 专属入口切换、Memory / User 内容加载、启停开关、保存、打开配置入口、页签隔离 | app 切换后入口错乱、保存落错文件、Memory / User 串写、配置入口参数错误 | 已补真实 App + HermesMemoryPanel 页面级验收；已覆盖 Memory / User 加载、启停、保存、打开 config、双页签隔离 |
| WebDAV | `WebdavSyncSection` | 保存、测试连接、上传、下载、确认弹窗、普通设置保存隔离 | 密码字段保留和误提交、`webdavSync` 被普通 `save_settings` 误覆盖 | 已补真实 SettingsPage + WebDAV 页面级验收 |
| 导入导出 | `ImportExportSection` | 选择文件、导入、导出、清空状态 | 导入成功回调、错误态恢复 | 已补真实 SettingsPage + ImportExport 页面级验收 |
| 代理状态 | 顶栏活动条 / `UsageDashboard` / `RawProxyLogPanel` / `ProviderList` | 活动条显示、请求模型和上游模型显示、详情跳转、供应商行活动状态 | 活动计数错乱、模型展示错配、活动请求状态跨 app 串页 | 已补真实 ProviderList 代理活动事件页面级验收；已补真实 App 顶栏活动条页面级验收；已有 Usage / Raw Proxy Log / 请求详情相关验收，顶栏活动条当前不承担详情入口 |

## 已识别的测试失真来源

以下模式会导致“测试通过但真实 UI 有问题”：

1. 把 `Tabs` 完整 mock 掉，导致真实页签的挂载、隐藏和 `data-state` 行为无法验证。
2. 把 `ApiHubPanel` 等问题组件本体 mock 掉，导致串页、错位、状态保持类问题无法暴露。
3. 只测单个组件，不测顶层入口切换，导致页面组合后的真实结构问题漏检。
4. 只验证请求调用成功，不验证返回后页面状态是否保持一致。
5. 测试文件修改全局 prototype 或注册 Tauri 事件监听后未恢复，导致单文件通过但组合运行时污染后续真实页面验收。

## 本批次执行顺序

1. 补 `SettingsPage` 真实页签结构验收。
2. 补 `App` 顶层导航与视图切换验收。
3. 把 `ProviderList`、`Api-Hub`、`SessionManagerPage` 纳入页面级串联验收。
4. 继续向 OpenClaw / Hermes / Skills / MCP / WebDAV 扩展。
5. 每补一批验收，立即运行并记录实际结果，再决定是否修复实现。

## 结果记录规则

后续每个批次需要补充以下信息：

- 新增验收文件
- 覆盖的页面 / 功能点
- 执行命令
- 通过 / 失败结果
- 若失败，记录真实缺陷与修复提交

## 2026-05-19 批次结果

### SettingsPage 真实页签验收

- 新增验收文件：`tests/integration/SettingsPage.real-tabs.test.tsx`
- 覆盖范围：真实 `Tabs`、真实 `ApiHubPanel` 挂载、`general -> apiHub -> general -> apiHub` 切换、Api-Hub 隐藏态不可访问、筛选状态保持、默认 `apiHub` 页签顺序。
- 修复内容：`SettingsPage` 的 `apiHub` 内容区补充显式 `hidden` / `aria-hidden`，默认页签初始化收口为“仅打开时初始化”，避免 `forceMount` 内容串到其它页签。
- 验证命令：`pnpm vitest run tests/integration/SettingsPage.real-tabs.test.tsx`
- 当前结果：`2 passed, 0 failed`

### SettingsPage + Api-Hub 真实页面验收

- 更新验收文件：`tests/integration/SettingsPage.real-api-hub.test.tsx`
- 覆盖范围：真实 `SettingsPage`、真实 `Tabs`、真实 `ApiHubPanel`、真实导入弹窗、真实批量同步 / 对齐按钮、真实清理 / 删除确认弹窗；只 mock 与 Api-Hub 链路无关的其它设置页区块。
- 覆盖交互：从 `apiHub` 页签加载站点列表，切换站点类型筛选，输入搜索词；执行清理站点和删除记录，并验证确认前不发请求、确认后请求参数准确；选中站点后执行批量同步、批量对齐，派发 `api_hub_sync_progress` / `api_hub_align_progress` 事件验证按钮状态；打开导入应用弹窗，选择目标 app、模型和无默认模型导入选项，确认后验证 `api_hub_import_to_apps` 请求。
- 配置漂移验证：在 Claude 本地代理、接管和自动故障转移均开启时，先把 Claude live settings 人为置为 `https://claude-beta.example.com`；随后通过真实 Api-Hub 页面执行同步、对齐、导入 Claude 应用，并让模拟后端触发一次当前供应商 live 同步；每一步后断言 `ANTHROPIC_BASE_URL` 恢复并保持 `http://127.0.0.1:15721`，`ANTHROPIC_AUTH_TOKEN` 保持 `PROXY_MANAGED`，不会漂移成 Claude 供应商或 Api-Hub 站点 base URL。
- 请求验证：导入 Claude 时断言 `target_apps` 为 `["claude"]`，`selections` 为 `default / claude-4`，并验证前端生成的 `settings_configs["claude::default::claude-4"]` 包含 Api-Hub 供应商 direct base URL 和 `__API_HUB_API_KEY__` 占位符，但该 direct 配置不会写入当前 Claude live takeover 文件。
- 红绿记录：临时让 `api_hub_sync_sites` handler 不调用 `syncCurrentProvidersLiveState()` 后，同一用例按预期失败，收到 `https://claude-beta.example.com`；恢复同步修复后同一用例通过，证明该用例能捕获 Api-Hub 操作后的 live 漂移。
- 新增用例验证命令：`pnpm exec vitest run tests/integration/SettingsPage.real-api-hub.test.tsx -t "keeps Claude takeover live config" --reporter=verbose`
- 新增用例验证结果：`1 test passed, 2 tests skipped, 0 failed`
- 全文件验证命令：`pnpm exec vitest run tests/integration/SettingsPage.real-api-hub.test.tsx --reporter=verbose`
- 全文件验证结果：`1 file passed, 3 tests passed, 0 failed`
- 组合验证命令：`pnpm exec vitest run tests/integration/SettingsPage.real-api-hub.test.tsx tests/integration/App.real-settings-api-hub-tabs.test.tsx tests/integration/SettingsPage.real-proxy-failover.test.tsx tests/integration/App.real-header-proxy-failover.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`4 files passed, 7 tests passed, 0 failed`

### App 顶层真实导航验收

- 新增验收文件：`tests/integration/App.real-navigation.test.tsx`
- 覆盖范围：真实 `App` 顶栏设置入口、更新入口、接管态用量入口、真实 `AppSwitcher` 切换、普通 app 的 Skills / Prompts / Sessions / MCP 入口、OpenClaw 的 Workspace / Env / Tools / Agents / Sessions 专属入口、Hermes 的 Skills / Memory / MCP 专属入口、选中 app 后新增供应商弹窗归属。
- 修复内容：`AppSwitcher` 的 app 切换按钮补充明确 `aria-label`，避免图标内部 `<title>` 与文本共同组成错误可访问名称，导致真实键盘 / 读屏入口不稳定。
- 测试夹具：MSW 状态新增可配置的 `proxyTakeoverStatus`，用于真实模拟接管态下的顶栏用量入口。
- 验证命令：`pnpm vitest run tests/integration/App.real-navigation.test.tsx`
- 当前结果：`7 passed, 0 failed`

### Provider live / 接管 / 故障转移回归

- 覆盖文件：`src-tauri/src/services/provider/mod.rs`
- 覆盖范围：无 endpoint 历史配置的 live owner 锚点匹配、接管开关仍开启但代理进程未运行时的 live 保持、接管 restore backup 刷新。
- 修复内容：`live_settings_belong_to_provider_with_anchor` 在 endpoint 缺失时改为优先用 `live_owner_provider_id` 判定归属；`sync_current_provider_for_app_with_options` 判断接管 live 时只依赖接管开关和 app 类型，避免故障转移全熔断后把 live 写回某个供应商 baseUrl。
- 验证命令：`cargo test --test provider_service`
- 当前结果：`17 passed, 0 failed`

### App + ProviderList 真实页面验收

- 新增验收文件：`tests/integration/App.real-providers.test.tsx`
- 覆盖范围：真实 `App`、真实 `AppSwitcher`、真实 `ProviderList` 和真实 provider hooks；只 mock 与本链路无关的重型子页面和弹窗外壳。
- 覆盖交互：Claude / Codex 跨应用切换后供应商列表不串页；当前供应商状态按 app 隔离；搜索只定位不过滤且切换 app 后重置；切换当前供应商只影响当前 app；编辑 / 用量配置弹窗收到当前 app 的 provider；复制供应商只新增到当前 app；`proxy-activity-updated` 事件只让当前 app 对应 provider 行显示「请求中」。
- 覆盖 live 配置：OpenCode / OpenClaw / Hermes 三类 additive 应用分别使用不同 live provider ids，真实切换页面后验证“使用中 / 禁用”状态只来自当前 app 的 live 配置，不会把其它 app 的 live 状态带入当前页。
- 新增覆盖：OpenCode additive provider 批量“写入配置 / 移出配置”只变更当前 app 的 live ids，不删除 provider，不影响 OpenClaw / Hermes；单项移出 live 配置必须先弹确认，取消不改状态，确认后仅移出 live ids；删除 provider 必须先弹确认，取消不改状态，确认后删除 provider 并清理 additive live ids；Codex provider 配置模板从真实 App 页面批量套用时只更新模板字段，保留每个供应商已有 API key / base URL，不影响 Claude。
- 修复内容：`ProviderList` 接入 `onRemoveFromConfig`，表格版 additive provider 单项移出恢复走 App 级确认链路；MSW `deleteProvider` 与生产语义对齐，删除 provider 时同步清理 additive live ids。
- 测试夹具：补齐 `list_recent_sessions`、OMO 当前供应商、Claude Desktop 状态、OpenClaw model catalog / default model、Hermes model config、当前配置文件读写、流式检查、`remove_provider_from_live_config`、`open_provider_terminal` 等 MSW 默认响应，保证真实 `ProviderList` 页面运行时不会被无关未处理请求干扰。
- 验证命令：`pnpm vitest run tests/integration/App.real-providers.test.tsx`
- 当前结果：`13 passed, 0 failed`

### App + ProviderList 代理接管 / 故障转移 live 漂移验收

- 覆盖文件：`tests/integration/App.real-providers.test.tsx`、`tests/msw/state.ts`、`tests/msw/handlers.ts`
- 覆盖范围：真实 `App`、真实 `ProviderList`、真实 failover hooks、真实 `settingsApi.syncCurrentProvidersLive()` 前端调用链；MSW / Tauri mock 补齐 proxy server、proxy takeover、app proxy config、failover queue、live settings 观测点。
- 覆盖交互：预置本地代理运行、Claude 接管开启、故障转移开启；从真实供应商列表行内开关把 `Claude Alpha` / `Claude Beta` / `Claude Gamma` 加入故障转移队列，再逐个移出，模拟所有供应商不可用后队列清空。
- 配置验证：先把 Claude live settings 人为置为 `https://claude-alpha.example.com`，模拟用户反馈的漂移状态；随后通过 `settingsApi.syncCurrentProvidersLive()` 触发 `sync_current_providers_live`，断言 `ANTHROPIC_BASE_URL` 恢复为 `http://127.0.0.1:15721`，`ANTHROPIC_AUTH_TOKEN` 为 `PROXY_MANAGED`，且不等于任一供应商 base URL。
- 红绿记录：临时把 `syncCurrentProvidersLiveState()` 改回旧错误语义后，新增用例按预期失败，收到 `https://claude-alpha.example.com`；恢复代理接管优先同步 live 模板后，同一用例通过。
- 最小验证命令：`pnpm vitest run tests/integration/App.real-providers.test.tsx -t "keeps Claude live config on proxy takeover after failover queue becomes empty" --fileParallelism=false --reporter=verbose`
- 最小验证结果：错误语义下 `1 failed`；恢复正确语义后 `1 passed, 8 skipped, 0 failed`
- 组合验证命令：`pnpm vitest run tests/components/ApiHubPanel.test.tsx tests/integration/App.real-providers.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`2 files passed, 21 tests passed, 0 failed`

### App + Add / Edit ProviderForm 真实页面验收

- 新增验收文件：`tests/integration/App.real-provider-forms.test.tsx`
- 覆盖范围：真实 `App`、真实 `ProviderList`、真实 `AddProviderDialog`、真实 `EditProviderDialog`、真实 `ProviderForm`；只 mock 与供应商表单链路无关的 Skills / MCP / Sessions / OpenClaw / Hermes / Settings 等重型页面。
- 覆盖交互：从真实顶栏新增入口打开 OpenCode / OpenClaw 新增供应商弹窗，填写 provider key、display name、base URL、API key 后提交；再从真实列表编辑 DB-only OpenCode / OpenClaw provider，将 provider key 改名并提交。
- 配置验证：新增 OpenCode 后验证 `providers["opencode-new"]` 存在，`settingsConfig.options.baseURL` / `apiKey` 写入正确，且 additive live ids 包含新增 provider；新增 OpenClaw 后验证 `providers["openclaw-new"]` 存在，`settingsConfig.baseUrl` 自动去尾斜杠，`apiKey`、`api: "openai-responses"` 和默认模型列表写入正确，且 additive live ids 只追加 OpenClaw provider。
- 编辑验证：编辑 OpenCode / OpenClaw DB-only provider 后验证旧 id 删除、新 id 存在，并通过 `originalId` 语义避免残留旧记录；DB-only provider 编辑不会改写既有 live provider membership。
- 隔离验证：OpenCode / OpenClaw 的 additive live ids 只影响当前 app，不串到 Hermes，也不会把 OpenClaw provider 写入 OpenCode 或 Hermes provider state。
- 测试夹具：MSW 新增 additive app 判断、`addProviderToLiveConfig`、`removeProviderFromLiveConfigState`，并让 `add_provider` 支持 `addToLive`、`switch_provider` 更新 additive live ids、`update_provider` 传递 `originalId`。
- 红绿记录：首次运行暴露 `add_provider` 后 live ids 未模拟写入，补齐 MSW 后通过；编辑 live provider key 的用例改为 DB-only provider，因为生产规则会锁定 live config 中的 provider key，避免 orphan live 配置。本轮追加 OpenClaw 后，临时把新增 OpenClaw 用例的 live ids 断言改错为只期待 `["openclaw-live"]`，同一用例按预期失败；恢复为 `["openclaw-live", "openclaw-new"]` 后 OpenClaw 目标用例通过。
- 新增 OpenClaw 目标验证命令：`pnpm exec vitest run tests/integration/App.real-provider-forms.test.tsx -t OpenClaw --reporter=verbose`
- 新增 OpenClaw 目标验证结果：`1 file passed, 2 tests passed, 2 skipped, 0 failed`
- 红灯自检命令：`pnpm exec vitest run tests/integration/App.real-provider-forms.test.tsx -t "adds an OpenClaw provider" --reporter=verbose`
- 红灯自检结果：临时错误断言下 `1 failed, 3 skipped`，失败信息为实际 live ids `["openclaw-live", "openclaw-new"]` 不等于错误期望 `["openclaw-live"]`。
- 验证命令：`pnpm vitest run tests/integration/App.real-provider-forms.test.tsx`
- 当前结果：已扩展为 OpenCode / OpenClaw 共 4 个真实页面用例；全文件验证 `1 file passed, 4 tests passed, 0 failed`。
- 组合验证命令：`pnpm exec vitest run tests/integration/App.real-provider-forms.test.tsx tests/integration/App.real-providers.test.tsx tests/integration/App.real-openclaw-agents.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`3 files passed, 19 tests passed, 0 failed`
- 类型验证命令：`pnpm typecheck`
- 类型验证结果：`tsc --noEmit` 通过。
- Diff 检查命令：`git diff --check`
- Diff 检查结果：通过，无空白错误。

### App + SessionManagerPage 真实页面验收

- 新增验收文件：`tests/integration/App.real-sessions.test.tsx`
- 覆盖范围：真实 `App`、真实顶栏返回 / 入口、真实 `SessionManagerPage`、真实 sessions hooks；只 mock 与会话链路无关的供应商页和其它重型面板。
- 覆盖交互：从真实工具栏进入会话页；会话页返回供应商页后切换 app，再重新进入会话页；Claude / Codex 会话列表、详情标题和消息按当前 app 隔离；搜索只作用于当前 app；切换 app 后搜索态重置；删除确认只删除当前 app 的目标会话，不影响另一 app 会话；批量管理 -> 全选当前 -> 批量删除 -> 确认，只删除当前 app 的会话；修改名称弹窗保存后更新当前会话标题；恢复会话触发终端启动请求；导出会话触发 Markdown 导出请求。
- 配置 / 请求验证：`set_session_title_mapping` 记录 `appType`、`sessionId`、`sourcePath`、`customTitle` 并更新 MSW 会话状态；`delete_sessions` 记录批量删除 items 并验证 Codex 会话仍保留；`launch_session_terminal` 记录 `command` / `cwd`；`export_session_markdown` 记录导出的 `SessionMeta`，确保导出对象包含重命名后的标题。
- 测试夹具：MSW / Tauri mock 补齐 `set_session_title_mapping`、`clear_session_title_mapping`、`launch_session_terminal`、`export_session_markdown`，并新增标题映射、批量删除、终端恢复、Markdown 导出的请求观测点。
- 红绿记录：新增真实页面用例后，首次运行因缺少 `set_session_title_mapping` 处理器和批量删除请求观测点失败；补齐 MSW 会话命令模拟和状态记录后，同一文件重跑通过。
- 真实结构说明：当前产品在 `sessions` 视图下顶栏不显示 `AppSwitcher`，只能通过返回供应商页后切换应用再进入会话页；验收用例按这个真实可操作路径执行。
- 验证命令：`pnpm vitest run tests/integration/App.real-sessions.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`5 passed, 0 failed`

### App + Skills / MCP 真实页面验收

- 新增验收文件：`tests/integration/App.real-skills-mcp.test.tsx`
- 覆盖范围：真实 `App`、真实顶层入口、真实 `UnifiedSkillsPanel`、真实 `SkillsPage`、真实 `UnifiedMcpPanel`；只 mock 与 Skills / MCP 链路无关的供应商页、会话页和其它重型面板。
- 覆盖交互：Skills 管理页导入现有技能、ZIP 安装、恢复备份、应用开关；Skills 发现页安装远端技能、管理仓库来源；MCP 导入现有配置、应用开关、新增 server、删除 server。
- 测试夹具：MSW 状态补齐 installed / unmanaged / discoverable skills、skill repos、backup、updates、skills.sh 搜索结果、MCP server 状态和 app 归属变更。
- 验证命令：`pnpm vitest run tests/integration/App.real-skills-mcp.test.tsx`
- 当前结果：`3 passed, 0 failed`

### SettingsPage + WebDAV 真实页面验收

- 新增验收文件：`tests/integration/SettingsPage.real-webdav.test.tsx`
- 覆盖范围：真实 `SettingsPage`、真实 `Tabs`、真实 `Accordion`、真实 `WebdavSyncSection`；只 mock 与 WebDAV 无关的重型设置区块。
- 覆盖交互：从高级页签展开云同步，填写 WebDAV URL、用户名、密码、远端根目录、profile，确认自动同步风险提示，点击 WebDAV 保存，随后自动测试连接；再通过真实确认弹窗执行上传和下载。
- 配置隔离验证：WebDAV 保存走 `webdav_sync_save_settings`，请求中 `passwordTouched: true` 且包含用户刚输入的密码；保存后普通 `settingsState.webdavSync.password` 被置空，模拟后端 redaction；点击高级页底部 `common.save` 后，普通 `save_settings` 原始 payload 不包含 `webdavSync`，不会用普通设置保存覆盖 WebDAV 独立配置。
- 测试夹具：MSW 状态新增 `lastSettingsSaveRequest`、`lastWebdavSaveRequest`、WebDAV test / upload / download 记录和远端快照响应。
- 红绿记录：首次运行因缺少 `getLastSettingsSaveRequest` 失败，补齐 MSW 观测点后重跑通过。
- 验证命令：`pnpm vitest run tests/integration/SettingsPage.real-webdav.test.tsx`
- 当前结果：`2 passed, 0 failed`

### SettingsPage + ImportExport 真实页面验收

- 新增验收文件：`tests/integration/SettingsPage.real-import-export.test.tsx`
- 覆盖范围：真实 `SettingsPage`、真实 `Tabs`、真实 `Accordion`、真实 `ImportExportSection`、真实 `useImportExport`；只 mock 与导入导出无关的重型设置区块。
- 覆盖交互：默认打开高级页签，展开数据管理 accordion，从真实按钮选择导入文件，确认文件名显示，执行导入，展示成功消息和 backup id，清空已选文件和成功状态，再通过真实导出按钮选择保存路径并导出。
- 错误恢复：模拟导入命令返回失败，验证页面展示后端错误消息，toast 收到同一错误，点击清空后错误消息和文件名都消失，选择文件按钮恢复可用。
- 配置 / 请求验证：直接观测 `open_file_dialog`、`import_config_from_file`、`save_file_dialog`、`export_config_to_file`、`sync_current_providers_live` 的请求参数；确认导入成功后触发 `onImportSuccess`，并且导出默认文件名符合 `cc-switch-export-YYYYMMDD_HHMMSS.sql`。
- 红绿记录：本批次没有改生产代码，新增真实页面验收首次运行即通过，说明当前实现已满足这条真实入口链路；该项原缺口是覆盖层级不足，而非已知生产缺陷。
- 验证命令：`pnpm vitest run tests/integration/SettingsPage.real-import-export.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`1 file passed, 2 tests passed, 0 failed`

### SettingsPage + Proxy / Failover 真实页面验收

- 新增验收文件：`tests/integration/SettingsPage.real-proxy-failover.test.tsx`
- 覆盖范围：真实 `SettingsPage`、真实 `ProxyTabContent`、真实 `ProxyPanel`、真实 `FailoverQueueManager`、真实 `AutoFailoverConfigPanel`；只 mock 与代理 / 故障转移链路无关的重型设置区块。
- 覆盖交互：默认打开 `proxy` 页签，展开本地代理配置，开启本地代理功能，确认并启动代理服务，接管 Claude，展开故障转移配置，确认总开关，切到 Claude 队列，开启自动故障转移，添加 `Claude Beta` 到队列，再从队列删除 `Claude Beta`。
- 配置验证：接管后立即断言 Claude live settings 保持代理模板；开启故障转移、自动故障转移、添加 / 删除队列供应商后再次断言 `ANTHROPIC_BASE_URL` 仍为 `http://127.0.0.1:15721`，`ANTHROPIC_AUTH_TOKEN` 仍为 `PROXY_MANAGED`，不会漂移成任一供应商 base URL。
- 测试夹具：MSW 补齐 `get_global_proxy_config` / `update_global_proxy_config`，新增全局代理配置状态；测试环境补齐 `scrollTo`、Pointer Capture、`scrollIntoView` 等 jsdom 缺失的浏览器 API，保证 Radix Select 真实下拉交互可执行。
- 产品修复：`FailoverQueueManager` 为自动故障转移开关、供应商下拉框、添加队列按钮补充明确可访问名称，真实用户操作和页面级验收都能稳定定位这些控件。
- 红绿记录：首次运行暴露 `get_global_proxy_config` 未模拟、内部 `tablist` 查询歧义、自动故障转移开关无可访问名称、Radix Select 在 jsdom 下缺少浏览器 API、队列删除按钮定位歧义；逐项补齐后同一真实页面用例通过。
- 最小验证命令：`pnpm vitest run tests/integration/SettingsPage.real-proxy-failover.test.tsx --fileParallelism=false --reporter=verbose`
- 最小验证结果：`1 file passed, 1 test passed, 0 failed`
- 组合验证命令：`pnpm vitest run tests/integration/SettingsPage.real-proxy-failover.test.tsx tests/integration/App.real-providers.test.tsx tests/components/GlobalProxySettings.test.tsx tests/hooks/useFailoverQueue.test.tsx tests/hooks/useProxyStatus.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`5 files passed, 16 tests passed, 0 failed`

### App + PromptPanel 真实页面验收

- 新增验收文件：`tests/integration/App.real-prompts.test.tsx`
- 覆盖范围：真实 `App`、真实顶栏 Prompts 入口、真实 `PromptPanel`、真实 `PromptListItem`、真实 `PromptFormPanel`、真实 `usePromptActions`；只 mock 与 Prompts 链路无关的重型页面和 CodeMirror 编辑器。
- 覆盖交互：从真实工具栏进入 Prompts 面板；启用 `Claude Beta Prompt` 并验证同 app 内互斥启用；编辑 `Claude Alpha Prompt`；从顶栏新增提示词；删除新增提示词时验证取消不删除、确认后删除。
- 隔离验证：从 Claude 返回供应商页后切换到 Codex，再进入 Prompts；验证 Codex 只展示 Codex 提示词，不展示 Claude 提示词；`prompt-imported` 事件只有 `detail.app` 匹配当前 app 时才触发刷新。
- 配置 / 请求验证：MSW 新增 `get_prompts`、`get_current_prompt_file_content`、`upsert_prompt`、`enable_prompt`、`delete_prompt`、`import_prompt_from_file` 命令模拟；直接观测 `app`、`id`、`prompt` 请求参数，验证保存、启用、删除都落在当前 app，不会串写其它 app。
- 红绿记录：首次运行真实页面用例时，因缺少 `get_prompts` handler 卡在 loading 并失败；补齐 Prompts MSW 状态和 Tauri command handler 后，同一真实页面链路通过。手动派发 `prompt-imported` 事件引发的 React `act(...)` 警告已用 `act` 包裹消除。
- 验证命令：`pnpm vitest run tests/integration/App.real-prompts.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`1 file passed, 2 tests passed, 0 failed`
- 组合验证命令：`pnpm vitest run tests/integration/App.real-prompts.test.tsx tests/integration/App.real-navigation.test.tsx tests/integration/App.real-skills-mcp.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`3 files passed, 12 tests passed, 0 failed`

### App + HermesMemoryPanel 真实页面验收

- 新增验收文件：`tests/integration/App.real-hermes-memory.test.tsx`
- 覆盖范围：真实 `App`、真实 Hermes 顶栏 Memory 入口、真实 `HermesMemoryPanel`、真实 `useHermesMemory` / `useHermesMemoryLimits` / `useSaveHermesMemory` / `useToggleHermesMemoryEnabled` / `useOpenHermesWebUI`；只 mock 与 Hermes Memory 链路无关的重型页面和 Markdown 编辑器外壳。
- 覆盖交互：从真实 Hermes 工具栏进入 Memory 页面；默认 `memory` 页签加载内容；关闭 memory 开关并显示禁用提示；编辑并保存 `MEMORY.md`；点击“在 Hermes Web UI 调整上限”；切到 `user` 页签后开启 user memory、编辑并保存 `USER.md`。
- 隔离验证：保存 `USER.md` 后切回 `memory` 页签，确认仍显示 `MEMORY.md` 内容；再次切回 `user` 页签，确认保持刚保存的 `USER.md` 内容，避免两个 memory 文件在真实页面下串写或互相覆盖。
- 配置 / 请求验证：MSW / Tauri mock 补齐 `get_hermes_memory`、`set_hermes_memory`、`get_hermes_memory_limits`、`set_hermes_memory_enabled`、`open_hermes_web_ui`；直接观测 `kind`、`content`、`path` 请求参数，验证 memory / user 写入目标准确，且保存后会重新请求对应 memory，不会把编辑器 UI 回滚到旧状态。
- 红绿记录：首次运行真实页面用例时，因缺少 `get_hermes_memory` 等 Hermes command handler 卡在 loading 并失败；补齐 Hermes MSW 状态和 handler 后转绿。随后又暴露出 Framer Motion 视图切换下“标题已出现但页签未挂载完成”的时序问题，验收入口等待条件已收紧为 `memory` tab 真正可访问后再继续操作，避免假失败。
- 验证命令：`pnpm vitest run tests/integration/App.real-hermes-memory.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`1 file passed, 2 tests passed, 0 failed`
- 组合验证命令：`pnpm vitest run tests/integration/App.real-hermes-memory.test.tsx tests/integration/App.real-navigation.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`2 files passed, 9 tests passed, 0 failed`

### App + WorkspaceFilesPanel 真实页面验收

- 新增验收文件：`tests/integration/App.real-openclaw-workspace.test.tsx`
- 覆盖范围：真实 `App`、真实 OpenClaw 顶栏 Workspace 入口、真实 `WorkspaceFilesPanel`、真实 `WorkspaceFileEditor`；只 mock 与 Workspace 链路无关的重型页面和 Markdown 编辑器外壳。
- 覆盖交互：从真实 OpenClaw 工具栏进入 Workspace；初始加载时逐个探测 workspace 文件存在状态；点击路径标题打开 `~/.openclaw/workspace/`；打开 `AGENTS.md` 进入编辑器并保存；关闭后重新打开同文件确认内容持久化；再打开原本不存在的 `SOUL.md`，写入内容并保存，验证缺失文件可由真实页面链路创建。
- 配置 / 请求验证：MSW / Tauri mock 补齐 `read_workspace_file`、`write_workspace_file`、`open_workspace_directory`；直接观测 `filename`、`content`、`subdir` 请求参数，确认文件存在探测覆盖全部 9 个 workspace 文件，保存请求准确写入对应目标文件，不会误写到其它 workspace 文件。
- 隔离验证：先修改 `AGENTS.md` 再创建 `SOUL.md`，验证两个文件分别独立持久化；重新打开 `AGENTS.md` 仍是更新后的 agent 指令，不会被新建 `SOUL.md` 覆盖。
- 红绿记录：首次运行真实页面用例时，Workspace 页面可打开，但因缺少 `read_workspace_file` / `write_workspace_file` / `open_workspace_directory` handler，编辑器一直停在 loading 并失败；补齐 Workspace MSW 状态和 handler 后转绿。
- 验证命令：`pnpm vitest run tests/integration/App.real-openclaw-workspace.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`1 file passed, 2 tests passed, 0 failed`
- 组合验证命令：`pnpm vitest run tests/integration/App.real-openclaw-workspace.test.tsx tests/integration/App.real-navigation.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`2 files passed, 9 tests passed, 0 failed`

### App + EnvPanel 真实页面验收

- 新增验收文件：`tests/integration/App.real-openclaw-env.test.tsx`
- 覆盖范围：真实 `App`、真实 OpenClaw 顶栏 Env 入口、真实 `EnvPanel`、真实 `useOpenClawEnv` / `useSaveOpenClawEnv`；只 mock 与 Env 链路无关的重型页面，以及为稳定模拟操作把 `JsonEditor` 外壳替换为 textarea。
- 覆盖交互：从真实 OpenClaw 工具栏进入 Env 页面；加载现有 `env` JSON；编辑 `vars` / `shellEnv` 后点击保存；再输入非法 JSON 对象类型（数组）并尝试保存。
- 配置 / 请求验证：MSW / Tauri mock 补齐 `get_openclaw_env`、`set_openclaw_env`；直接观测 `env` 请求参数，确认保存时 `OPENCLAW_API_KEY`、`FEATURE_FLAG`、`OPENCLAW_BASE_URL` 都准确落到 `env` 节点；保存后再次请求 `get_openclaw_env`，并确认编辑器保持最新保存值，不回滚到旧配置。
- 非法输入验证：当输入 `["not","an","object"]` 时，真实页面点击保存不会发出 `set_openclaw_env` 请求，防止把非法 JSON 误提交进 `openclaw.json`。
- 红绿记录：首次运行真实页面用例时，`EnvPanel` 因缺少 `get_openclaw_env` / `set_openclaw_env` handler 一直停在 loading 并失败；补齐 OpenClaw env MSW 状态和 handler 后转绿。过程中还暴露出 `userEvent.type` 对 `{}` / `"` 的特殊键位解析问题，已改为 `paste` 方式保持真实编辑意图但避免测试工具假失败。
- 验证命令：`pnpm vitest run tests/integration/App.real-openclaw-env.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`1 file passed, 2 tests passed, 0 failed`
- 组合验证命令：`pnpm vitest run tests/integration/App.real-openclaw-env.test.tsx tests/integration/App.real-navigation.test.tsx --fileParallelism=false --reporter=verbose`
- 组合验证结果：`2 files passed, 9 tests passed, 0 failed`

### App + ToolsPanel 真实页面验收

- 验收文件：`tests/integration/App.real-openclaw-tools.test.tsx`
- 覆盖范围：真实 `App`、真实 OpenClaw 顶栏 Tools 入口、真实 `ToolsPanel`、真实 `useOpenClawTools` / `useSaveOpenClawTools`；只 mock 与 Tools 链路无关的重型页面。
- 覆盖交互：从真实顶层 App 切换到 OpenClaw，再点击真实 Tools 入口；加载既有 `profile`、allow list 和 deny list；通过真实 Select 把 profile 从 `minimal` 改为 `full`；新增 allow / deny 项，删除 allow 项，再点击真实保存按钮。
- 配置 / 请求验证：直接观测 `set_openclaw_tools` 请求体，确认保存结果为 `profile: "full"`、`allow: ["Read", "Shell"]`、`deny: ["Delete", "Network"]`，避免 allow / deny 编辑时把旧项、空项或其它配置误写入。
- 兼容性验证：当后端返回不在当前支持列表里的 `profile: "default"` 时，真实页面展示 unsupported profile 警告；直接保存会原样保留 `default`，只有用户明确选择 `Coding` 后才写入 `profile: "coding"`，防止升级后自动覆盖用户已有 OpenClaw 配置。
- 本轮复核验证命令：`pnpm exec vitest run tests/integration/App.real-openclaw-tools.test.tsx tests/integration/App.real-openclaw-agents.test.tsx --fileParallelism=false --reporter=verbose`
- 本轮复核验证结果：`2 files passed, 4 tests passed, 0 failed`

### App + AgentsDefaultsPanel 真实页面验收

- 验收文件：`tests/integration/App.real-openclaw-agents.test.tsx`
- 覆盖范围：真实 `App`、真实 OpenClaw 顶栏 Agents 入口、真实 `AgentsDefaultsPanel`、真实 OpenClaw provider 模型选项、真实 `useOpenClawAgentsDefaults` / `useSaveOpenClawAgentsDefaults`；只 mock 与 Agents 默认配置链路无关的重型页面。
- 覆盖交互：从真实顶层 App 切换到 OpenClaw，再点击真实 Agents 入口；加载 primary model、workspace、timeout、contextTokens、maxConcurrent；通过真实 Select 把 primary model 从 `Provider A / Model Alpha` 改到 `Provider B / Model Beta`，新增 fallback 并选择 `Provider C / Model Gamma`，编辑运行参数后保存。
- 配置 / 请求验证：直接观测 `set_openclaw_agents_defaults` 请求体，确认保存后的 `model.primary`、`model.fallbacks`、`workspace`、`timeoutSeconds`、`contextTokens`、`maxConcurrent` 均准确写入，同时保留未知字段 `customFlag`，避免页面保存把用户手工配置丢掉。
- 兼容性验证：当既有默认模型为 `legacy/missing-model` 且后端仍使用旧字段 `timeout` 时，真实页面展示 legacy timeout 警告；保存后保留 unsupported model value 和 fallback，并把 `timeout` 迁移为 `timeoutSeconds`，同时清理旧字段，防止迁移时覆盖用户模型配置。
- 本轮复核验证命令：`pnpm exec vitest run tests/integration/App.real-openclaw-tools.test.tsx tests/integration/App.real-openclaw-agents.test.tsx --fileParallelism=false --reporter=verbose`
- 本轮复核验证结果：`2 files passed, 4 tests passed, 0 failed`

### App + ProviderList 熔断事件真实页面验收

- 新增验收用例：`tests/integration/App.real-providers.test.tsx` 中 `shows all circuit-open failover providers after provider events without drifting Claude live config`
- 覆盖范围：真实 `App`、真实 `ProviderList`、真实行内供应商启用开关、真实 Tauri 事件监听刷新链路；MSW 只负责模拟后端 provider health 和 circuit breaker stats 状态。
- 覆盖交互：预置 3 个 Claude 供应商，开启本地代理、Claude 接管和自动故障转移；通过真实供应商行内开关把 `Claude Beta`、`Claude Gamma` 加入故障转移队列，使队列包含 `Claude Alpha`、`Claude Beta`、`Claude Gamma`。
- 熔断事件验证：通过 `setProviderHealthState` / `setCircuitBreakerStatsState` 把 3 个供应商全部置为不健康且 circuit breaker `open`，再派发真实 `provider-switched` 事件触发页面刷新；断言 3 个供应商行均展示「熔断」状态。
- 配置漂移验证：熔断事件后直接读取 Claude live settings，断言 `ANTHROPIC_BASE_URL` 仍为 `http://127.0.0.1:15721`，`ANTHROPIC_AUTH_TOKEN` 仍为 `PROXY_MANAGED`，并且 `ANTHROPIC_BASE_URL` 不等于任一供应商 direct base URL。
- 测试夹具：MSW 状态新增 provider health / circuit breaker stats 可控状态，`get_provider_health` 和 `get_circuit_breaker_stats` handler 改为按 `appType + providerId` 返回真实测试状态，避免所有供应商共享一个固定 mock 响应。
- 红绿记录：临时破坏 `get_circuit_breaker_stats` handler 让其返回 `null` 后，同一用例按预期失败并找不到「熔断」文本；恢复 handler 后同一用例通过，证明该验收确实覆盖页面熔断状态刷新，而不是弱断言。
- 验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx -t "shows all circuit-open failover providers" --reporter=verbose`
- 当前结果：`1 test passed, 11 tests skipped, 0 failed`
- 全文件验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx --reporter=verbose`
- 全文件验证结果：`1 file passed, 12 tests passed, 0 failed`
- 代理 / 故障转移组合验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx tests/integration/SettingsPage.real-proxy-failover.test.tsx tests/integration/App.real-header-proxy-failover.test.tsx --fileParallelism=false --reporter=verbose`
- 代理 / 故障转移组合验证结果：`3 files passed, 15 tests passed, 0 failed`

### App + ProviderList 代理活动事件真实页面验收

- 新增验收用例：`tests/integration/App.real-providers.test.tsx` 中 `shows live request activity only for the active app provider from proxy events`
- 覆盖范围：真实 `App`、真实 `useProxyActivityBridge()`、真实 React Query `proxyStatus` 缓存、真实 `AppSwitcher`、真实 `ProviderList` 行状态和 tooltip / title 文案；MSW / Tauri mock 只负责派发 `proxy-activity-updated` 事件。
- 覆盖交互：先在 Claude 页派发 `Claude Alpha` 活动请求事件，断言只有 `Claude Alpha` 行显示「请求中」，`Claude Beta` 不显示；切到 Codex 后断言 Claude 活动不会出现在 Codex provider 行；再派发 `Codex Beta` 双请求事件，断言只有 `Codex Beta` 行显示「请求中 2」。
- 模型展示验证：Claude 和 Codex 两次事件都同时携带 `request_model` 与 `upstream_model`，验收直接读取状态 `title`，确认展示「实际上游模型：...」和「请求模型：...」，避免活动请求只显示数量但丢失模型上下文。
- 跨 app 隔离验证：切回 Claude 后，等待真实 ProviderList 行刷新到 Claude provider，确认 `Codex Beta` 行不存在，且 `Claude Alpha` 的「请求中」状态仍来自 Claude 活动目标，不会被 Codex 活动覆盖。
- 红绿记录：临时把 Codex 活动目标 `provider_id` 改为不存在的 `codex-missing` 后，同一用例按预期失败，在 `Codex Beta` 行找不到「请求中 2」；恢复 `provider_id: "codex-beta"` 后同一用例通过，证明该验收能捕获 provider 映射错误。
- 单用例验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx -t "shows live request activity only" --reporter=verbose`
- 单用例验证结果：红灯 `1 failed`；恢复后 `1 passed, 12 skipped, 0 failed`
- 全文件验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx --reporter=verbose`
- 全文件验证结果：`1 file passed, 13 tests passed, 0 failed`
- 代理活动组合验证命令：`pnpm exec vitest run tests/integration/App.real-providers.test.tsx tests/integration/SettingsPage.real-usage.test.tsx tests/integration/App.real-request-detail-panel.test.tsx tests/hooks/useProxyActivityBridge.test.tsx --fileParallelism=false --reporter=verbose`
- 代理活动组合验证结果：`4 files passed, 20 tests passed, 0 failed`

### App 顶栏代理活动条真实页面验收

- 新增验收用例：`tests/integration/App.real-header-proxy-failover.test.tsx` 中 `renders the real live activity strip from proxy activity events and hides it after clear`
- 覆盖范围：真实 `App` 顶栏、真实 `useProxyActivityBridge()`、真实 React Query `proxyStatus` 缓存和真实顶栏活动条渲染；MSW / Tauri mock 只负责派发 `proxy-activity-updated` 事件。
- 活动计数验证：事件中故意传入 `active_request_count: 99`，同时传入 Claude `inflight_requests: 1` 和 Codex `inflight_requests: 2`，页面必须显示 `3 个请求处理中`，并且不能显示 `99 个请求处理中`，防止顶栏盲信后端汇总计数。
- 展示内容验证：同一活动条必须同时展示 Claude / Codex 两个 app target、对应 provider、display model 和 `x1` / `x2` 数量；`title` 必须包含 `claude / Claude Alpha / claude-opus-upstream (req: claude-sonnet-request)` 和 `codex / Codex Beta / gpt-5.4`。
- 清理事件验证：派发 `event: "cleared"` 且 `active_request_targets: []` 后，顶栏活动条必须隐藏，`Claude Alpha` / `Codex Beta` 活动项从页面移除。
- 测试夹具：`tests/msw/tauriMocks.ts` 新增 `getTauriEventListenerCount()`，真实页面测试在派发事件前等待 `proxy-activity-updated` listener 注册完成，避免把异步监听注册时序误判成产品缺陷。
- 红绿记录：临时把断言改为期待 `99 个请求处理中` 后，同一用例按预期失败；恢复为 `3 个请求处理中` 后通过，证明该验收能捕获活动条计数错误。
- 单用例验证命令：`pnpm exec vitest run tests/integration/App.real-header-proxy-failover.test.tsx -t "renders the real live activity strip" --reporter=verbose`
- 单用例验证结果：红灯 `1 failed`；恢复后 `1 passed, 1 skipped, 0 failed`
- 全文件验证命令：`pnpm exec vitest run tests/integration/App.real-header-proxy-failover.test.tsx --reporter=verbose`
- 全文件验证结果：`1 file passed, 2 tests passed, 0 failed`
- 代理活动组合验证命令：`pnpm exec vitest run tests/integration/App.real-header-proxy-failover.test.tsx tests/integration/App.real-providers.test.tsx tests/hooks/useProxyActivityBridge.test.tsx tests/lib/proxyActivity.test.ts --fileParallelism=false --reporter=verbose`
- 代理活动组合验证结果：`4 files passed, 22 tests passed, 0 failed`

### 组合回归

- 验证命令：`pnpm vitest run tests/integration/App.real-provider-forms.test.tsx tests/integration/App.real-skills-mcp.test.tsx tests/integration/App.real-sessions.test.tsx tests/integration/App.real-providers.test.tsx tests/integration/App.real-navigation.test.tsx tests/integration/SettingsPage.real-tabs.test.tsx tests/integration/SettingsPage.real-webdav.test.tsx tests/components/ApiHubPanel.test.tsx tests/components/ProviderList.test.tsx tests/components/SessionManagerPage.test.tsx tests/components/SettingsDialog.test.tsx tests/integration/SettingsDialog.test.tsx tests/integration/App.test.tsx`
- 当前结果：`13 files passed, 83 tests passed, 0 failed`
- 已知测试噪音：`baseline-browser-mapping` 数据过旧提示、Node `punycode` deprecation、CodeMirror 在 jsdom 下输出 `textRange(...).getClientRects is not a function`，以及 `App.test.tsx` 中故意模拟 live provider ids 加载失败时输出的错误日志。

### 测试隔离与完整前端串行回归

- 发现问题：`ApiHubPanel.test.tsx` 会 mock `HTMLInputElement.prototype.click`，但全局清理只执行 `vi.clearAllMocks()`，不会恢复 prototype；Tauri event mock 也没有跨测试清理 listener。结果是单文件测试通过，但 `ApiHubPanel.test.tsx` 与 `App.real-providers.test.tsx` 组合运行时，真实供应商页面搜索 / 切换用例可能超时，削弱模拟操作验收可信度。
- 修复内容：`ApiHubPanel.test.tsx` 增加 `afterEach(() => vi.restoreAllMocks())`；`tests/msw/tauriMocks.ts` 增加 `resetTauriEventListeners()`；`tests/setupTests.ts` 每个测试后清理 Tauri listeners；Api-Hub 进度事件模拟用 `act(...)` 包裹，消除对应 React warning。
- 本批次补充：`App.real-providers.test.tsx` 中 OpenCode / OpenClaw / Hermes additive live 配置隔离用例在完整串行回归中超过默认 5 秒阈值，补充显式 `15_000` 超时，与同文件其它真实页面长链路用例保持一致，避免验收套件因默认阈值产生假失败。
- 最小复现验证：`pnpm vitest run tests/components/ApiHubPanel.test.tsx tests/integration/App.real-providers.test.tsx --fileParallelism=false --reporter=verbose`
- 当前结果：`2 files passed, 20 tests passed, 0 failed`
- 完整前端串行验证：`pnpm vitest run --fileParallelism=false --reporter=json --outputFile=.tmp-vitest-prompts-full.json --silent`
- 当前结果：`136 files passed, 353 tests passed, 0 failed`
- 当前剩余测试噪音：`baseline-browser-mapping` 数据过旧提示、Node `punycode` deprecation、CodeMirror 在 jsdom 下输出 `textRange(...).getClientRects is not a function`，以及 `App.test.tsx` 中故意模拟 live provider ids 加载失败时输出的错误日志。

### 后端 provider_service 回归

- 验证命令：`cargo test --test provider_service`
- 当前结果：`17 passed, 0 failed`
- 已知编译噪音：Rust 编译输出包含多处 `dead_code` / `unused` warning，当前未导致测试失败。
