/**
 * lib/paths.mjs —— 插件里**唯一**的路径来源
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，`tools/` 下 5 个 Python + 12 个 Node 脚本各自写死了
 *   `D:\DeepSeek\dsh-data\douyin-duty` 和 `C:\Program Files\Google\Chrome`。
 *   那是"某台机器上的脚本"，不是插件 —— 换台设备全挂，而且是**静默**挂
 *   （fallback 到别人的 D 盘，报一个莫名其妙的 ENOENT）。
 *
 * 规矩（写死，别再破）：
 *   ① 家目录只认 `DOUYIN_HOME`（宿主 `index.js` 从 `stateDirOf(ctx)` 注入）。
 *      没有就报错退出 —— **绝不**回落到任何写死的盘符。
 *   ② 插件包目录从本文件位置推出来，不写死。
 *   ③ 端口等运行时状态写 `$DOUYIN_HOME/runtime.json`，别的脚本读它，别各自写死。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（lib/ 的上一层） */
export const pluginDir = () => resolve(HERE, '..')

/**
 * 插件家目录 —— **唯一入口**。
 * 顺序：DOUYIN_HOME → DSH_HOME/douyin-duty → ~/.dsh/douyin-duty
 * 全都没有就抛错（不要猜，猜出来的路径一定是错的）。
 */
export function homeDir({ create = true } = {}) {
  const fromEnv = String(process.env.DOUYIN_HOME || '').trim()
  let dir = fromEnv
  if (!dir) {
    const dshHome = String(process.env.DSH_HOME || '').trim()
    dir = join(dshHome || join(homedir(), '.dsh'), 'douyin-duty')
  }
  if (!dir) throw new Error('拿不到插件家目录：请设置环境变量 DOUYIN_HOME')
  dir = resolve(dir)
  if (create) mkdirSync(dir, { recursive: true })
  return dir
}

/** 无头采集器用的 profile —— **必须**是暖的（见下面 loginProfileDir 的说明） */
export const profileDir = () => join(homeDir(), 'chrome-profile')

/**
 * ⭐ 2026-10-25 新增：**「扫码登录」那个有头窗口专用** profile。
 *
 * 起因：以前它和无头采集器共用 profileDir()。同一个 user-data-dir 再拉一次
 * Chromium，Windows 会把新进程**交给已有实例然后自己退出** ⇒ 端口没人监听：
 *   · 有头窗口活着 → 无头卡「无头 Chrome 起来了但 9334 上连不上 CDP（60 秒超时）」
 *   · 无头活着     → 扫码报 `profile_in_use`，永远出不了二维码
 * 两边谁也起不来，而用户看到的是两个毫不相干的报错，根本猜不到是一件事。
 *
 * ⚠️ 反过来把**无头**挪去新 profile —— 我试过，**不行**：抖音对全新 profile 直接
 *    上风控，无头页面标题变成「验证码中间页」，采集器当场哑掉（无头里没法过滑块）。
 *    暖 profile（抖音已经信任它）必须留给采集器，所以搬走的是**登录窗口**。
 *    登录窗口本来就是"当着用户面登录"的地方，profile 冷一点无所谓 —— 真弹验证码，
 *    用户在那个窗口里过一下就行（这正是有头窗口存在的意义）。
 *
 * 名字**故意不含** `chrome-profile`：tools/qr-login.mjs 判断"有没有别的浏览器占着
 * 我这个 profile"用的是 `CommandLine -like '*<profile 目录名>*'`，名字里带别人的
 * 目录名会互相误伤（把无头实例当成占用者、于是又报 `profile_in_use`）。
 */
export const loginProfileDir = () => join(homeDir(), 'login-profile')
export const runtimeFile = () => join(homeDir(), 'runtime.json')
export const configFile = () => join(homeDir(), 'config.json')
export const outDir = () => { const d = join(homeDir(), 'out'); mkdirSync(d, { recursive: true }); return d }
export const cookieFile = () => join(homeDir(), 'douyin_cookie.txt')

/** 读运行时状态（端口等）。读不到给空对象，不抛。 */
export function readRuntime() {
  try { return JSON.parse(readFileSync(runtimeFile(), 'utf8')) || {} } catch { return {} }
}

/** 合并写运行时状态。 */
export function writeRuntime(patch) {
  const next = { ...readRuntime(), ...(patch || {}) }
  try { writeFileSync(runtimeFile(), JSON.stringify(next, null, 2), 'utf8') } catch { /* 写不进去不致命 */ }
  return next
}

/** 有没有登录态（Cookie 文件存在且非空） */
export function hasCookie() {
  const f = cookieFile()
  try { return existsSync(f) && readFileSync(f, 'utf8').trim().length > 0 } catch { return false }
}
