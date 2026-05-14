# Api-Hub 设置选项卡 — 设计文档

> 日期：2026-05-14
> 状态：已批准，进入实现阶段
> 关联工单：用户在 cc-switch 设置面板新增 Api-Hub 选项卡，用于批量管理 api-hub 浏览器扩展导出的多站点 access_token，并将站点下的模型一键导入到各应用的 Provider 配置。

---

## 1. 背景与目标

用户使用 [api-hub](https://github.com/qixing-jk/all-api-hub) 浏览器扩展统一收集多个公益站 / 自部署中转站的账号信息（含 access_token、user_id、汇率等），定期导出为 `accounts-backup-YYYY-MM-DD.json`。

cc-switch 此前只能手动一条条把每个站点的某个模型录入为某个应用的 Provider，重复劳动量大。Api-Hub 选项卡的目标是：

1. **导入**：直接吃 api-hub 导出的 JSON，把站点元信息持久化进 cc-switch 数据库
2. **对齐**：批量为每个分组创建 / 重命名同名 APIKey，便于后续按分组挑模型
3. **导入应用**：把站点的某个模型在某个分组下的 APIKey，按各应用模板写入 providers 表

支持两类站点协议：

- **new-api**（含 Veloera / OneAPI / done-hub / one-hub 等 fork，与变种）
- **Sub2Api**（[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)）
- **未知 site_type**：按 new-api 协议兜底尝试，失败时记录原因

## 2. 功能范围

### 2.1 界面 — 设置 → Api-Hub 选项卡

布局：**搜索栏 + 操作栏 + 分页列表**。tab 位置插在 settings 的 `usage` 与 `about` 之间，将 `grid-cols-6` 升级为 `grid-cols-7`。

#### 搜索栏

- 单输入框，按 `site_name` 与 `site_url` 做不区分大小写的模糊匹配（含子串即可）
- 输入后 250 ms debounce 触发本地过滤

#### 操作栏

| 按钮 | 行为 |
|---|---|
| 导入 | 弹 `ApiHubImportJsonDialog`，选 JSON 文件 → 预览导入数量（含新增 / 覆盖统计）→ 写库 |
| 清空 | 弹确认 dialog → 清空 `api_hub_*` 4 张表；**通过 Api-Hub 导入到 providers 表的供应商不动** |
| 对齐 | 仅当列表有勾选时可用。批量对齐选中站点，进度 dialog 实时展示 |

#### 列表

列：`选择框 / 站点名称（超链接到 site_url）/ 站点类型 badge / 分组数（含模型数）/ APIKey 数 / 操作`

- 分组列以「3 个分组 / 247 个模型」总数形式展示，点击展开 popover，popover 内一行一个分组：`分组名 · 倍率 · 模型数`，可继续展开查看模型名前若干个
- 站点类型 badge：new-api 绿、Sub2Api 紫、未知协议灰 + tooltip 说明"将以 new-api 协议尝试"
- 操作列：⚙ 对齐 / ⤴ 导入应用 / 🔄 同步（单站）
- 分页：每页默认 20，可选 10 / 20 / 50

#### 「导入应用」Dialog

最复杂的交互，结构：

```text
导入到应用 — <site_name>
─────────────────────────────────
目标应用（多选）
  ☐ Claude ☐ Codex ☐ Gemini ☐ OpenCode ☐ OpenClaw ☐ Hermes

可选模型（按分组分组）   🔄 同步     已选 N 个模型
  ▾ <group_name> (<model_count>)
      ☐ 全选
      ☐ <model_name>
      ...

命名预览（共 N 条 = M 模型 × K 应用）
  <site_name> · <group> · <model>   → <app> provider
  ...

⚠ 若有分组缺少同名 APIKey：将在导入前自动对齐：<groups>
[取消] [确认导入]
```

- 模型按分组折叠（collapsible），分组内可"全选"
- 命名预览实时计算
- 缺 APIKey 的分组：dialog 底部黄条提示，确认时先调 `align_partial` 仅补齐缺失分组的 token，再写 providers

### 2.2 持久化数据模型

数据库版本 v11 → v12。`SCHEMA_VERSION = 12`。新建 `migrate_v11_to_v12`，全部走 `CREATE TABLE IF NOT EXISTS` + `add_column_if_missing`，幂等。

```sql
CREATE TABLE IF NOT EXISTS api_hub_sites (
  id              TEXT PRIMARY KEY,
  site_name       TEXT NOT NULL,
  site_url        TEXT NOT NULL,
  site_type       TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  user_id         INTEGER,
  username        TEXT,
  exchange_rate   REAL NOT NULL DEFAULT 1,
  sort_index      INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  last_sync_error TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_hub_groups (
  site_id     TEXT NOT NULL,
  group_name  TEXT NOT NULL,
  ratio       REAL,
  description TEXT,
  sort_index  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, group_name),
  FOREIGN KEY (site_id) REFERENCES api_hub_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_hub_models (
  site_id       TEXT NOT NULL,
  model_name    TEXT NOT NULL,
  enable_groups TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (site_id, model_name),
  FOREIGN KEY (site_id) REFERENCES api_hub_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_hub_tokens (
  site_id      TEXT NOT NULL,
  token_id     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  group_name   TEXT,
  key          TEXT,
  status       INTEGER,
  remain_quota INTEGER,
  expired_at   INTEGER,
  updated_at   INTEGER,
  PRIMARY KEY (site_id, token_id),
  FOREIGN KEY (site_id) REFERENCES api_hub_sites(id) ON DELETE CASCADE
);

ALTER TABLE providers ADD COLUMN api_hub_origin TEXT;
```

`api_hub_origin` 格式：`<site_id>:<group_name>:<model_name>`，便于将来反查 Api-Hub 导入历史。

### 2.3 后端 Adapter

`src-tauri/src/services/api_hub/`：

```text
mod.rs        // 导出 + 公共类型
types.rs      // GroupInfo / ModelInfo / TokenInfo / SyncReport / ImportToAppsReq
adapter.rs    // trait ApiHubAdapter + build_adapter()
new_api.rs    // new-api 协议实现
sub2api.rs    // Sub2Api 协议实现
dao.rs        // 4 张表 CRUD
sync.rs       // 协调器 + 进度事件
align.rs      // 对齐算法
```

#### Adapter trait

```rust
#[async_trait]
pub trait ApiHubAdapter: Send + Sync {
    fn site_type(&self) -> &'static str;
    async fn list_groups(&self, ctx: &SiteCtx) -> Result<Vec<GroupInfo>>;
    async fn list_models(&self, ctx: &SiteCtx) -> Result<Vec<ModelInfo>>;
    async fn list_tokens(&self, ctx: &SiteCtx) -> Result<Vec<TokenInfo>>;
    async fn create_token(&self, ctx: &SiteCtx, req: CreateTokenReq) -> Result<TokenInfo>;
    async fn rename_token(&self, ctx: &SiteCtx, token_id: i64, new_name: &str, group: &str) -> Result<()>;
    async fn delete_token(&self, ctx: &SiteCtx, token_id: i64) -> Result<()>;
}

pub fn build_adapter(site_type: &str) -> Box<dyn ApiHubAdapter> {
    match site_type.to_ascii_lowercase().as_str() {
        "sub2api" => Box::new(Sub2ApiAdapter::new()),
        _         => Box::new(NewApiAdapter::new()), // 未知 site_type 兜底
    }
}
```

#### new-api 实现要点

- 鉴权头扇出：`Authorization: <token>`（**裸 token，不加 Bearer**），同时塞 `New-API-User / Veloera-User / voapi-user / User-id / Rix-Api-User / neo-api-user / done-api-user`，值都是 `user_id` 字符串
- 路径：
  - groups：`GET /api/user/self/groups`（404 时降级 `/api/user/groups`）
  - pricing：`GET /api/pricing`（data[].enable_groups 拆分模型与分组映射）；失败降级 `GET /api/user/models`（无 group 关联）
  - tokens 列表：`GET /api/token/?p=0&size=200`，兼容 `[...]` 与 `{items, total}` 双形态
  - 创建：`POST /api/token/`，body `{ name, group, unlimited_quota: true, expired_time: -1, remark: "由 cc-switch Api-Hub 创建" }`
  - 编辑：`PUT /api/token/`，**body 里塞 id 寻址**（不是 RESTful path），同时带 `name`、`group`
  - 删除：`DELETE /api/token/:id`

#### Sub2Api 实现要点

- 鉴权头：`Authorization: Bearer <jwt>`
- JWT 续期：每次请求前检查 exp，临近过期 → `POST /api/v1/auth/refresh`，新 access_token 写回 `api_hub_sites.access_token`
- 路径：
  - groups：`GET /api/v1/groups/available` + `GET /api/v1/groups/rates`（rates 提供 model→groups 映射）
  - models：`GET /api/v1/channels/available` + groups.rates 交叉
  - tokens：CRUD 全在 `/api/v1/keys`（`GET ?page=&page_size=`、`POST`、`PUT /:id`、`DELETE /:id`）
  - 创建 body：`{ name, group_id, quota, expires_in_days }`
  - 重命名 body：`PUT /api/v1/keys/:id` 带 `{ name, group_id }`

#### 未知 site_type 兜底

工厂直接走 NewApiAdapter；包一层 `try_with_fallback`，失败时 `last_sync_error = "已按 new-api 协议尝试，失败原因: <err>"`，前端 badge 显示「<原 site_type> · 已按 new-api 处理」（成功）或红色感叹号（失败）。

### 2.4 Tauri 命令清单

挂在 `commands/api_hub.rs`：

| 命令 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `api_hub_import_json` | `AccountsBackup` | `ImportReport { new, updated, skipped }` | 解析 JSON 并 upsert 到 api_hub_sites |
| `api_hub_list_sites` | `SiteFilter { search, page, page_size }` | `Paged<SiteRow>` | 列表 + 模糊搜索（DB 层 LIKE） |
| `api_hub_get_site_detail` | `site_id` | `SiteDetail { site, groups, models, tokens }` | 单站详情（popover/dialog 用） |
| `api_hub_clear_all` | `()` | `()` | 清空 api_hub_* 4 表 |
| `api_hub_sync_site` | `site_id` | `SyncReport` | 单站同步 |
| `api_hub_sync_sites` | `Vec<site_id>` | `()` | 多站串行，emit `api_hub_sync_progress` |
| `api_hub_align_sites` | `Vec<site_id>, AlignOptions` | `()` | 串行对齐，emit `api_hub_align_progress` |
| `api_hub_import_to_apps` | `ImportToAppsReq` | `ImportToAppsReport` | 写 providers 表 |

进度事件载荷：

```ts
type Progress = {
  site_id: string;
  site_name: string;
  index: number;   // 1-based
  total: number;
  step?: string;   // "fetching_groups" | "fetching_models" | "renaming_token" | ...
  status: "pending" | "running" | "success" | "failed" | "warn";
  error?: string;
};
```

### 2.5 对齐算法

输入：`site_id`，`AlignOptions { rename_existing: true, delete_extra: true }`（默认值，后续可在 UI 上暴露）

```text
1. sync_site(site_id) 拉最新 groups + tokens
2. 按 group_name 分桶 tokens
3. 对每个分组 G：
   a) bucket[G] 内找 name == G 的 token
      - 找到 → 跳过
      - 未找到但 bucket[G] 非空 → 取首个调 rename_token(id, G, group=G)
      - bucket[G] 为空 → create_token({ name: G, group: G, unlimited_quota: true, expired_time: -1, remark })
   b) 多余处理：bucket[G] 中 name != G 的 → delete_token（二次校验 group_name == G）
4. 写回 api_hub_tokens
5. 每完成一个分组 emit progress
```

非致命错误（删除多余失败、单分组失败）→ 继续后续分组，整体返回 partial-success。

### 2.6 导入应用算法

```text
1. selections 涉及的分组 → distinct_groups
2. 查 api_hub_tokens：是否每个分组都有 name==group 的 token
   缺失：
     auto_align_if_missing == true → align_partial(site_id, missing_groups)
     否则 → 返回 NeedAlignError(missing_groups)，前端引导用户改"先对齐再导入"
3. 重读 tokens，构建 group_to_apikey: HashMap<String, String>
4. 笛卡尔积 selections × target_apps：
   provider_name = `${site_name} · ${group} · ${model}`
   provider_id   = `apihub-${site_id_short8}-${group_slug}-${model_slug}-${app}`   // 幂等键
   settings_config = apiHubTemplates[app]({ siteUrl, apiKey, modelName })
   upsert into providers (id, app_type) 设置：
     - category = "aggregator"
     - meta.providerType = site_type
     - api_hub_origin = `${site_id}:${group}:${model}`
     - icon = "newapi"
5. 返回 ImportToAppsReport { created, updated, failed[] }
```

各应用模板写在前端 `src/config/apiHubTemplates.ts`，通过 invoke 时把生成的 `settings_config` 一并传给后端 upsert。

### 2.7 前端文件清单

```text
src/components/settings/
  ApiHubPanel.tsx
  ApiHubToolbar.tsx
  ApiHubSearchBar.tsx
  ApiHubSiteRow.tsx
  ApiHubGroupsPopover.tsx
  ApiHubImportJsonDialog.tsx
  ApiHubAlignProgressDialog.tsx
  ApiHubImportAppsDialog.tsx
  ApiHubClearConfirmDialog.tsx

src/hooks/
  useApiHubSites.ts
  useApiHubMutations.ts
  useApiHubProgress.ts

src/lib/api/apiHub.ts
src/types/apiHub.ts
src/config/apiHubTemplates.ts
```

`SettingsPage.tsx` 改造：

- `grid-cols-6` → `grid-cols-7`
- 在 `usage` 与 `about` 之间插入 `<TabsTrigger value="apiHub">{t("settings.tabApiHub")}</TabsTrigger>`
- 新增 `<TabsContent value="apiHub">` 渲染 `<ApiHubPanel />`

### 2.8 国际化

详见正文第 4.5 小节。zh / en / ja 三语全覆盖。

### 2.9 错误处理矩阵

| 错误来源 | 后端 | 前端 |
|---|---|---|
| JSON 格式非法 | Err("error.importJsonInvalid") | toast.error |
| 同步网络/401 | last_sync_error 记原因 | 列表行红色感叹号 + hover 原因 |
| 未知协议成功兜底 | last_sync_error = NULL | 灰色 badge + tooltip |
| 未知协议兜底失败 | last_sync_error 写明 | 红色 badge + tooltip |
| 对齐 rename/create 失败 | 该分组标 failed，其他继续 | 进度 dialog 红行 |
| 对齐删多余失败 | 标 warn，继续 | 进度 dialog 黄行 |
| 导入应用缺 token 且 auto_align=false | 返回 NeedAlignError(missing) | dialog 黄条 + 按钮切换 |
| Sub2Api JWT refresh 失败 | last_sync_error = "JWT refresh failed: ..." | 提示用户去 api-hub 重新导出 JSON |

### 2.10 测试策略

**后端 Rust 单测**

- `dao.rs`：内存 SQLite 跑 v0→v12 迁移 + 4 表 CRUD 往返
- `new_api.rs` / `sub2api.rs`：`mockito` 起 mock server，断言路径 / header / body
- `align.rs`：3 种 fixture（已对齐 / 缺失 / 多余） → 断言操作序列
- `sync.rs`：进度事件顺序

**前端 vitest**

- `apiHubTemplates.ts`：6 应用 snapshot
- `useApiHubMutations`：mock invoke + React Query cache 失效

**手工验收**

1. 用 `accounts-backup-2026-05-14.json` 导入 → 列表展示
2. 选中一个站点 → 对齐 → 进度可见 → 完成后 APIKey 数 ≥ 分组数
3. 同站点点「导入应用」→ 选 1 模型 × 2 应用 → providers 表新增 2 条
4. 「清空」→ api_hub_* 表清空，刚才导入的 providers 仍在

---

## 3. 非目标 / 边界

- 不实现"站点登录刷新"。Sub2Api JWT 过期且 refresh 失败时，引导用户回 api-hub 浏览器扩展重新导出 JSON
- 不实现 access_token 加密存储（与项目现有 providers.settings_config 中明文 token 一致）
- 不在"清空"按钮里删除"通过 Api-Hub 导入到 providers 表的供应商"。如需此能力，后续可基于 `api_hub_origin` 列扩展
- 本期不支持站点登录态自动续期之外的其他写操作（账号绑定、公告等 Sub2Api 独有功能）

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 不同 new-api fork 路径细微差异 | 全协议扇出 user-id header；关键端点写降级链路 |
| `PUT /api/token/` 在 body 寻址易写错 | adapter 单测覆盖，body 一定带 id + group + name |
| 对齐误删 token | 删除前二次校验 token.group_name == 当前 G |
| 并发量大时同一 access_token 触发服务端限流 | 站点间串行，站点内顺序处理；不支持并发对齐 |
| 用户重复导入 | provider_id 用稳定哈希键 + upsert，幂等 |
| Sub2Api JWT 短期续期失败 | last_sync_error 写明，UI 提示重导出 JSON |

## 5. 实施计划

后续由 `writing-plans` 技能产出详细分阶段实施计划。本文档作为规格说明，已完成与用户多轮交互式确认（共 6 节设计）。
