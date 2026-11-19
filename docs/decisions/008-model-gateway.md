# ADR-008 · 正式模型网关的部署与凭据边界

- **Date** 2026-11-19
- **Status** Proposed
- **Evidence** Confirmed · 已有正式方案草案和内测实现。首发选择为 Unknown。

## Context

Dim 执行会话与工具调用。规划通过模型别名和网关解耦运行时与实际模型厂商。桌面预览已走通一个 `standard` 路由。 [模型网关规划](../13-模型网关.md) · [预览验收](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md#首轮验收)

## Problem

产品需要决定谁提供模型、谁持有厂商密钥、用户如何授权及撤销，以及何时能启用可切换的第二个模型。

## Considered Alternatives

- 产品供模。规划用 HTTPS 云端网关、可撤销产品令牌和服务端的厂商密钥。
- 自带 Key。规划用独立本机 Go 服务和系统钥匙串。
- 预览通路。T3 Node 进程内启动 loopback 网关，默认转发本地 Magpie。可从设置的服务器密钥文件路径读 Key，Dim 只接收网关令牌。 [进程和凭据草案](../13-模型网关.md#2-接口和进程边界) · [预览网关代码](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/runtime/gateway.ts)

## Decision

候选契约是 Dim 以独立 Bearer 调用 `POST /v1/chat/completions`，网关按产品别名映射模型并流式转发，服务端或网关一侧持有厂商凭据。Q-03 与 PD-02 决定正式部署、账号、凭据、出站说明和模型目录。 [流式转发草案](../13-模型网关.md#4-转发与流式输出) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

预览代码实现独立令牌、单别名、请求体限制和流转发。PR 记录 DeepSeek 路由实测，默认免费线路遇到额度限制。Dim alpha.25 的 `--model-config` 与可切换的 ACP 模型目录分离，`deep`、正式密钥管理和令牌轮换需要独立验收。 [Dim 的配置约束](../13-模型网关.md#3-dim-与-t3-已核实的约束) · [预览网关](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/runtime/gateway.ts) · [PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1)

## Migration Implications

切到正式网关时确认预览的密钥文件、`standard` 别名、现存会话及运行时 daemon 的切换行为。正式方案需验收凭据更新、撤销后拒绝请求以及旧对话恢复。接入 Obsidian 前明确笔记发送到已配置模型服务的提示和留存规则。 [凭据与验收](../13-模型网关.md#5-凭据和设置)

## Related Decisions

- [ADR-002 · 默认运行时](002-default-dim-runtime.md)
- [ADR-007 · 插件契约与权限](007-plugin-contract.md)
- [待决策事项](../../DECISIONS.md#pending-decisions)
- [决策索引](../../DECISIONS.md)
