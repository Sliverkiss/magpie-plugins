# magpie-plugins

[Sliverkiss](https://github.com/Sliverkiss) 的 [magpie](https://github.com/MYCF711/magpie-plugin-scaffold) / OpenCode 供应商插件合集。每个子目录是一个独立插件，各自带版本、CHANGELOG 与发布流程。

## 插件

| 插件 | 目录 | npm | 说明 |
|---|---|---|---|
| EdgeOne DeepSeek 沙盒 | [`edgeone/`](edgeone/) | [`magpie-edgeone`](https://www.npmjs.com/package/magpie-edgeone) | 无需密钥，把 DeepSeek Harness（EdgeOne Makers 匿名沙盒）桥接成 OpenAI 兼容对话：9 模型、工具调用桥接、流式 + 心跳、会话预热复用。 |

## 安装

```bash
# 从 npm（推荐）
magpie plugin add magpie-edgeone

# 从 GitHub 源码
magpie plugin add github:Sliverkiss/magpie-plugins/edgeone
```

## 开发

```bash
git clone https://github.com/Sliverkiss/magpie-plugins && cd magpie-plugins/edgeone
magpie plugin add .   # 本地目录安装，改完代码重新 add 即重载
```

每个插件自带 `scripts/check.mjs`（规范检查）、`bun test` / `npm test`（语义测试）与 `scripts/score.mjs`（脚手架评分）。CI 对 `matrix.plugin` 列出的每个插件目录跑同一套门禁，新增插件时在 `.github/workflows/ci.yml` 的 matrix 里加目录名即可。

## 许可

MIT — 各插件目录内见 LICENSE。
