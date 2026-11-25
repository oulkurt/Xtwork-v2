# ADR-008 · 正式模型网关的部署与凭据边界

- **Date** 2026-11-19
- **Status** Accepted（2026-11-25 由 [ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 演进并细化为 4 协议 Proxy-Only 本机网关 + 单一硬化 OS SecretStore；M1b-Gate 1 底座已于 [PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24) 合入 `main`，M1b-Gate 2 待真机验收）
- **Evidence** Confirmed · 预览单路由网关在 PR #1 验证，多协议 Proxy-Only 底座与集成测试已在 PR #24 合入 `main`，企业微信 OIDC 与 19 类供应商真实账号实跑待 M1b-Gate 2 验收。

## Context

Pi 执行会话与工具调用。规划通过模型别名和网关解耦运行时与实际模型厂商。桌面预览已走通一个 `standard` 路由。 [模型网关规划](../plan/13-模型网关.md) · [预览验收](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md#首轮验收)

## Problem

产品需要决定谁提供模型、谁持有厂商密钥、用户如何授权及撤销，以及何时能启用可切换的第二个模型。

## Considered Alternatives

- 产品供模。规划用 HTTPS 云端网关、可撤销产品令牌和服务端的厂商密钥。
- 自带 Key。规划用独立本机 Go 服务和系统钥匙串。
- 预览通路。T3 Node 进程内启动 loopback 网关，默认转发本地 Magpie。可从设置的服务器密钥文件路径读 Key，内置助手只接收网关令牌。 [进程和凭据设计](../plan/13-模型网关.md#2-接口协议保真与进程边界) · [预览网关代码](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/runtime/gateway.ts)

## Decision

候选契约是 Pi 以独立 Bearer 调用 `POST /v1/chat/completions`，网关按产品别名映射模型并流式转发，服务端或网关一侧持有厂商凭据。Q-03 与 PD-02 决定正式部署、账号、凭据、出站说明和模型目录。 [协议保真与流式转发](../plan/13-模型网关.md#2-接口协议保真与进程边界) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

预览代码实现独立令牌、单别名、请求体限制和流转发。PR 记录 DeepSeek 路由实测，默认免费线路遇到额度限制。当前 Pi 预览使用隔离模型目录和原生模型发现。`deep`、正式密钥管理和令牌轮换需要独立验收。 [模型 ID 与热刷新边界](../plan/13-模型网关.md#3-稳定模型-id零渠道态与活跃-pi-会话热刷新) · [预览网关](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/runtime/gateway.ts) · [PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1)

## Migration Implications

切到正式网关时确认预览的密钥文件、`standard` 别名、现存会话及 Pi RPC 进程的切换行为。正式方案需验收凭据更新、撤销后拒绝请求以及旧对话恢复。接入 Obsidian 前明确笔记发送到已配置模型服务的提示和留存规则。 [凭据与硬化边界](../plan/13-模型网关.md#4-凭据安全硬化-secretstore-与合规边界)

## Related Decisions

- [ADR-009 · 默认运行时](009-default-pi-runtime.md)
- [ADR-012 · M1 重构：小瞳多渠道模型平面与编码 Agent](012-xiaotong-model-channels-and-coding-agents.md)（已生效，将本 ADR 的单路由预览网关演进为 Proxy-Only 多协议本机反向代理 + 企业微信公司渠道 + 19 类成员供应商）
- [ADR-007 · 插件契约与权限](007-plugin-contract.md)
- [待决策事项](../../DECISIONS.md#pending-decisions)
- [决策索引](../../DECISIONS.md)
