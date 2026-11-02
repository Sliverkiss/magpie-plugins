#!/usr/bin/env node
// 打印真正的 npm 包名（release.yml 的 npm 步骤用它查重）。
// npm 名与 package.json.name 是两件事：后者是仓库内的 slug；
// 若发布脚本里注入了 PUBLISH_AS，npm 名以它为准（与 check.mjs 同一查找顺序）。

import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
let name = pkg.name
try {
  const src = readFileSync(new URL("./publish-npm.mjs", import.meta.url), "utf8")
  const m = src.match(/PUBLISH_AS\s*=\s*["']([^"']+)["']/) ?? src.match(/pkg\.name\s*=\s*["']([^"']+)["']/)
  if (m) name = m[1]
} catch {}
process.stdout.write(name)
