# 上游 `main`（2026-05-18）全面合并评估记录

## 1. 合并范围

- 工作树：`D:\Solution\cc-switch\.worktrees\merge-upstream-main-20260518`
- 当前分支：`merge/upstream-main-20260518`
- 本地合并前基线：`dbe157bde75d18bdb4b3b7b1533654895d2643e6`
- 分叉基线：`21e2d68d76e08bee1b626cd1fd4d7419fbeb73e6`
- 第一段上游目标：`c9efec294b59e8980f5ed3326f9c3498431d5bb1`
- `git fetch upstream` 后最新目标：`76b4c8b50946a34ac6700a9596a65da78e124478`
- 第一段合并检查点提交：`1e6142e9`

本次合并目标是吸收上游 `main` 到 2026-05-18 的最新变更，同时保留当前分支基于 3.14.0 之后形成的本地定制：供应商列表优化、供应商搜索与批量交互、provider / live 配置处理、Api-Hub 全流程、会话管理、usage 统计口径、proxy / failover 行为。

## 2. 上游新增与变更点

- `Claude Desktop` provider：新增 provider 类型、preset、表单、从 Claude 配置导入、路由开关和用户手册。
- Provider preset：补充 BytePlus、ClaudeAPI、ClaudeCN、RunAPI、火山、MiMo Token Plan 等供应商与图标资源；最新提交移除 LionCC 赞助与 preset。
- Proxy / failover：合入 `max_retries`、成功响应预读、HTTP method 透传、SSE usage 过滤、连接 guard、failover 成功路径修复。
- Usage / session：合入 `UsageHero`、fresh input 统计口径、subagent token 统计修复、session 日志补强、pricing backfill 修复。
- Terminal / skills：补充 macOS `warp`、Ghostty 新窗口修复、skill sync fallback 修复、skills 安装搜索结果修复。
- 文档：补齐 v3.15.0 release notes 与中英日用户手册。

## 3. 合并原则

1. 供应商、配置、日志和会话数据优先保证不被污染。
2. 本地定制与上游能力互补时同时保留。
3. 上游明确删除的赞助或 preset 不保留，除非它是本地独立业务必需项。
4. 冲突区域按用户工作流完整性优先，而不是按代码量多少选择。
5. 所有关键裁决必须留下验证入口，避免后续升级重复踩坑。

## 4. 关键裁决

| 模块 | 文件 | 裁决 | 原因 | 验证入口 |
| --- | --- | --- | --- | --- |
| 供应商列表 | `src/components/providers/ProviderList.tsx` | 保留本地增强列表、搜索定位、批量操作、会话恢复与滚动控制，合入上游 Claude Desktop 状态告警 | 本地交互覆盖用户高频工作流，上游告警是互补能力 | ProviderList 相关测试与手动搜索/批量操作 |
| Provider 表单 | `src/components/providers/forms/ProviderForm.tsx` | 保留本地 Codex/Gemini seeded template 与 URL helper，合入 Claude Desktop 专用表单分流 | 本地模板决定配置可用性，上游新增 provider 类型需要接入 | ProviderForm / ClaudeDesktopProviderForm 测试 |
| Provider preset | `src/config/*ProviderPresets.ts` | CrazyRouter / Micu 使用上游正式端点，默认模型保留本地较新模型；DDSHub 保留；LionCC 按上游最新提交删除 | 端点以正式域名为准，模型保持本地用户预期；LionCC 是上游明确清理项 | providerPresetOrder、各 preset 测试 |
| Live 配置 | `src-tauri/src/services/provider/live.rs`、provider DAO | 保留本地 current/live 配置同步和 provider 生命周期处理，吸收上游 Claude Desktop 与配置字段扩展 | 本地逻辑关系到实际切换可用性，上游扩展不冲突 | provider_commands、provider service 测试 |
| Api-Hub | `src/components/settings/SettingsPage.tsx`、Api-Hub 相关前后端 | 保留 Api-Hub `forceMount` 以维持面板状态；修复 tab content 顺序为 `usage -> apiHub -> about` | 用户反馈 Api-Hub 与其它设置选项卡错乱，根因是 Trigger 与 Content 顺序不一致 | `SettingsDialog.test.tsx` 新增回归测试 |
| Proxy / failover | `src-tauri/src/proxy/*`、`FailoverToggle.tsx` | 保留 `switch_epoch` 防倒退和本地 failover current 语义，合入上游 `max_retries`、成功响应预读、连接 guard、usage filter | 本地语义保护当前供应商状态，上游修复提高 failover 成功率和日志准确性 | `cargo check`、failover / proxy 测试 |
| Usage 统计 | `src-tauri/src/services/usage_stats.rs`、usage 前端 | 保留本地 session context、26 列日志详情与 `hermes_session` 过滤；合入 fresh input 统计和新 pricing backfill 签名 | 本地会话上下文是定制能力，上游 fresh input 避免 cache-inclusive input 重复计算 | usage tests、RequestLog/RequestDetail 测试 |
| Session 管理 | `src-tauri/src/session_manager/*` | 保留本地标题候选清洗与会话优化，合入上游 pricing 查找、metadata mtime、subagent 统计、macOS `warp` | 两侧能力互补 | session / terminal 相关测试 |
| 文档与资源 | README、release notes、用户手册、partner logos | 保留上游 v3.15.0 文档更新；pateway logo 保留本地小图；LionCC 文档与 sponsor 按上游删除 | 小图更适合当前 README 表格；LionCC 是最新上游清理项 | 文档检查与 preset 搜索 |

## 5. Api-Hub 错乱修复记录

- 症状：设置页中 `Api-Hub` 会和其它选项卡内容错乱显示。
- 根因：`TabsTrigger` 顺序为 `general -> proxy -> auth -> advanced -> usage -> apiHub -> about`，但 `TabsContent` 顺序是 `general -> proxy -> auth -> advanced -> about -> usage -> apiHub`。`apiHub` 又使用 `forceMount`， inactive 状态只依赖 `data-[state=inactive]:hidden`，顺序错位会放大布局和挂载状态问题。
- 修复：将 `about` 的 `TabsContent` 移到 `apiHub` 之后，使 Trigger 与 Content 顺序一致。
- 回归测试：新增 `keeps settings tab content order aligned with tab triggers`，先验证红灯，再修复并验证绿灯。

## 6. 风险与后续验证

- TypeScript 风险：Provider preset、Claude Desktop provider、SettingsPage、UsageDashboard 均有跨模块类型影响，需要运行 `pnpm run typecheck`。
- Rust 风险：proxy / failover / usage_stats / session_manager 合并面较大，需要运行 `cargo check --manifest-path src-tauri/Cargo.toml`。
- 统计口径风险：fresh input 会改变历史测试期望，验证时以「避免缓存输入重复计入」为准。
- 格式化风险：本机 Rust `1.95-x86_64-pc-windows-msvc` 的 `rustfmt` 组件此前不可用，`cargo fmt --check` 若仍失败，应按环境阻塞记录。
- 打包风险：最终必须运行 `pnpm run build:local:nsis` 并确认 `src-tauri/target/release/bundle/nsis/` 下的新安装包。

## 7. 验证清单

- 冲突检查：`rg -n "^(<<<<<<<|=======|>>>>>>>)" -S`、`git diff --name-only --diff-filter=U`
- 前端类型：`pnpm run typecheck`
- 前端重点测试：`pnpm exec vitest run tests/components/SettingsDialog.test.tsx tests/components/ClaudeDesktopProviderForm.test.tsx tests/components/ProviderPresetSelector.test.tsx tests/components/ClaudeFormFields.test.tsx tests/config/providerPresetOrder.test.ts`
- Rust 编译：`cargo check --manifest-path src-tauri/Cargo.toml`
- 打包：`pnpm run build:local:nsis`

## 8. 当前结论

本次合并采用「保留本地业务工作流 + 吸收上游稳定修复 + 尊重上游最新清理项」的策略。供应商列表、provider/live、Api-Hub、会话管理和 usage 统计的本地定制均有明确保留点；上游 v3.15.0 与最新 `76b4c8b5` 的新增能力已纳入后续验证范围。
