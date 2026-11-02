## 0.5.0 — 2026-11-02

社区反代调研（gh 全网搜 deepseek-harness.edgeone.cool 的三个反代项目 + 官方文档库）后落地的三项成熟设计。调研结论：采纳 diaoxiaoniu/DSH2API 的 EMA 自适应超时与 SSE 心跳、edgeone2api 的会话生命周期自愈；拒绝 tool-name 白名单（围栏协议已隔离）、浏览器指纹池（单用户场景）、粘性+历史重放（入池指纹比它严）。

- **EMA 自适应超时（新增 `src/rtt.mjs`）**：上游健康期 unary 0.2–2s、拥堵期 10s+，固定 20s 上限要么杀慢请求要么陪跑。现在每个 RPC 族（method 名）记一条成功 RTT 的 EMA（α=0.3，只记成功——超时说明不了它没跑完的分布），守卫 = max(floor, 2×EMA, min(水位, CAP))：水位是最近一次被弃调用的时长，补「拥堵期没有成功样本、EMA 冻结」的盲区；成功即清水位。显式 `timeoutMs`（prompt/history/models 探测等）不受影响。进程级共享一个 recorder，`up.rtt` 暴露给测试。
- **SSE 心跳 `: ping`**：上游 agent 跑沙盒工具时整段静默，客户端侧 10s+ 无字节会招来中间代理掐流。流式响应现在每 15s 静默后发一条 `: ping` 注释帧（所有解析器都忽略注释），真实 delta 会重置时钟；间隔经 `deps.heartbeatMs` 可注入，测试不用等真实 15s。
- **会话生命周期自愈（session-not-found 重试一次）**：上游约 20min 回收空闲会话，租约校验（selectModel）与 prompt 落地之间仍有窗口。现在整个获取+执行包进 `for(;;)`：prompt 阶段拿到 `session-not-found` 即丢弃死会话/尾流，换新 conversation 用**完整** transcript 重试一次（新会话没见过前文，不能只发增量切片）；第二次 notfound 是真错误（502）。客户端已见到字节后（流式进行中）绝不重试。每轮尝试独立的 pumpAc 控制器：重试只停孤儿 pump，不杀整个请求的 ac。
- **测试 80→89**：rtt 纯函数六条（floor/EMA 展宽/水位/清水位/CAP/rpc 真喂 recorder）+ 心跳一条（静默覆盖、注释不破帧、ping 只盖静默）+ 自愈两条（notfound 后换会话重发完整 transcript 且只重试一次；第二次 notfound 报 502）。fake 加 `failPrompts` 钩子（prompt 应答 session-not-found），`chat()` 助手加 `extraDeps`。
- 门禁：bun 89/0、node 89/0、check 42/0/0、score 60/65（C 待人工）。

## 0.4.0 — 2026-11-02

装机后真实使用暴露的三处宿主对接问题 + 对齐原项目预热设计。

- **登录不再转圈（最重）**：`authorize()` 里做了 `llm.models` 活体探测，而宿主是点了「启用」就同步等 authorize 返回——上游约 40% 的请求挂起，登录按钮无限转圈。现在 authorize 即时返回 `{type:"success"}`（零网络，GUIDE 铁律「authorize 必须立刻返回」）；可达性由 `provider.models`（17s 预算，失败回退静态表）与 usage 的 probeState 呈现。
- **provider.models 20s 超时**：宿主给模型表拉取 20s 预算，原来的 unary 重试梯子（3 次 × 20s）必然撞线。收紧到 2 次 × 8s + 2s 退避、17s 总预算，最坏也留在门内；失败回退静态表，永不给空表。装进 magpie 实测：无超时报错，9 个模型即时就绪。
- **预热会话池（对齐原 Go 项目 warm 设计）**：后台按模型预创建 conversation+session（每模型 2 个、总量 6、TTL 10min 惰性淘汰），冷请求直接骑预热租约、跳过 `session.create`——链路里最飘的一环（EdgeOne 502，行内最多 3 次重试）。租约仍用一次真实 `selectModel` 验证，失效（被上游回收）即丢弃回退行内创建；补货失败静默、请求路径绝不依赖池。社区插件无可抄（它们的上游没有会话引导环节），参照系就是原项目的 MinWarm/MaxWarm/TTL/首 prompt 健康检查。
- **模型标 `free: true`**：上游无任何计费面（无账号、无积分、llm.models 无价格字段——厂商免费是设计事实），按规范「只认厂商声明」给两套模型表都标 free，喂 magpie 的 Free-first 路由。单匿名账号的「剩余额度未知」是纯展示问题：账号内部无排序可做，伪造余额只会污染余额走势图。
- **测试 77→80**：新增预热池三态（命中跳过 create / 失效租约回退 / 补货失败静默），fake 加 `failSelects`/`failCreatesFrom` 钩子与 `_drainWarm` 排空；`deps.warm:false` 让既有计数测试与后台补货解耦。
- 门禁：bun 80/0、node 80/0、check 42/0/0、score 65/65。真实上游：预热机制验证（第三轮 6.8s、池回填）；上游拥堵期（llm.models 两次 10s 超时、create 3.2s）重试与 history 兜底全部把请求兜活。

## 0.3.0 — 2026-11-02

对 0.2.0 的会诊修复：四个实锤 bug（全部带现场复现证据）+ 一处顺带的观测性改进。

- **mux 头不再阻塞 prompt（最重）**：旧代码 `await pump.ready` 让 `session.prompt` 等待 events.mux 响应头，而实测该头要 2.5–5.8s、约 40% 的请求干脆 25s 超时——用户的 prompt 最坏延迟 25 秒才提交。现在尾流与 `selectModel` 并行打开、prompt 即刻提交；订阅点之前漏掉的事件由 session.history 无损回补（seq 过滤合并两路）。
- **SSE 尾流不再被 25s 掐死**：`fetchTimed` 的 deadline 原先覆盖整个响应体生命周期，长尾流在整 25s 处必然 `DshTimeout`（实测 25014ms），40s 空闲看门狗沦为死代码、超 ~22s 的轮次全部被赶到 history 轮询。现在 `bodyDeadline:false` 让 events.mux 尾流把生命周期交给 pump 的空闲看门狗与整轮上限；实测尾流挂过 32s 依然存活。
- **头迟迟不落时不再静默**：等待头的每个 2s 切片超时后就先用 history 轮询喂客户端——头再慢（或永远不来）也不能哑掉一个正在生成的轮次。
- **单次 history 轮询失败不再判死整轮**：轮次还在上游跑，瞬时失败（网关 5xx/看门狗）只重试；仅语义错误（session 被回收）才失败。
- **流式 tool_call id 只铸一次**：客户端收到的块与入池回显共用同一组 `call_*` id——旧代码两次 `toOpenAIToolCall` 铸出不同 id，而指纹规范化包含 id，导致所有带工具的流式轮次永远命不中暖会话。实测流式工具轮的后续请求 `session.create` 0 次（复用成功）。
- **整轮时限从固定 240s 改为「空闲 + 绝对」双限**：旧 `TURN_TIMEOUT_MS=240s` 是对总时长的固定掐死——上游是 agent 沙盒，一轮跑工具跑 35s+ 很正常，长轮次会被拦腰截断。现在 `TURN_IDLE_MS=300s`（上游 5 分钟无任何事件=死）+ `TURN_ABSOLUTE_MS=900s`（15 分钟天花板）；history 轮询取到新事件同样刷新进度时钟。插件只负责把对话完整接通，掐多快由 magpie 路由的 firstToken 决定。
- **history 轮询退避**：mux 断流后的轮询循环加指数退避（1.5s 起、封顶 3s），连续空轮不再 1.5s 一次打上游。
- **loader.fetch 解码字节 body**：SDK 通常发 JSON string，但字节 body 也合法——原先会被 `String()` 拼成乱码再 JSON.parse 失败。
- **并发验证（测试 + 真实上游双管）**：新增 6 条 concurrency 套件——8 路并行请求互不串话、同指纹并行只骑一个暖会话、abort 只杀自己不伤邻居、调用方 signal 上零残留监听器、池容量上限、流式+非流式并行。并用变异测试验证牙口：固定指纹（不查池）被指纹测试抓住、所有会话共用一个 convId（串话 bug 形态）被 5 条并发测试当场抓住。真实上游 6 路并行（3 流式 3 非流式，各带唯一暗号）全部隔离命中、零失败，总墙钟 37s。
- **杂项**：移除死代码 `PROVIDER_NAME`/`OPEN_TIMEOUT_MS`/`composePrompt` 的 `isContinuation` 参数；`withBodyDeadline` 正常结束时移除外层 abort 监听（每轮一次的无谓保留）；`pump.ready` 改为只 resolve（无人 await 的 rejected promise 是 unhandled rejection）；测试 63→76 条。
- 实测（真实上游）：流式 878 deltas、maxGap 122ms、无 >3s 间隙；尾流与 selectModel 同毫秒并行打开；暖轮 prompt_tokens 170–179 vs 冷启动 1780–1792。

## 0.2.0 — 2026-11-02

稳定性打磨版：会话复用、全链路时限、可测性。

- **会话池与 prompt 缓存复用**：成功的轮次不再 cancel 上游会话，而是按「上下文指纹」（规范化 transcript + tools + assistant 回显的 FNV-1a 64）入池（TTL 10 分钟、容量 4）。下一请求的 transcript 前缀指纹精确匹配才复用，prompt 只发新增轮次（NEW TURNS 段），复用失败任意原因都回退全量冷启动。实测同会话第二轮 prompt_tokens 213（cacheRead 1536）vs 冷启动 1728。
- **全链路时限**：每个 unary RPC 独立看门狗（含响应体阶段——头到了体挂起也能唤醒卡死的 `json()`/`reader.read()`），超时是 typed `DshTimeout`（transient 可重试），与客户端 abort 严格区分；SSE 空闲看门狗 40s；整轮上限 240s；客户端 abort 全链传导——真正取消上游会话（session.cancel）、释放 body/定时器/监听器，cleanup 幂等。
- **重试分类**：仅 transient（bad-gateway/timeout/dns/connection-reset）重试，业务错误（ok:false）一律不重试；`session.prompt` 永不重试（防重复执行）；budget 封顶整次调用墙钟时间。
- **mux 断流的降级**：events.mux 打不开不再判死整轮——回退 session.history 轮询取事件，轮询到 turn/end 为止。
- **流式完成也会入池**：SSE 路径结束后按累计文本+tool_calls 组装回显入池，与非流式一致；流中被 abort 则不 park，走 cancel。
- **required/tool_choice 空转兜底**：模型只回纯文本时合成 `arguments:"{}"` 的调用，不空转。
- **fence 体上限 64KB→256KB**：write-file 类大参数不再整块退化为文本；超限仍逐字透传、绝不伪造调用（新增 200KB 解析 + 300KB 超限两条测试）。
- **测试 34→63 条**：新增传输层（重试分类/看门狗/budget/外层 abort 保因）、handleChat 注入上游（并行工具/指纹复用与失配/mux 降级/502 重试/abort 取消/超大参数/非 JSON body）、续聊切分等；shim 补齐 `toBeGreaterThanOrEqual/toBeLessThan/toBeLessThanOrEqual/toMatch/toBeCloseTo`，bun 与 node --test 双运行时同套件全绿。

## 0.1.0 — 2026-11-02

首个发布版本。

- **匿名接入 DeepSeek Harness（EdgeOne Makers）**：keyless api 型登录，安装即用——无凭据、无续期、无账号体系。启用动作本身会对上游做一次 `llm.models` 连通性探测，失败直接报「无法连接上游」而不是装完才知道挂了。
- **静态模型表 9 个**（edgeone-makers 7 + deepseek-official 2）；`provider.models` 每 10 分钟跟随上游 `llm.models` 刷新，上游新增模型无需等插件更新。探测失败回退快照，模型表永不为空。
- **聊天桥**：每次请求新建 conversation + session（`makers-conversation-id` 隔离头），OpenAI `/chat/completions` 入参（system/多轮/工具结果）折叠为单一上游 prompt；`tools` 经围栏 ```tool_call 协议往返，`FencedParser` 流式安全提取——不完整围栏先扣留、普通代码块逐字节透传、坏块退化为原文，绝不伪造调用。
- **流式 / 非流式双形态**；`stream_options.include_usage` 时附带用量。
- **错误分级**：模型不存在/不可用回 404（不打死账号），上游忙回 503，传输失败仅重试传输层与 5xx 网关；usage 无额度不出 balance/windows/plan（保 keys 卡片折叠），checkin 固定 `inactive`。
