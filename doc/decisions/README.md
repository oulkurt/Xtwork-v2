# Architecture Decision Records

[DECISIONS.md](../../DECISIONS.md) 是决策入口。`AGENTS.md` 的「冲突处理」规定何时暂停受影响工作、核对已有决定和更新相关记录。ADR 保存单项重大取舍的证据、后果和演变。实现说明和规划从 [文档首页](../README.md) 查阅。

## 创建与更新

1. 从 [模板](template.md) 复制，使用下一个未用过的三位编号。文件名为 `NNN-short-topic.md`，记录标识为 `ADR-NNN`。按主题写一项长期取舍。`PD-NN` 表示待确认的项目决策，`P-NN` 表示上游补丁。 [补丁清单](../plan/02-上游与改造层.md#4-补丁清单初稿)
2. 为新提案填 `Proposed`，链接到 [Pending Decisions](../../DECISIONS.md#pending-decisions)。引用带日期的讨论、固定提交或明确标注的规范，把实现证据与批准依据各自注明。沿用已有 Q 编号。
3. 有明确批准记录后更新为 `Accepted`，记下批准出处，将记录从待决策移入当前生效。方案被明确否决时用 `Rejected`，移出待决策并保留理由。
4. 用新 ADR 替代已生效决定时，让新旧记录互相链接，把旧记录改为 `Superseded` 并移入历史索引。保留原决定和依据。
5. 在同一次文档变更中更新索引、关联 ADR 和审阅所需的链接。相对链接用于当前树，跨分支证据用固定提交链接。

当前生效的插件 v2 双轨运行时取舍见 [ADR-010](010-plugin-v2-runtime.md)，基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务见 [ADR-011](011-mingle-im-bridge.md)。

证据标签沿用 [索引中的定义](../../DECISIONS.md#证据范围)。日期记录决定或提案首次见于文档的时间。历史材料只有日期而缺审批细节时，记下来源及其范围。
