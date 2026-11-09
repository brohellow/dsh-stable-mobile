#!/usr/bin/env node
/**
 * dsh-stable-mobile installer.
 *
 * Why a script instead of `dsh plugin add`:
 *
 *  1. The desktop (Electron) app owns its profile exclusively; the CLI refuses
 *     to touch it ("profile "desktop" is managed exclusively by the Electron
 *     application").
 *  2. `dsh plugin add` only installs the dependency. A package is loaded only
 *     when its name is listed in `dsh.profile.bundles`, so a dependency alone
 *     shows up as "installed but no settings page".
 *  3. Writing package.json from PowerShell on Windows silently adds a UTF-8
 *     BOM, and a BOM makes the harness fail to parse the profile
 *     ("Unexpected token ''"). This script always writes BOM-less UTF-8.
 *
 * Usage:
 *   node scripts/install.mjs --here <plugin-dir> --profile-dir <profile-dir>
 *   node scripts/install.mjs --here <plugin-dir> --profile-dir <profile-dir> --uninstall
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PLUGIN_NAME = 'dsh-stable-mobile'

function parseArgs(argv) {
  const out = { uninstall: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--uninstall') { out.uninstall = true; continue }
    if (token.startsWith('--')) {
      out[token.slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const here = resolve(args.here ?? '.')
const profileDir = args['profile-dir']

if (!profileDir) {
  console.error('缺少 --profile-dir <profile 目录>')
  process.exit(2)
}
if (!existsSync(profileDir)) {
  console.error(`profile 目录不存在: ${profileDir}`)
  process.exit(2)
}

const pkgPath = join(profileDir, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`找不到 ${pkgPath}`)
  process.exit(2)
}

/** Read JSON without letting a stray BOM break the parse. */
function readJson(file) {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/** Always write BOM-less UTF-8 — a BOM breaks the harness profile loader. */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
}

const profile = readJson(pkgPath)
profile.dsh ??= {}
profile.dsh.profile ??= {}
profile.dsh.profile.bundles ??= []
const bundles = profile.dsh.profile.bundles
const already = bundles.includes(PLUGIN_NAME)

// ---------------------------------------------------------------- uninstall
if (args.uninstall) {
  profile.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME)
  writeJson(pkgPath, profile)
  const link = join(profileDir, 'node_modules', PLUGIN_NAME)
  try {
    if (lstatSync(link)) rmSync(link, { recursive: true, force: true })
  } catch {
    /* nothing to remove */
  }
  console.log(`  已从 bundles 移除 ${PLUGIN_NAME}，并删除 node_modules 链接`)
  process.exit(0)
}

// -------------------------------------------------------- 1. link the package
const nodeModules = join(profileDir, 'node_modules')
mkdirSync(nodeModules, { recursive: true })
const target = join(nodeModules, PLUGIN_NAME)

let method = 'link'
try {
  try {
    lstatSync(target)
    rmSync(target, { recursive: true, force: true })
  } catch {
    /* did not exist */
  }
  // A directory junction/symlink keeps edits in place and needs no copy.
  symlinkSync(here, target, process.platform === 'win32' ? 'junction' : 'dir')
} catch (error) {
  console.log(`  目录链接失败（${error.code ?? error.message}），改为复制…`)
  method = 'copy'
  cpSync(here, target, { recursive: true, force: true })
}
console.log(`  [1/3] 已${method === 'link' ? '链接' : '复制'}插件 → ${target}`)

// ------------------------------------------------- 2. register in the bundles
if (already) {
  console.log(`  [2/3] bundles 已包含 ${PLUGIN_NAME}，跳过`)
} else {
  bundles.push(PLUGIN_NAME)
  writeJson(pkgPath, profile)
  const check = readFileSync(pkgPath)
  if (check[0] === 0xef && check[1] === 0xbb && check[2] === 0xbf) {
    console.error('  [错误] 写入后检测到 BOM，正在修正…')
    writeFileSync(pkgPath, check.subarray(3), { encoding: 'utf8' })
  }
  console.log(`  [2/3] 已加入 bundles → ${pkgPath}`)
}

// ------------------------------------------------------------- 3. verify files
const required = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'lib/gateway.js']
let missing = 0
for (const name of required) {
  if (existsSync(join(target, name))) {
    console.log(`  [3/3] OK   ${name}`)
  } else {
    console.log(`  [3/3] 缺失 ${name}`)
    missing += 1
  }
}
if (missing > 0) {
  console.error(`\n安装不完整：缺少 ${missing} 个文件。`)
  process.exit(1)
}

console.log(`\n  安装完成（profile: ${profileDir}）`)
console.log('  请完全退出 DeepSeek Harness 后重新打开。')
