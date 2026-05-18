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
| Api-Hub | `SettingsPage` -> `ApiHubPanel` | 页签切换后状态保持、列表筛选、批量操作、导入弹窗 | 会话态污染、请求参数错误、状态错位 | 组件测试已覆盖业务交互，真实页签验收已覆盖挂载 / 隐藏 / 状态保持 |
| 供应商管理 | `ProviderList` / `AddProviderDialog` / `EditProviderDialog` | 增删改查、搜索、排序、批量启用、模板应用、故障转移入口 | 配置覆盖、排序错乱、模板误写入 | 已补真实 App + ProviderList 以及 Add / Edit ProviderForm 页面级验收，仍需继续扩展模板 / 批量写入 / 删除确认 / 更多 app 类型真实表单链路 |
| 会话管理 | `SessionManagerPage` | 搜索、项目分组、删除、批量删除、过滤 | 选择态和搜索态错乱、删除后 UI 不一致 | 已补真实 App + SessionManagerPage 页面级验收，仍需继续扩展批量删除 / 重命名 / 导出 / 恢复终端 |
| Prompts | `PromptPanel` | 打开、返回、新建入口 | 与顶层视图切换耦合 | 顶层入口已验收，面板内部交互待补 |
| Skills | `UnifiedSkillsPanel` / `SkillsPage` | 管理页、发现页切换、导入、安装 ZIP、恢复备份、应用开关 | 面板状态丢失、入口错乱、安装来源错写、应用归属串页 | 已补真实 App + Skills 页面级验收 |
| MCP | `UnifiedMcpPanel` | 打开、导入现有、添加、应用开关、删除 | 配置写入和入口错乱 | 已补真实 App + MCP 页面级验收 |
| Workspace / OpenClaw | `WorkspaceFilesPanel` / `EnvPanel` / `ToolsPanel` / `AgentsDefaultsPanel` | OpenClaw 专属入口切换和按钮隔离 | app 切换后工具栏按钮错位 | OpenClaw 专属入口已验收，内部配置写入待补 |
| Hermes | `HermesMemoryPanel` | Hermes 专属入口切换 | app 切换后入口错乱 | Hermes 专属入口已验收，Memory 内部保存待补 |
| WebDAV | `WebdavSyncSection` | 保存、测试连接、上传、下载、确认弹窗、普通设置保存隔离 | 密码字段保留和误提交、`webdavSync` 被普通 `save_settings` 误覆盖 | 已补真实 SettingsPage + WebDAV 页面级验收 |
| 导入导出 | `ImportExportSection` | 选择文件、导入、导出、清空状态 | 导入成功回调、错误态恢复 | 已有 hook/组件/设置页测试，待补真实页签验收 |
| 代理状态 | 顶栏活动条 / `UsageDashboard` / `RawProxyLogPanel` | 活动条显示、请求模型和上游模型显示、详情跳转 | 活动计数错乱、模型展示错配 | 已有部分测试，待继续扩展 |

## 已识别的测试失真来源

以下模式会导致“测试通过但真实 UI 有问题”：

1. 把 `Tabs` 完整 mock 掉，导致真实页签的挂载、隐藏和 `data-state` 行为无法验证。
2. 把 `ApiHubPanel` 等问题组件本体 mock 掉，导致串页、错位、状态保持类问题无法暴露。
3. 只测单个组件，不测顶层入口切换，导致页面组合后的真实结构问题漏检。
4. 只验证请求调用成功，不验证返回后页面状态是否保持一致。

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
- 覆盖交互：Claude / Codex 跨应用切换后供应商列表不串页；当前供应商状态按 app 隔离；搜索只定位不过滤且切换 app 后重置；切换当前供应商只影响当前 app；编辑 / 用量配置弹窗收到当前 app 的 provider；复制供应商只新增到当前 app。
- 覆盖 live 配置：OpenCode / OpenClaw / Hermes 三类 additive 应用分别使用不同 live provider ids，真实切换页面后验证“使用中 / 禁用”状态只来自当前 app 的 live 配置，不会把其它 app 的 live 状态带入当前页。
- 测试夹具：补齐 `list_recent_sessions`、OMO 当前供应商、Claude Desktop 状态、OpenClaw model catalog / default model、Hermes model config、当前配置文件读写、流式检查、`remove_provider_from_live_config`、`open_provider_terminal` 等 MSW 默认响应，保证真实 `ProviderList` 页面运行时不会被无关未处理请求干扰。
- 验证命令：`pnpm vitest run tests/integration/App.real-providers.test.tsx`
- 当前结果：`4 passed, 0 failed`

### App + Add / Edit ProviderForm 真实页面验收

- 新增验收文件：`tests/integration/App.real-provider-forms.test.tsx`
- 覆盖范围：真实 `App`、真实 `ProviderList`、真实 `AddProviderDialog`、真实 `EditProviderDialog`、真实 `ProviderForm`；只 mock 与供应商表单链路无关的 Skills / MCP / Sessions / OpenClaw / Hermes / Settings 等重型页面。
- 覆盖交互：从真实顶栏新增入口打开 OpenCode 新增供应商弹窗，填写 provider key、display name、base URL、API key 后提交；再从真实列表编辑 DB-only OpenCode provider，将 provider key 改名并提交。
- 配置验证：新增供应商后验证 `providers["opencode-new"]` 存在，`settingsConfig.options.baseURL` / `apiKey` 写入正确，且 additive live ids 包含新增 provider；编辑 provider key 后验证旧 id 删除、新 id 存在，并通过 `originalId` 语义避免残留旧记录。
- 隔离验证：OpenCode 的 additive live ids 只影响 OpenCode，不串到 OpenClaw / Hermes；编辑 DB-only provider 时不改变既有 live provider membership。
- 测试夹具：MSW 新增 additive app 判断、`addProviderToLiveConfig`、`removeProviderFromLiveConfigState`，并让 `add_provider` 支持 `addToLive`、`switch_provider` 更新 additive live ids、`update_provider` 传递 `originalId`。
- 红绿记录：首次运行暴露 `add_provider` 后 live ids 未模拟写入，补齐 MSW 后通过；编辑 live provider key 的用例改为 DB-only provider，因为生产规则会锁定 live config 中的 provider key，避免 orphan live 配置。
- 验证命令：`pnpm vitest run tests/integration/App.real-provider-forms.test.tsx`
- 当前结果：`2 passed, 0 failed`

### App + SessionManagerPage 真实页面验收

- 新增验收文件：`tests/integration/App.real-sessions.test.tsx`
- 覆盖范围：真实 `App`、真实顶栏返回 / 入口、真实 `SessionManagerPage`、真实 sessions hooks；只 mock 与会话链路无关的供应商页和其它重型面板。
- 覆盖交互：从真实工具栏进入会话页；会话页返回供应商页后切换 app，再重新进入会话页；Claude / Codex 会话列表、详情标题和消息按当前 app 隔离；搜索只作用于当前 app；切换 app 后搜索态重置；删除确认只删除当前 app 的目标会话，不影响另一 app 会话。
- 真实结构说明：当前产品在 `sessions` 视图下顶栏不显示 `AppSwitcher`，只能通过返回供应商页后切换应用再进入会话页；验收用例按这个真实可操作路径执行。
- 验证命令：`pnpm vitest run tests/integration/App.real-sessions.test.tsx`
- 当前结果：`3 passed, 0 failed`

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

### 组合回归

- 验证命令：`pnpm vitest run tests/integration/App.real-provider-forms.test.tsx tests/integration/App.real-skills-mcp.test.tsx tests/integration/App.real-sessions.test.tsx tests/integration/App.real-providers.test.tsx tests/integration/App.real-navigation.test.tsx tests/integration/SettingsPage.real-tabs.test.tsx tests/integration/SettingsPage.real-webdav.test.tsx tests/components/ApiHubPanel.test.tsx tests/components/ProviderList.test.tsx tests/components/SessionManagerPage.test.tsx tests/components/SettingsDialog.test.tsx tests/integration/SettingsDialog.test.tsx tests/integration/App.test.tsx`
- 当前结果：`13 files passed, 83 tests passed, 0 failed`
- 已知测试噪音：`baseline-browser-mapping` 数据过旧提示、Node `punycode` deprecation、`ApiHubPanel` 一条进度事件测试的 React `act(...)` warning、CodeMirror 在 jsdom 下输出 `textRange(...).getClientRects is not a function`，以及 `App.test.tsx` 中故意模拟 live provider ids 加载失败时输出的错误日志。

### 后端 provider_service 回归

- 验证命令：`cargo test --test provider_service`
- 当前结果：`17 passed, 0 failed`
- 已知编译噪音：Rust 编译输出包含多处 `dead_code` / `unused` warning，当前未导致测试失败。
