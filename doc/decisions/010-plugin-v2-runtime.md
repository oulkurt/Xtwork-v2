# ADR-010 · 插件 v2 双轨运行时与模态承载

- **Date** 2026-11-20
- **Status** Accepted
- **Evidence** Confirmed · Gemini 4 Neon 与 Codex 交叉讨论后达成一致

## Context

现有插件通路已经能让功能型待办插件通过 Go 宿主、moejs worker、MCP 和沙箱 iframe 工作，但清单仍是 `api: 1`，外观扩展没有独立边界，待办面板也自行创建 `Sheet`。继续把外观资源接入功能运行时会让首屏主题、权限和插件生命周期互相耦合。

用户制作插件需要一个短路径。安装、校验、Reload 和错误诊断要统一，功能执行和外观应用要按风险分开。

## Decision

### 单一目录，双轨执行

所有插件仍使用一个 `plugin.json` 和一个目录校验入口。`api: 2` 的清单以 `kind` 作为强判别键。

- `kind: "functional"` 可以声明 worker、功能能力、工具和沙箱视图。
- `kind: "appearance"` 只能声明静态主题 token、受限图标和静态背景。
- `api: 2` 禁止混合清单。越界字段在校验阶段拒绝，并返回 `file`、JSON Pointer 和 `message`。
- 旧 `api: 1` 功能清单继续按兼容路径读取，内置待办迁移到 `api: 2`。

功能插件继续由 Go `plugin-host` 监管 moejs worker。外观插件由 Web 侧 `AppearanceApplier` 读取已校验的声明式数据，按主题槽位互斥应用。外观插件不启动 worker，不创建 iframe，不执行 JavaScript，不注入任意 CSS 或 HTML。

### 能力和贡献

`capabilities` 表示 worker 调用宿主服务的运行时权限，`contributes` 表示静态注册项。声明能力不会自动获得授权，宿主仍需检查已授权集合。

功能插件的业务存储按 `pluginId` 私有隔离。插件之间没有 RPC，也没有跨插件状态总线。核心外观状态和插件入口徽标由宿主维护，功能插件只能更新自己的受限徽标。

### 单活跃模态承载

功能插件视图使用基于现有 `AppRouteModal` 的 `PluginModalHost`。它保持同一时间只有一个插件模态视图，复用设置和用量已有的遮罩、Esc、焦点回收和原生标题栏安全区。

外观插件不占用主侧栏入口。外观预览和切换由核心页面承载，插件提供的静态数据不会生成自己的 UI 运行时。

### 第一阶段边界

第一阶段只实现本地插件快照、全量清单校验、Reload、结构化诊断、双轨注册模型和功能插件模态承载。Reload 先校验 staging 快照，再原子替换可用版本。新增能力必须重新授权，校验失败保留上一份可用快照。

远程安装、市场、自动升级回滚和动态视觉挂件属于后续阶段。

## Invariants

1. `api: 2` 的 `kind` 是 Schema 级强判别键，功能和外观字段严格互斥。
2. 外观插件全程零 worker、零 iframe、零 JavaScript、零任意 CSS/HTML 注入。
3. 安装和 Reload 使用无符号链接快照，先校验再原子替换，失败保留旧快照。
4. 功能插件模态视图和设置、用量共享 `AppRouteModal` 的单活跃承载约束。
5. 跨插件业务状态共享为零，插件存储按 `pluginId` 私有隔离。

## Consequences

功能和外观需要两套激活逻辑，但目录校验和用户看到的插件身份仍然统一。外观主题可以在首屏缓存后同步生效，不依赖 Go 宿主。功能插件继续拥有工具、上下文和视图能力，但所有能力调用都经过已有宿主边界。

## Phase 1 deliverables

- `plugin-host/protocol/v2/plugin-manifest.schema.json`
- `api: 2` 功能和外观清单校验
- 内置待办清单迁移为 `kind: "functional"`
- 功能运行时和外观应用器的独立注册结果
- 基于 `AppRouteModal` 的 `PluginModalHost`
- `/doc` 中的协议、验证命令和剩余范围记录
