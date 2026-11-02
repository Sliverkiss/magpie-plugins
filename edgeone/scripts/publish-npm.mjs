#!/usr/bin/env node
// 发布时临时换 name：仓库里的 name 是 slug（bun 依赖键），
// npm 上必须使用真正的 npm 包名。发布后无论成败都恢复原文件。
// 用法：npm run publish:npm
//
// 为什么不能直接 npm publish：package.json.name 是 bun 依赖键（slug），
// npm 名可能不同；发布前临时换成 PUBLISH_AS，发布完（包括失败）都恢复。
//
// CI=true 时，npm 报「同版本已存在」（E409 / previously staged）按成功处理：
// 本地 release.mjs --npm 可能已经发过，tag 触发的 workflow 不该因此变红。
// 本地仍报错并提示 bump。

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const PUBLISH_AS = "magpie-edgeone"
const file = new URL("../package.json", import.meta.url)
const original = readFileSync(file, "utf8")
const pkg = JSON.parse(original)

pkg.name = PUBLISH_AS
writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
try {
  const r = spawnSync("npm publish --access public", { shell: true, encoding: "utf8" })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`
    const exists = /E409|previously staged|EPUBLISHCONFLICT|cannot publish over/i.test(text)
    if (exists && process.env.CI === "true") {
      console.warn(`\n! npm 已有 ${PUBLISH_AS}@${pkg.version}，按已发布处理（CI）\n`)
      process.exitCode = 0
    } else {
      console.error(
        `\n✗ npm 发布失败：${PUBLISH_AS}@${pkg.version}\n` +
          `  如果 npm 说版本已存在（E409 / EPUBLISHCONFLICT / cannot publish over），先 bump version 再重试。\n` +
          `  原始退出码：${r.status ?? "?"}\n`,
      )
      process.exitCode = 1
    }
  }
} finally {
  writeFileSync(file, original)
}
