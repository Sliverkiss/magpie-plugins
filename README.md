# magpie-edgeone · EdgeOne DeepSeek 沙盒

一个 **无需密钥** 的 [magpie](https://github.com/MYCF711/magpie-plugin-scaffold) / OpenCode 供应商插件：把 [DeepSeek Harness](https://deepseek-harness.edgeone.cool)（EdgeOne Makers 上的免费匿名智能体沙盒）桥接成 OpenAI 兼容的 `/chat/completions`。安装、启用、对话——三步，没有账号、没有 token、没有额度页。

## 特性

- **装完即用（keyless）**：上游本身就是匿名服务（请求隔离靠每次新建的 conversation id，无账号体系）。插件声明 `keyless` 登录方式，点一次「启用」即可，`authorize()` 零网络、即时返回，不会有转圈等待。
- **9 个模型，自动跟随上游**：静态表保证离线可用；`provider.models` 周期性跟随上游 `llm.models` 刷新（20s 预算，失败回退静态快照，模型表**永不为空**）。上游新增模型无需等插件更新。
- **工具调用桥接**：上游沙盒不会执行你客户端的工具。插件把请求里的 `tools` 教给模型（围栏 ```tool_call 协议），流式解析模型回复中的工具调用并还原为 OpenAI `tool_calls`；解析器流式安全——不完整围栏先扣留、普通代码块逐字节透传、坏块退化为原文，绝不伪造调用。请求不带 `tools` 时协议清单完全不出现。
- **流式 + SSE 心跳**：增量逐字透传；上游静默（agent 跑沙盒工具）超过 15s 发 `: ping` 注释帧保活，避免中间代理掐流。
- **会话预热与复用**：后台按模型预热 conversation/session，请求免排队；成功轮次的会话按「上下文指纹」入池复用，下一轮 prompt_tokens 从 ~1800 降到 ~180（指纹不匹配则透明冷启动，正确性不依赖池）。
- **自适应超时与自愈**：每个 RPC 族维护成功 RTT 的 EMA，拥堵期自动放宽超时、挂死仍能在预算内失败；上游回收空闲会话导致的 `session-not-found` 自动换新会话重试一次（完整 transcript），客户端不感知。
- **免费标记**：模型声明 `free: true`，接入 magpie 的 Free-first 路由。

## 模型

| 分组 | 模型 |
|---|---|
| edgeone-makers | deepseek-v4-flash、deepseek-v4-pro、hy3、hy3-preview、minimax-m3、minimax-m2.7、kimi-k2.6 |
| deepseek-official | deepseek-v4-flash-official、deepseek-v4-pro-official |

均为纯文本输入输出（`capabilities.input.image` 显式 `false`），支持 tool_call。静态表为 2026-11-02 上游实测快照。

## 安装

```bash
# 从 npm（推荐）
magpie plugin add magpie-edgeone

# 从 GitHub 源码（跟随默认分支最新代码）
magpie plugin add github:Sliverkiss/magpie-plugins/magpie-edgeone

# 本地开发
git clone https://github.com/Sliverkiss/magpie-plugins && cd magpie-plugins/magpie-edgeone
magpie plugin add .
```

在 magpie 插件页启用「EdgeOne DeepSeek 沙盒」即完成接入。**供应商 id 为 `dsh2api`**（路由规则引用它，保持稳定不变）。

## 错误语义

| 情形 | 状态码 |
|---|---|
| 模型不存在 / 上游不可用 | **404**（不打死整个账号） |
| 上游忙 | 503 |
| 传输失败 / 网关 5xx | 502（自动重试 2 次，仅传输层） |
| 会话被上游回收 | 自动换新会话重试一次，第二次才报 502 |

签到固定返回 `inactive`（匿名沙盒无积分体系）；usage 只报身份不出余额，保持卡片折叠排版。

## 设计说明

上游协议（四象限 RPC 信封 + `/api/events.mux` SSE 下行）由本仓库 `src/upstream.mjs` 头部注释完整记录，协议于 2026-09 逆向、2026-11 实测复核。要点：

- 每个请求携带独立 deadline（fetch 阶段 + 响应体阶段），超时与客户端 abort 严格区分；
- `session.prompt` 永不重试（防上游重复执行），只重试瞬时传输故障；
- SSE 尾流与模型选择并行打开、prompt 即刻提交，头迟迟不落时由 `session.history` 轮询无损回补（seq 过滤合并两路）；
- 整轮时限采用「空闲 5 分钟 + 绝对 15 分钟」双限，长工具轮不腰斩。

## 免责声明

这是社区免费匿名沙盒的桥接，**非 DeepSeek 官方 API**，无 SLA，随时可能变动，请勿用于生产关键链路。请遵守上游服务的使用条款。

## 许可

MIT — 见 [LICENSE](LICENSE)。
