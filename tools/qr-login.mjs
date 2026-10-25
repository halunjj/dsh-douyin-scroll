#!/usr/bin/env node
/**
 * tools/qr-login.mjs —— 抖音扫码登录（唯一允许开浏览器的场景）
 * ============================================================================
 * 子命令：
 *   start   启动一个**独立 profile 的有头 Chrome**，打开抖音、点开登录弹层，
 *           把二维码截成 PNG 存到家目录，并把窗口置顶。
 *   shot    再截一次屏（用户说看不到二维码时用）
 *   check   通过 CDP 读 cookie：有 sessionid 就导出 douyin_cookie.txt 并校验账号
 *   close   关掉这个 Chrome
 *   watch   轮询直到扫码成功（面板"我扫完了"按钮用）——
 *           每 2 秒 check 一次，成功/超时/卡在验证 都返回结构化 JSON
 *
 * 关键设计：
 *   - profile 固定放在 $DOUYIN_HOME/login-profile（**自己的**，不跟无头共用）
 *     反复登录复用同一个 profile ⇒ 设备指纹稳定 ⇒ 少一道风控
 *   - 登录成功后**保留**这个 profile，以后 `check` 还能从里面读到 cookie
 *   - 全程只用 CDP，不依赖 bb-browser（那玩意儿会吃引号）
 *
 * 🔴 2026-10-22 新增：**profile 互斥**
 *   登录用的 Chrome（有头）和干活用的 Chrome（无头）原来用的是**同一个 user-data-dir**。
 *   Chrome 不允许同一个 profile 起两个实例 ⇒ 后台无头浏览器还开着时，`start` 会
 *   起不来（新进程直接退出），而老代码只会傻等 60 秒再报"连不上 CDP"。
 *   起之前先检测：被占用就明确告诉你「先关掉后台那个」，并给出关闭方法。
 *
 * 🔴🔴 2026-10-25 更正：上面那条"互斥"是**症状**，根因是共用一个 profile 这件事本身。
 *   现在两边**各用各的**（本文件用 loginProfileDir()，无头继续用暖的 chrome-profile），
 *   所以可以同时活着、谁也不占谁。⚠️ 注意方向：搬到新 profile 的是**登录窗口** ——
 *   反过来给无头换新 profile 试过，抖音对全新 profile 直接上风控（页面变
 *   「验证码中间页」），采集器当场哑掉，而无头里没人能过滑块。
 *   下面所有进程匹配（MARK）都跟着 basename(PROFILE) 走，自动只认自己这个 profile，
 *   不会再误伤无头实例。
 * ============================================================================
 */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homeDir, loginProfileDir } from '../lib/paths.mjs'
import { findBrowser } from '../lib/chrome.mjs'

const HOME = homeDir()
/**
 * ⭐ 2026-10-25：登录窗口用自己的 profile（原来的 chrome-profile 留给无头采集器）。
 *    共用一个 user-data-dir 时，第二个浏览器进程会被已有实例接管然后自己退出 ⇒
 *    端口没人监听：登录窗报「登录用的浏览器还没开」，无头报「9334 上连不上 CDP」。
 *    ⚠️ 搬的必须是**登录窗口**：无头换新 profile 会被抖音风控（「验证码中间页」）。
 */
const PROFILE = loginProfileDir()
/**
 * ⭐ 端口不再写死 9333：那会和"别的东西恰好占了 9333"冲突，而且 9333 不在
 *    lib/chrome.mjs 的扫描范围（9334–9373）里，两个模块各扫各的，谁也不认识谁。
 *    现在统一从 9374 往上找（避开无头那一段），或者用 QR_CDP_PORT 指定。
 */
let PORT = Number(process.env.QR_CDP_PORT || 0)
const cdpUrl = () => `http://127.0.0.1:${PORT}`

// 扫码登录用**有头** Chrome，所以不走 lib/chrome.mjs 的 headless 流程，
// 但"找浏览器"这件事必须共用同一套探测逻辑（换台机器 Chrome 装在别处也能用）。
const CHROME = findBrowser()

/**
 * 🔴 2026-10-25 修：下面三个进程探测原来把进程名**写死成 `chrome.exe`**。
 *    findBrowser() 在这台机器上选的是 **msedge.exe**，于是：
 *      profileInUse() 永远返回空 ⇒ 脚本以为 profile 没人占 ⇒
 *      findFreePort() 看到上一个登录窗口占着 9374 就换 9375 ⇒
 *      同一个 user-data-dir 再起一个 Edge ⇒ Edge 直接交给已有实例、新进程退出 ⇒
 *      9375 永远没人监听 ⇒ 报「登录用的浏览器还没开」（面板上的「扫码登录」按钮同样死在这里）。
 *    现在进程名跟着实际浏览器走，并且**复用已经开着的登录窗口**。
 */
const PROC_EXE = CHROME ? basename(CHROME) : 'chrome.exe'          // msedge.exe / chrome.exe
const PROC_NAME = PROC_EXE.replace(/\.exe$/i, '')                  // Get-Process 用
const PROC_FILTER = `Name='${PROC_EXE}'`
const MARK = basename(PROFILE)                                     // 'login-profile'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ─────────── 注入到页面里的小工具（登录入口 / 人机验证） ─────────── */

/**
 * ⭐ 2026-10-25：两个实测逼出来的修正。
 *
 * ① 登录入口要**穿透 shadow DOM** 找。
 *    以前只扫 light DOM（`document.querySelectorAll`），抖音哪天把「登录」塞进
 *    web component（shadow root）里就永远点不到 —— 报 no-login-button，
 *    而用户盯着窗口里明晃晃的登录按钮，只会觉得插件坏了。
 *
 * ② 抖音现在会先甩一堵**全屏人机验证墙**（iframe 指向
 *    rmc.bytedance.com/verifycenter/captcha，标题「验证码中间页」）。
 *    ⚠️ 关键：它在 **iframe** 里，`document.body.innerText` **看不见 iframe 内容**
 *    ⇒ 代码里所有靠中文关键词（拖动/滑块/验证码）的判断都识别不到它。
 *    结果：用户扫不了码、也不知道卡在哪，只看到「登录框没出来」。
 *    信号只能从 iframe 的 src 和页面标题上取。
 */
const PAGE_PROBE = `(function(){
  var out = { url: location.href, title: document.title || '', captcha: false, login: 0, avatar: false, text: '' };
  var ifr = Array.prototype.slice.call(document.querySelectorAll('iframe'));
  out.captcha = ifr.some(function(f){ return /verifycenter\\/captcha|rmc\\.bytedance\\.com|verify\\.zijieapi\\.com/.test(String(f.src || '')) })
    || /验证码中间页|请完成验证|安全验证/.test(out.title);
  var want = ['登录', '立即登录', '登录/注册'];
  var walk = function(root, depth){
    if (depth > 6) return;
    var els; try { els = root.querySelectorAll('div,span,button,a,p,section') } catch (e) { return }
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var t = (e.innerText || '').replace(/\\s+/g, '').trim();
      if (t && t.length <= 8 && want.indexOf(t) >= 0 && e.offsetParent !== null) out.login++;
      if (e.shadowRoot) walk(e.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  out.avatar = !!document.querySelector('img[src*="aweme-avatar"], [class*="avatar"]');
  var t = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
  out.text = t.slice(0, 200);
  out.qrText = t.indexOf('扫码登录') >= 0;   // 只作诊断，不参与判定
  /*
   * 🔴 2026-10-25 判定收紧（两轮实测逼出来的）：
   *    · 不能拿整页文字匹配「扫一扫」—— 抖音首页推广文案里就有，会假报"二维码已出"；
   *    · 也不能只看"有没有手机号输入框 / 有没有含扫码登录的小容器"—— 首页上存在
   *      **不可见**的这类节点，于是又假报一次（冷启动实测：报 panel_ready:true、
   *      截了张 1.7MB 的首页图，弹层其实没开）。
   *    真正的判据：**可见的**弹层容器（role=dialog / class 含 login|modal|dialog），
   *    里面有「扫码登录」，并且带二维码元素（canvas / img / input）。
   */
  var modals = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[class*="login"],[class*="modal"],[class*="dialog"]'))
    .filter(function(e){ return e.offsetParent !== null && (e.innerText || '').indexOf('扫码登录') >= 0 });
  modals.sort(function(a, b){ return (a.innerText || '').length - (b.innerText || '').length });
  var modal = modals[0];
  out.qrBox = modal ? {
    cls: String(modal.className || '').slice(0, 50),
    len: (modal.innerText || '').length,
    canvas: modal.querySelectorAll('canvas').length,
    img: modal.querySelectorAll('img').length,
    input: modal.querySelectorAll('input').length,
  } : null;
  out.phone = !!document.querySelector('input[placeholder*="手机号"]');   // 只作诊断
  out.dialogs = document.querySelectorAll('[role="dialog"],[class*="modal"],[class*="dialog"]').length;
  out.canvas = document.querySelectorAll('canvas').length;
  out.layerOpen = !!out.qrBox && out.qrBox.len <= 600
    && (out.qrBox.canvas > 0 || out.qrBox.img > 0 || out.qrBox.input > 0);
  return JSON.stringify(out);
})()`

/**
 * 找登录入口，返回**中心坐标**（不点）—— 因为必须由 Node 侧派真鼠标事件。
 * 按面积从小到大排：越小的元素越可能是那个真按钮（外面套着 div/span 好几层）。
 */
const FIND_LOGIN = `(function(){
  var want = ['登录', '立即登录', '登录/注册'];
  var out = [];
  var walk = function(root, depth){
    if (depth > 6) return;
    var els; try { els = root.querySelectorAll('div,span,button,a,p,section') } catch (e) { return }
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.shadowRoot) walk(e.shadowRoot, depth + 1);
      var t = (e.innerText || '').replace(/\\s+/g, '').trim();
      if (want.indexOf(t) < 0 || e.offsetParent === null) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.x < 0 || r.y < 0 || r.x > innerWidth - 2 || r.y > innerHeight - 2) continue;
      out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: Math.round(r.width * r.height), tag: e.tagName, cls: String(e.className || '').slice(0, 40) });
    }
  };
  walk(document, 0);
  out.sort(function(a, b){ return a.area - b.area });
  return JSON.stringify({ cands: out.slice(0, 4) });
})()`

/**
 * ⭐⭐ 2026-10-25：点登录入口必须用**真鼠标事件**，不能用 `el.click()`。
 *    实测（抖音 2026-10 版）：`el.click()` 是合成事件，抖音的处理器**不认**它 ——
 *    日志会说 `登录按钮: clicked`，但页面上什么都不发生（老代码"点了却没二维码"
 *    就是这么来的）。换成 CDP 的 Input.dispatchMouseEvent（按下 + 抬起），
 *    打在那个坐标上，弹层和二维码立刻就出来了。
 */
async function realClick(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 找一个空闲端口（避开无头用的 9334–9373） */
async function findFreePort() {
  const { createServer } = await import('node:net')
  const free = (p) => new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(false))
    s.once('listening', () => s.close(() => res(true)))
    s.listen(p, '127.0.0.1')
  })
  for (let p = 9374; p < 9414; p++) if (await free(p)) return p
  throw new Error('9374–9413 全被占用了，找不到登录用的调试端口（可以用 QR_CDP_PORT 指定一个）')
}

/** 有没有别的浏览器正在用我们这个 profile？ */
function profileInUse() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "${PROC_FILTER}" | ` +
      `Where-Object { $_.CommandLine -like '*${MARK}*' } | ` +
      `Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', timeout: 15000 })
    return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

/** 关掉占着 profile 的浏览器（只在用户明确要求时用） */
function closeProfileChrome() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "${PROC_FILTER}" | ` +
      `Where-Object { $_.CommandLine -like '*${MARK}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { encoding: 'utf8', timeout: 20000 })
    return true
  } catch { return false }
}

/**
 * 把登录窗口顶到最前面。
 * ⭐ 用户可能正开着别的窗口（甚至全屏），不置顶的话他不知道去哪儿扫码。
 * ⭐ 只看**用我们这个 profile 的**那些进程：以前是 `Get-Process chrome`，
 *    会把用户平时那个浏览器窗口也拉上来（浏览器是 Edge 时更荒唐，连名字都不对）。
 *    返回 'front <pid>' 或 'no-window'（不抛）。
 */
function frontWindow() {
  try {
    return String(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$ids = @(Get-CimInstance Win32_Process -Filter "${PROC_FILTER}" | ` +
      `Where-Object { $_.CommandLine -like '*${MARK}*' } | Select-Object -ExpandProperty ProcessId); ` +
      `$p = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
      `if($p){ $ws = New-Object -ComObject WScript.Shell; [void]$ws.AppActivate($p.Id); Write-Output ('front ' + $p.Id) } else { Write-Output 'no-window' }`],
      { encoding: 'utf8', timeout: 20000 })).trim()
  } catch { return 'no-window' }
}

async function cdpTargets(waitMs = 30000) {
  const tries = Math.max(1, Math.round(waitMs / 500))
  for (let i = 0; i < tries; i++) {
    if (!PORT) { await sleep(500); continue }
    try {
      const r = await fetch(`${cdpUrl()}/json/list`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  // ⭐ 这里不是「出错了」，是「你还没开始登录」—— 别甩一个端口号给用户看
  throw new Error(
    '登录用的浏览器还没开。\n'
    + '  → 设置页点「扫码登录」，或命令行跑：node tools/qr-login.mjs start\n'
    + '  → 扫完码如果抖音还要验证（短信 / 滑块），在**那个弹出的浏览器窗口里**做完\n'
    + '  → 然后再点一次「我扫完了」（或跑 node tools/qr-login.mjs check）',
  )
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    })
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
    /**
     * ⭐ 2026-10-25 补上：这个 `ev` 以前**根本不存在**（本文件自己那份连接器只有 send/close）。
     *    而下面 20 秒轮询弹层、doCheck 里识别"卡在短信/滑块/新设备"**全都在调 `c.ev(...)`** ——
     *    全是 TypeError，又都被 try/catch 吞掉 ⇒ 那些探测**一直是静默死掉的**：
     *      · 弹层明明开了也永远报 panel_ready:false、不截图（用户以为没打开）
     *      · 扫完码卡在验证页也永远探测不到（用户只看到"还没扫"）
     *    现在它真的会求值。页面里抛错就抛出来（调用方自己决定要不要继续等）。
     */
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r && r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 200))
      return r && r.result ? r.result.value : undefined
    }
    ws.addEventListener('open', () => resolve({
      send, ev,
      close: () => ws.close(),
    }))
    ws.addEventListener('error', reject)
  })
}

async function pageConn() {
  const targets = await cdpTargets()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('douyin'))
    || targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page target')
  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  return c
}

async function shoot(tag = 'login-qr') {
  const c = await pageConn()
  const b64 = (await c.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })).data
  const f = join(HOME, `${tag}.png`)
  writeFileSync(f, Buffer.from(b64, 'base64'))
  c.close()
  return f
}

const cmd = process.argv[2] || 'start'

async function runStart() {
  if (!CHROME) {
    console.log(JSON.stringify({ ok: false, error: '找不到 Chrome / Edge / Chromium', hint: '装一个浏览器；装特殊位置就把完整路径写进环境变量 DOUYIN_BROWSER' }, null, 2))
    return
  }

  // ⭐ 先看看这个 profile 是不是已经有人占着
  const busy = profileInUse()
  // ⭐ 已经开着的**可见**登录窗口：用现成的 discoverQrPort() 把端口找回来复用
  //    （它先看 runtime.json 里记的，再扫 9374–9413；那段端口天然避开后台无头的
  //     9334–9373，所以不会连到一个没有窗口的浏览器上）。
  //    不加这一步的话：findFreePort() 会挑一个没人监听的端口，然后同一个 profile
  //    起第二个浏览器（新进程立刻交给老实例并退出），现象就是
  //    「登录用的浏览器还没开」—— 面板点多少次都一样。
  let alreadyOpen = false
  if (!PORT) PORT = await discoverQrPort()
  if (busy.length) {
    // 已经有登录窗口开着（端口能连上）⇒ 直接复用，把窗口顶到前面
    let alive = await loginBrowserUp()
    if (alive) {
      // ⭐ 复用：不另起浏览器，但**继续往下走** —— 该点的「登录」还点，
      //    该截的二维码还截。老代码这里直接 return，用户看到的还是上一次那个
      //    不知道停在哪一页的窗口（2026-10-25 实测就是停在一个滑块验证页上）。
      alreadyOpen = true
      frontWindow()
      // ⭐ 这条只是"我复用了"的诊断信息，**别打到 stdout**：
      //    stdout 后面还会有一条结果 JSON，两段 JSON 连在一起会让宿主那边的
      //    pickJson 解析失败（老实现「第一个 { 到最后一个 }」必炸）⇒ 面板报
      //    「出二维码失败」。诊断走 stderr，stdout 只留一个结果对象。
      console.error('reused ' + PORT + ' pids=' + busy.join(','))
    } else {
      // 占着的是**后台无头**那个 ⇒ 让用户选：关掉它扫码，还是先不扫
      console.log(JSON.stringify({
        ok: false,
        conflict: 'profile_in_use',
        pids: busy,
        error: '后台的无头浏览器占着这个浏览器配置，扫码窗口开不起来（同一个配置不能开两个）',
        hint: '点「先关掉后台浏览器，再出二维码」——关掉的是插件自己在后台跑的那个，不影响你平时用的浏览器',
        can_kill: true,
      }, null, 2))
      return
    }
  }

  if (!alreadyOpen) {
    PORT = PORT || await findFreePort()
    mkdirSync(PROFILE, { recursive: true })
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1280,900',
      '--window-position=120,60',
      'https://www.douyin.com/',
    ]
    const p = spawn(CHROME, args, { detached: true, stdio: 'ignore' })
    p.unref()
    console.log('chrome pid =', p.pid, '\nprofile =', PROFILE)
  }

  const c = await pageConn()
  await sleep(3500)

  /**
   * 🔴 判断"已经登录了吗"**不能用 `document.cookie`**：
   *    `sessionid` 是 HttpOnly，页面 JS 永远读不到它 ⇒ 永远判成"没登录"。
   *    （2026-10-22 实测：明明头像都在，却报 no-login-button，还截了张首页图）
   *    必须用 CDP 的 `Network.getAllCookies` —— 那是浏览器层面，能看到 HttpOnly。
   */
  let alreadyLoggedIn = false
  try {
    const { cookies } = await c.send('Network.getAllCookies')
    const names = cookies.map((x) => x.name)
    alreadyLoggedIn = names.includes('sessionid') || names.includes('sessionid_ss')
  } catch { alreadyLoggedIn = false }

  // 先看一眼页面：是卡在人机验证上、有没有登录入口、还是已经登录了
  const p0 = JSON.parse((await c.ev(PAGE_PROBE).catch(() => '{}')) || '{}')
  const loginState = p0.login ? 'has-login-entry' : (p0.avatar ? 'looks-logged-in' : 'no-login-button')
  console.log('页面:', String(p0.url || '').slice(0, 60), '/ 标题:', String(p0.title || '').slice(0, 30),
    '/ 登录入口:', p0.login, '个 / 人机验证:', p0.captcha ? '有（要用户自己过）' : '无',
    '/ 已有 sessionid:', alreadyLoggedIn)

  /**
   * ⭐ 2026-10-22 实测踩到：这个 Chrome profile 里**早就登录过了**（复用过很多次）。
   *    这时页面上根本没有「登录」按钮，也就没有二维码 —— 老代码会截一张首页截图当二维码给用户，
   *    用户看到一堆视频封面，完全不知道发生了什么。
   *    ⇒ 已经登录就**直接导出 Cookie**，别走二维码这条路。
   */
  if (alreadyLoggedIn) {
    const out = await doCheck()
    c.close()
    // 记端口（万一后面还要 check）
    saveQrPort()
    console.log(JSON.stringify({
      ok: true,
      already_logged_in: true,
      qr: '',
      ...out,
      hint: '这个浏览器里**已经登录过了**，不用扫码 —— 我直接把登录凭证导出来了，你现在就能用',
    }, null, 2))
    return
  }

  /**
   * 等登录弹层展开完。
   * ⭐ 2026-10-22 实测：抖音这个弹层是**异步渲染**的，而且慢（4 秒经常还不够）。
   *    太早点会点空、太早探测会得到 panel_ready=false，让用户以为没打开。
   *    ⇒ 轮询，看到「扫码登录 / 请输入手机号」就算好了。
   * ⭐ 2026-10-25：抖音要是先甩了**人机验证墙**，就得给用户时间自己过 ——
   *    验证在 iframe 里，我们代劳不了（也不该代劳）。所以这种情况多等一会儿，
   *    等验证墙消失后再补点一次登录入口。
   */
  let layerOk = p0.layerOpen
  let captcha = !!p0.captcha
  let diag = { url: p0.url, title: p0.title, login_nodes: p0.login, avatar: !!p0.avatar }
  let clicked = 'none'

  /**
   * ⭐⭐ 2026-10-25：开弹层要用**真鼠标事件**（realClick），不能用 el.click()。
   *    候选按面积从小到大试（最里面那个才是真按钮），每个都验证弹层到底开没开 ——
   *    所以就算抖音明天换个入口位置，这里也是"试到开为止"，不是写死一个选择器。
   */
  if (!layerOk && !captcha && p0.login) {
    const found = JSON.parse((await c.ev(FIND_LOGIN).catch(() => '{}')) || '{}')
    for (const cand of (found.cands || []).slice(0, 4)) {
      clicked = `real-click ${cand.tag}@${cand.x},${cand.y}`
      await realClick(c, cand.x, cand.y)
      await sleep(2500)
      const p = JSON.parse((await c.ev(PAGE_PROBE).catch(() => '{}')) || '{}')
      diag = { url: p.url, title: p.title, login_nodes: p.login, avatar: !!p.avatar, qr_box: p.qrBox || null, phone: !!p.phone }
      if (p.captcha) { captcha = true; break }
      if (p.layerOpen) { layerOk = true; break }
    }
  }

  const tries = captcha ? 55 : 20
  for (let i = 0; i < tries && !layerOk; i++) {
    await sleep(1000)
    try {
      const p = JSON.parse((await c.ev(PAGE_PROBE)) || '{}')
      diag = { url: p.url, title: p.title, login_nodes: p.login, avatar: !!p.avatar, qr_box: p.qrBox || null, phone: !!p.phone }
      const wasCaptcha = captcha
      if (p.captcha) captcha = true
      // 补点一次：① 第一次可能点空/弹层还没渲染好；② 刚过完人机验证那一下
      if (!p.layerOpen && p.login && (i === 5 || (wasCaptcha && !p.captcha))) {
        const found = JSON.parse((await c.ev(FIND_LOGIN).catch(() => '{}')) || '{}')
        const cand = (found.cands || [])[0]
        if (cand) { await realClick(c, cand.x, cand.y); clicked = `real-click ${cand.tag}@${cand.x},${cand.y}` }
      }
      if (p.layerOpen) layerOk = true
    } catch { /* 读不到页面就继续等 */ }
  }
  console.log('登录入口:', clicked, '/ 弹层:', layerOk ? '开了 ✓' : '没开')

  /**
   * ⭐⭐ 2026-10-25：**必须在这里截图**。
   *    面板那张二维码是 `<img src="/api/douyin-duty/login/qr.png">`，而那个文件只有截了才有；
   *    以前 `start` 从头到尾没调过 shoot() ⇒ 就算弹层开对了，面板也永远是「还没有二维码」，
   *    或者显示上一次留下的陈旧图。现在弹层一开就截。
   */
  let qrFile = ''
  try { if (layerOk) qrFile = await shoot('login-qr') } catch { /* 截图失败不致命，别把整个流程弄挂 */ }
  c.close()

  // 把登录窗口顶到最前面（用户可能在别的窗口里）
  const front = frontWindow()

  // ⭐ 把端口记进 runtime.json —— 否则下一步 check 不知道去哪连（两个是独立进程）
  saveQrPort()

  console.log(JSON.stringify({
    ok: true,
    port: PORT,
    window: front,
    login_button: loginState,
    clicked,
    panel_ready: layerOk,
    captcha,
    qr: qrFile,
    diag,
    hint: layerOk
      ? '窗口开着、登录框和二维码都出来了 —— 用手机抖音扫那个窗口里的二维码。扫完如果还要短信验证码/滑块，就在那个窗口里做完，回来点「我扫完了」'
      : captcha
        ? '抖音先给你弹了**人机验证**（滑块/点选图片），这一步只能人来过：切到刚打开的那个浏览器窗口把验证做掉 —— 过了它自己就会显示登录入口和二维码，然后回来点「我扫完了」'
        : diag.login_nodes === 0 && !diag.avatar
          ? '窗口开了，但这个页面上连「登录」入口都没有（抖音改版了，或者页面还没渲染完）。切到那个窗口刷新一下、再点一次「扫码登录」；还不行就把窗口截图发我'
          : '窗口已经打开了，但登录框没弹出来。我在那个窗口里替你点过右上角「登录」了 —— 你也可以自己点一下试试；实在不行回来点「关掉后台浏览器重试」再点「扫码登录」',
  }, null, 2))
}

/** 登录用的浏览器开着吗？（没开就给一句人话，别抛栈） */
async function loginBrowserUp() {
  if (!PORT) return false
  try { return (await fetch(`${cdpUrl()}/json/list`)).ok } catch { return false }
}

/**
 * 记住上次 `start` 用的端口 —— 不然 `check` 不知道去哪连
 * （PORT 每次进程重启都会重新算，跑 start 和 check 是两个独立进程）
 */
const RUNTIME_FILE = join(HOME, 'runtime.json')
function saveQrPort() {
  try {
    let cur = {}
    try { cur = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) || {} } catch { cur = {} }
    writeFileSync(RUNTIME_FILE, JSON.stringify({ ...cur, qrPort: PORT }, null, 2), 'utf8')
  } catch { /* 写不进去就每次重新找 */ }
}
function loadQrPort() {
  try {
    const cur = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) || {}
    return Number(cur.qrPort || 0)
  } catch { return 0 }
}

/**
 * ⭐ 自动找回登录端口：先试记住的，再扫 9374–9413。
 *    这样 `check` / `shot` / `watch` 都不用用户传端口。
 */
async function discoverQrPort() {
  const remembered = loadQrPort()
  if (remembered) {
    try { if ((await fetch(`http://127.0.0.1:${remembered}/json/version`)).ok) return remembered } catch { /* 继续扫 */ }
  }
  for (let p = 9374; p < 9414; p++) {
    try { if ((await fetch(`http://127.0.0.1:${p}/json/version`)).ok) return p } catch { /* 下一个 */ }
  }
  return 0
}

const NOT_UP_MSG = [
  '登录用的浏览器还没开。',
  '  → 设置页点「扫码登录」，或命令行跑：node tools/qr-login.mjs start',
  '  → 扫完码如果抖音还要验证（短信 / 滑块），在**那个弹出的浏览器窗口里**做完',
  '  → 然后再点一次「我扫完了」（或跑 node tools/qr-login.mjs check）',
].join('\n')

/** check 的核心（被 check 和 watch 共用）：返回结构化结果，不直接打印 */
async function doCheck() {
  const c = await pageConn()
  try {
    const { cookies } = await c.send('Network.getAllCookies')
    const names = cookies.map((x) => x.name)
    const key = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'passport_csrf_token', 'ttwid', 'msToken', 's_v_web_id']
    const hasSession = names.includes('sessionid') || names.includes('sessionid_ss')

    /**
     * ⭐ 扫完码之后抖音**可能还要过一道验证**（短信验证码 / 滑块 / 「换设备登录」确认）。
     *    以前这里只看 cookie：没过验证就永远读不到 sessionid，用户只看到「还没扫」，
     *    其实他已经扫了、卡在验证页 —— 白白重扫好几次。
     *    现在先看页面上有没有验证类元素，有就明确告诉他「你卡在这一步」。
     */
    let verifyKinds = []
    let pageHead = ''
    let onPhoneWait = false
    try {
      const probe = await c.ev(`(function(){
        var vis = function(e){ return e && e.offsetParent !== null };
        var t = (document.body && document.body.innerText || '').replace(/\\s+/g,' ');
        // ⚠️ 全屏人机验证在 **iframe** 里，innerText 看不见它 —— 只能看 iframe 的 src 和标题。
        var wall = Array.prototype.slice.call(document.querySelectorAll('iframe')).some(function(f){
          return /verifycenter\\/captcha|rmc\\.bytedance\\.com|verify\\.zijieapi\\.com/.test(String(f.src || ''));
        }) || /验证码中间页|请完成验证/.test(document.title || '');
        /*
         * 🔴 2026-10-25 修误报：**登录弹层自己的文案不算验证**。
         *    扫码框里本来就有「验证码登录 / 获取验证码 / 请输入验证码」这几个字，
         *    而且那两个输入框 offsetParent 也不为 null ⇒ 老逻辑在"扫完码、等手机确认"
         *    这一步会一本正经地报「卡在 短信验证码 / 滑块 / 新设备确认」，
         *    用户照它去短信页等一条永远不会来的短信（实测就是这个坑）。
         *    ⇒ 只认**可见**且**不在登录弹层里**的元素，并按更准的信号优先。
         */
        var modal = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[class*="login"],[class*="modal"]'))
          .filter(function(e){ return vis(e) && (e.innerText || '').indexOf('扫码登录') >= 0 });
        modal.sort(function(a, b){ return (a.innerText || '').length - (b.innerText || '').length });
        var modalText = modal.length ? (modal[0].innerText || '').replace(/\\s+/g, ' ') : '';
        /*
         * ⚠️ 别只按"第一个匹配到的弹层容器"算包含关系 —— 抖音的弹层是好几层嵌套，
         *    第一个匹配到的往往是内层 div，结果「获取验证码」这类文案就漏出来了
         *    （实测第一次改完仍然误报"短信验证码"）。按**祖先链的 class/id** 判最稳。
         */
        var inModal = function(e){
          for (var p = e; p && p !== document.body; p = p.parentElement) {
            var sig = String(p.className || '') + ' ' + String(p.id || '');
            if (/login|modal|dialog|captcha/i.test(sig)) return true;
            if (p.getAttribute && p.getAttribute('role') === 'dialog') return true;
          }
          return false;
        };
        var hitVis = function(k){
          var els = Array.prototype.slice.call(document.querySelectorAll('div,span,p,button,label'));
          for (var i = 0; i < els.length; i++) {
            var e = els[i];
            if (!vis(e) || inModal(e)) continue;
            if ((e.innerText || '').indexOf(k) >= 0) return true;
          }
          return false;
        };
        // 扫到了、正在等手机上点「确认登录」——这是最常见的一步，单独认出来
        var onPhone = modalText.indexOf('需在手机上进行确认') >= 0 || modalText.indexOf('手机上确认') >= 0;
        /*
         * ⭐ 总开关：**只要扫码弹层还在**，页面上那些「验证码 / 获取验证码」字样就一定是
         *    它自己的（手机号登录那个 tab）。抖音真到短信验证那一步时，弹层里就**不再有
         *    「扫码登录」**了 ⇒ modal 为空、这里的排除自动失效，照样能报出来。
         *    （实测：光靠"排除弹层子树"排不干净 —— 抖音的弹层有好几层嵌套/门户节点。）
         */
        var qrPanel = modal.length > 0;
        var sms = !qrPanel && (hitVis('获取验证码') || hitVis('短信验证') || hitVis('后四位'));
        var slide = wall || (!qrPanel && (hitVis('拖动') || hitVis('滑块') || hitVis('请完成下方验证') || hitVis('安全验证')));
        var device = !qrPanel && (hitVis('新设备') || hitVis('换设备') || hitVis('设备验证'));
        var needPhone = !qrPanel && hitVis('绑定手机');
        var kinds = [];
        if (wall) kinds.push('人机验证（全屏验证码，得在那个窗口里过一下）');
        if (sms) kinds.push('短信验证码');
        if (slide && !wall) kinds.push('滑块/拼图');
        if (device) kinds.push('新设备确认');
        if (needPhone) kinds.push('绑定手机号');
        return JSON.stringify({ kinds: kinds, head: t.slice(0, 220), captcha: wall, onPhone: onPhone, modal: modalText.slice(0, 120) });
      })()`)
      const p = JSON.parse(probe || '{}')
      verifyKinds = p.kinds || []
      pageHead = p.head || ''
      onPhoneWait = !!p.onPhone
    } catch { /* 读不到页面就跳过，不影响 cookie 判定 */ }

    if (!hasSession) {
      return {
        ok: false, logged_in: false,
        cookie_count: cookies.length,
        important: key.filter((k) => names.includes(k)),
        verify: verifyKinds,
        on_phone: onPhoneWait,
        page_head: pageHead,
        hint: onPhoneWait
          ? '二维码扫到了 ✓ —— 抖音正在等你**在手机上点「确认登录」**。点了之后不用重扫，回来再点一次「我扫完了」就行'
          : verifyKinds.length
            ? `二维码已经扫过了，但抖音还要你在那个浏览器窗口里完成：${verifyKinds.join(' / ')}。做完不用重扫，再点一次「我扫完了」就行`
            : '还没有 sessionid —— 二维码还没扫，或扫了但手机上还没点「确认登录」',
      }
    }

    const dom = cookies.filter((x) => x.domain.includes('douyin'))
    const str = dom.map((x) => `${x.name}=${x.value}`).join('; ')
    const f = join(HOME, 'douyin_cookie.txt')
    writeFileSync(f, str, 'utf8')
    return {
      ok: true, logged_in: true,
      file: f, chars: str.length, cookies: dom.length,
      verify: verifyKinds,
      hint: `登录成功，凭证已保存（${dom.length} 条 Cookie）。${verifyKinds.length ? '（页面上还挂着验证提示，但登录态已经拿到了）' : ''}`,
    }
  } finally { c.close() }
}


if (cmd === 'start') await runStart()
if (cmd === 'shot') {
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) { console.log(NOT_UP_MSG); process.exitCode = 2 }
  const f = await shoot('login-qr')
  console.log(JSON.stringify({ ok: true, qr: f }, null, 2))
}

if (cmd === 'check') {
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) {
    console.log(JSON.stringify({ ok: false, up: false, error: '登录用的浏览器还没开', hint: NOT_UP_MSG }, null, 2))
    process.exitCode = 2
  }
  const r = await doCheck()
  console.log(JSON.stringify({ ...r, up: true, port: PORT }, null, 2))
  process.exitCode = r.ok ? 0 : 2
}

/**
 * ⭐ `watch` —— 面板上「我扫完了」按钮用的：轮询直到扫码成功
 *    每 2 秒查一次，最多等 N 秒（默认 120）。
 *    输出**一行一个 JSON 状态**，最后一行是终态 —— 面板边跑边读。
 */
if (cmd === 'watch') {
  const maxSec = Math.max(10, Math.min(Number(process.argv[3] || process.env.QR_WATCH_SEC || 120), 600))
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) {
    console.log(JSON.stringify({ ok: false, up: false, error: '登录用的浏览器还没开', hint: NOT_UP_MSG }, null, 2))
    process.exitCode = 2
  }
  const deadline = Date.now() + maxSec * 1000
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await doCheck()
      if (last.ok) {
        console.log(JSON.stringify({ ...last, up: true, waited_s: Math.round((maxSec * 1000 - (deadline - Date.now())) / 1000) }, null, 2))
        process.exitCode = 0
        break
      }
      console.log(JSON.stringify({ ok: false, pending: true, verify: last.verify, hint: last.hint }, null, 2))
    } catch (e) {
      console.log(JSON.stringify({ ok: false, pending: true, error: String(e?.message ?? e) }, null, 2))
    }
    await sleep(2000)
  }
  if (!last || !last.ok) {
    console.log(JSON.stringify({
      ok: false, timeout: true,
      verify: last?.verify || [],
      hint: last?.verify?.length
        ? `等了 ${maxSec} 秒还是卡在验证（${last.verify.join(' / ')}）——在那个浏览器窗口里做完，再点一次`
        : `等了 ${maxSec} 秒还没扫上 —— 二维码可能过期了，点「重新出二维码」再来一次`,
    }, null, 2))
    process.exitCode = 2
  }
}

if (cmd === 'close') {
  // ⭐ 这里原先又写了一遍 `Name='chrome.exe'`（第四处）——
  //    面板「先关掉后台浏览器，再出二维码」和 /login/qr?force=1 都走这条路，
  //    浏览器是 Edge 时它杀不掉任何东西 ⇒ 无头浏览器一直占着 profile ⇒
  //    「扫码登录」永远返回 profile_in_use，用户点多少次都出不来二维码。
  //    统一走 closeProfileChrome()（进程名跟着 findBrowser()）。
  const ok = closeProfileChrome()
  // 顺手把"记住的登录端口"作废，免得 discoverQrPort() 去连一个已经关掉的窗口
  PORT = 0
  saveQrPort()
  console.log(JSON.stringify({ ok, closed: ok }, null, 2))
  if (!ok) process.exitCode = 2
}

