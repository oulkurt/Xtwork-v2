# Architecture Decision Records

[DECISIONS.md](../../DECISIONS.md) 是全仓决策与待决策事项（`Q-*` / `PD-*`）的唯一索引入口。当新方案与已生效 ADR 冲突时，必须先核对现有决定与不变量，按下方流程新增或修订 ADR，严禁静默覆盖历史决策正文。ADR 保存单项重大取舍的证据、后果和演变；实现说明和规划从 [文档首页](../README.md) 查阅。

## 创建与更新

1. 从 [模板](template.md) 复制，使用下一个未用过的三位编号。文件名为 `NNN-short-topic.md`，记录标识为 `ADR-NNN`。按主题写一项长期取舍。`PD-NN` 表示待确认的项目决策，`P-NN` 表示早期规划补丁编号（现行实建补丁台账见 [补丁台账](../plan/02-上游与改造层.md#4-实建补丁台账as-built)）。
2. 为新提案填 `Proposed`，链接到 [Pending Decisions](../../DECISIONS.md#pending-decisions)。引用带日期的讨论、固定提交或明确标注的规范，把实现证据与批准依据各自注明，禁止写入本机绝对路径或本地 `file:` URI。沿用已有 Q 编号。
3. 有明确批准记录后更新为 `Accepted`，记下批准出处，将记录从待决策移入当前生效。方案被明确否决时用 `Rejected`，移出待决策并保留理由。
4. 用新 ADR **完全替代**已生效决定时，让新旧记录互相链接，把旧记录改为 `Superseded by ADR-NNN` 并移入历史索引；用新 ADR **局部演进/修订**已生效决定时，保留旧记录的历史正文不可变，并在旧记录的 `Status` 行和 `Related Decisions` 中补齐反向链接（如 `Accepted（由 ADR-NNN 局部修订）`）。
5. 在同一次文档变更中更新索引、关联 ADR 和审阅所需的链接，并运行 `node scripts/check-docs.mjs` 核对跨文档锚点、ADR 编号与补丁台账一致性（并发 PR 合并后务必复跑以防编号错位）。相对链接用于当前树，跨分支证据用固定提交链接。

当前生效的插件 v2 双轨运行时取舍见 [ADR-010](010-plugin-v2-runtime.md)，基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务见 [ADR-011](011-mingle-im-bridge.md)，M1 内置助手「小瞳」多渠道模型平面、六大外部编码 Agent 一键安装与 Coding Agent 委派架构见 [ADR-012](012-xiaotong-model-channels-and-coding-agents.md)，Leader（Captain 式主管）、侧栏顶部固定入口、按 run 持久化执行策略与 Mingle 能力分级移植契约见 [ADR-013](013-leader-supervisory-threads.md)；已合议归入后续待办（`Proposed`）的领航员控制面 v2（同级派生、受控 Crew 工单、独立 Drive 与正交 Squad 小队）蓝图见 [ADR-014](014-navigator-control-plane-v2.md)。

证据标签沿用 [索引中的定义](../../DECISIONS.md#证据范围)。日期记录决定或提案首次见于文档的时间。历史材料只有日期而缺审批细节时，记下来源及其范围。
