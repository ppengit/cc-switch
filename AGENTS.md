# 仓库协作指南

## 1. 文档目的
本文件用于统一人类开发者与 AI Agent 在 cc-switch 仓库中的协作方式，保证改动可维护、可测试、可回滚。

适用范围
- 前端 React 和 TypeScript
- 后端 Tauri 和 Rust
- 数据层 SQLite 和迁移
- 配置同步与代理链路

## 2. 项目结构
- src: 前端代码，包含 components、hooks、i18n、config、utils
- src-tauri/src: 后端核心，包含 commands、services、database、proxy、session_manager
- tests: 前端测试
- src-tauri/tests: Rust 集成测试
- docs: 用户文档与发布说明
- assets: 静态资源
- scripts: 版本和构建辅助脚本

建议优先阅读
- src/App.tsx
- src/lib/api
- src/lib/query
- src-tauri/src/lib.rs
- src-tauri/src/services/provider/mod.rs
- src-tauri/src/services/provider/live.rs
- src-tauri/src/database/mod.rs
- src-tauri/src/database/schema.rs

## 3. 常用命令
前端和整应用
- pnpm install
- pnpm dev
- pnpm dev:renderer
- pnpm typecheck
- pnpm format
- pnpm format:check
- pnpm test:unit
- pnpm test:unit:watch
- pnpm build

后端
- cd src-tauri
- cargo fmt
- cargo clippy
- cargo test
- cargo test --features test-hooks

## 4. 架构关键约束
### 4.1 单一事实源
- 核心数据持久化以 SQLite 为主
- 设备级偏好使用本地 settings.json

### 4.2 Provider 切换模式
- Claude、Codex、Gemini 为切换模式，有当前 provider 概念
- OpenCode、OpenClaw 为累加模式，多个 provider 共存
- OMO 与 OMO Slim 在 OpenCode 走独立排它路径

### 4.3 Live 配置写入
- provider 变更通常会写入 live 配置
- 代理接管开启时，部分流程只更新备份，不直接覆盖 live 文件
- 禁止绕过 ProviderService 直接写配置

### 4.4 回填与恢复
- 非接管场景切换 provider 时，尝试把当前 live 配置回填到旧 provider
- 启动和退出包含接管恢复流程，避免 CLI 配置残留接管状态

### 4.5 MCP、Skills、Prompt 同步
- 数据库存储后需要按应用同步到 live 文件
- 不要在 UI 层直接拼落盘逻辑，统一走 command 和 service

## 5. 编码规范
### 5.1 前端
- 使用路径别名 @ 指向 src
- 保持既有风格，2 空格缩进，分号，双引号
- 组件文件使用 PascalCase
- Hook 使用 useXxx 命名
- 业务逻辑放 hooks 或服务封装，不放进纯 UI 组件

### 5.2 后端
- command 层负责参数解析和错误转换
- 核心业务放 services
- 数据访问走 database/dao
- 避免 unwrap 和 expect 导致崩溃

### 5.3 i18n
- 用户可见文案优先走 i18n 词条
- 新增提示信息同时考虑中英文可读性

## 6. 测试与验收
提交前至少执行
- pnpm typecheck
- pnpm format:check
- pnpm test:unit

下列改动必须补测试
- provider 增删改查和切换
- proxy 接管、停止、故障转移
- MCP 同步开关和导入
- skills 导入安装和同步
- 配置导入导出、深链导入
- 数据库 schema 和 migration 变更

后端逻辑改动建议补充
- src-tauri/tests 集成测试
- 必要的 DAO 或服务层测试

## 7. 数据库与迁移规范
- 修改表结构时必须维护 schema 迁移逻辑和版本号
- 迁移需满足可升级、可回滚、不破坏历史数据
- 涉及迁移风险时优先先备份再迁移

## 8. 提交与 PR 规范
- 提交信息建议使用 Conventional Commits
- 一次提交只做一类改动，避免功能和大重构混杂
- PR 需要包含
  - 变更摘要
  - 设计动机
  - 影响范围
  - 测试结果
  - 涉及 UI 时附截图或动图
  - 涉及数据库或配置时附迁移与回滚说明

## 9. 安全与配置要求
- 严禁提交密钥、Token、用户本地配置数据
- 不要提交用户目录中的真实配置样本
- 非发布目标场景下，避免把 dist 和 target 作为功能改动审阅重点

## 10. AI Agent 协作规则
- 修改前先阅读相关模块，不凭猜测改代码
- 优先做最小必要改动，避免无关重构
- 涉及跨层链路时，确认 UI 到 command 到 service 到 DAO 全链路一致
- 不要静默改变配置格式、字段语义或默认值
- 高风险改动要写明验证步骤

## 11. 快速排查建议
- 启动失败优先查看日志和 crash 文件
- provider 切换异常优先检查
  - 当前 provider 记录
  - live 配置是否被接管
  - proxy 是否仍在运行
- 数据异常优先检查 schema 版本、迁移日志、备份可用性
