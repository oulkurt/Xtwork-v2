# ADR-009 · 内置 Pi 作为默认助手

- **Date** 2026-11-20
- **Status** Accepted，替代 [ADR-002](002-default-dim-runtime.md)（2026-11-25 由 [ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 定名「小瞳」并演进为多渠道模型平面与编码委派）
- **Evidence** Confirmed · 项目负责人于 2026-11-20 在本次架构讨论中确认 Pi 并退出 Dim Agent Alpha。

## Context

Dim Alpha 已验证 v2 桌面底座。现场继续维护 Dim 的生态接入、ACP 行为差异和 daemon 生命周期，投入超出项目能承担的范围。锁定的 T3 版本已经提供原生 Pi 适配器与 MCP 工具桥。 [桌面底座 PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1) · [T3 的 Pi 支持](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/docs/user/providers-pi.md)

## Decision

随应用打包锁定版本的 Pi CLI，复用 T3 的原生 `provider-pi` 和按会话注入的 MCP 桥。小瞳 Work 管打包、默认实例、私有运行目录、品牌和网关接入。T3 管对话编排与鉴权，Pi 管原生续聊，Go 宿主管插件数据。正式模型授权继续按 Q-03 和 PD-02 确认。 [接口与验收](../plan/03-内置运行时-Pi.md) · [ADR-008](008-model-gateway.md)

## Synthesis

采用 Gemini 4 Neon 的原生 CLI 路线。交叉评审以打包、真实 MCP 回合和原线程续聊为依据，优先保留上游拥有的探测与恢复逻辑。采纳入口环境过滤、应用数据内的稳定工作目录和停用旧实例记录。SDK 方案提出的后台生成兼容性由私有 `models.json` 承接。 [实跑结果](../desktop-foundation.md#验收)

## Considered Alternatives

- **带私有配置的上游 CLI。** T3 继续调用已支持的 RPC 和探测入口。应用补一对很小的启动器，其中 shell 启动器负责清理产品凭据。
- **基于 Pi SDK 的自有引导。** 可在内存注入模型凭据和资源策略，需要维护与 T3 的 CLI 探测、后台生成、资源重载和恢复契约。
- **Pi 经 ACP 接入。** 需要再增加一层协议适配，复核 Pi 原生会话、工具发现与权限确认的映射。

## Consequences and Trade-offs

使用 T3 的原生 Pi 适配减少一层协议维护。发布验收覆盖确切的 T3 与 Pi 版本组合，以及随包 Node、npm 依赖许可、模型流、MCP、权限、续聊和退出。预览先提供 `standard` 单路由。 [模型网关](../plan/13-模型网关.md) · [发布验收](../plan/09-品牌与发布.md#4-发布验收)

## Migration Implications

旧 Alpha 的内置实例保留为停用的 `xtworkDim` 记录，Pi 使用 `xtworkPi`。设置迁移更新仍指向旧内置实例的默认项。历史对话与待办复用 T3 和 Go 宿主已有的存储，原生会话文件各自保留。 [迁移规则](../plan/03-内置运行时-Pi.md#3-原有-alpha-数据) · [ADR-007](007-plugin-contract.md)

## Related Decisions

- [ADR-002 · 内置 Rust 版 Dim（已替代）](002-default-dim-runtime.md)
- [ADR-008 · 正式模型网关](008-model-gateway.md)
- [ADR-012 · M1 重构：小瞳多渠道模型平面与 6 大编码 Agent 委派](012-xiaotong-model-channels-and-coding-agents.md)
- [ADR-013 · Leader 主管与按 Run Fail-Closed 策略](013-leader-supervisory-threads.md)
- [决策索引](../../DECISIONS.md)
