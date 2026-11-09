/**
 * Verify a profile's plugin wiring the same way the harness composes it:
 * every name in dsh.profile.bundles must resolve in node_modules and expose the
 * documented `dsh.bundle.patch` + entry module.
 *
 * Usage: node scripts/verify-install.mjs <profile-dir>
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const profileDir = resolve(process.argv[2] ?? '.')
const pkgPath = join(profileDir, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`找不到 ${pkgPath}`)
  process.exit(2)
}

const raw = readFileSync(pkgPath)
const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
console.log(`package.json BOM: ${hasBom ? '有（会导致加载失败！）' : '无（正常）'}`)

const json = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
const bundles = json?.dsh?.profile?.bundles ?? []
console.log(`bundles 条目数: ${bundles.length}`)

const require = createRequire(join(profileDir, 'package.json'))
let failures = 0

for (const name of bundles) {
  let dir
  try {
    dir = resolve(profileDir, 'node_modules', name)
    if (!existsSync(dir)) {
      // try resolution through package.json exports
      dir = require.resolve(`${name}/package.json`).replace(/[\\/]package\.json$/, '')
    }
  } catch {
    console.log(`  MISSING  ${name}  (无法解析)`)
    failures += 1
    continue
  }

  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) {
    console.log(`  MISSING  ${name}  (没有 package.json)`)
    failures += 1
    continue
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    console.log(`  BAD      ${name}  (package.json 解析失败: ${error.message})`)
    failures += 1
    continue
  }

  const patch = pkg?.dsh?.bundle?.patch
  const main = pkg?.main ?? 'index.js'
  const problems = []
  if (typeof patch !== 'string') problems.push('缺少 dsh.bundle.patch')
  else if (!existsSync(join(dir, patch))) problems.push(`patch 文件不存在: ${patch}`)
  if (!existsSync(join(dir, main))) problems.push(`入口模块不存在: ${main}`)

  if (problems.length === 0) {
    console.log(`  OK       ${name}  v${pkg.version ?? '?'}`)
  } else {
    console.log(`  BROKEN   ${name}  — ${problems.join('; ')}`)
    failures += 1
  }
}

console.log('')
if (hasBom) {
  console.error('失败：package.json 带 BOM，DSH 会解析失败。请重新运行安装器修复。')
  process.exit(1)
}
console.log(failures === 0 ? '全部 bundles 解析正常' : `有 ${failures} 个 bundle 有问题`)
process.exit(failures === 0 ? 0 : 1)
