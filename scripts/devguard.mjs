#!/usr/bin/env node
/**
 * devguard —— 开发环境端口自检
 *
 * ## 它解决什么
 *
 * 同一台机器上并行跑多个全栈项目时，端口撞车是必然的。真正麻烦的不是"撞车"
 * 本身，而是**症状和病因隔得太远**：
 *
 *   症状：点了「来一题」，接口 404 / 数据明显是另一个项目的
 *   病因：baby-ai 的后端没起，8002 上坐的是 evalflow
 *
 * 你要从症状倒推到病因，中间会怀疑路由、怀疑参数、怀疑缓存……转一圈才发现
 * 环境本来就不对。这个脚本的作用就是把这一步提前到**启动之前**，
 * 并且在发现不对时**拦住你**，而不是让你带着一个错的环境去调业务代码。
 *
 * ## 为什么不能只靠"约定端口"
 *
 * 约定会失效：项目越加越多、Vite 端口被占会**默默顺延**（strictPort 默认 false）、
 * 后端炸了没人知道。所以真正可靠的做法是让每个服务**能自报身份** ——
 * 这也是为什么配套改动里有 `/health` 返回 `service` 字段这一条。
 *
 * ## 不只是端口
 *
 * 同一个道理适用于**所有"症状离根因很远"的环境问题**，所以这里也查 Node 版本：
 * `.nvmrc` 不会自动生效，版本不对时 npm 会递归派生上百个进程，
 * 报错里一个"版本"字样都没有。（详见下面「Node 版本」一节。）
 *
 * ## 用法
 *
 *   node scripts/devguard.mjs              # 自检 + 报告；发现阻断性问题则退出码 1
 *   node scripts/devguard.mjs --report     # 只报告，永远退出码 0（排查用）
 *
 * ## 维护
 *
 * 只需要改下面 CONFIG 那一块。加项目时同步更新 `neighbors`，
 * 这样报错信息里能直接写"坐在这儿的是谁"，而不是"未知服务"。
 */

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录 —— 本脚本固定放在 <root>/scripts/ 下。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================================
//  CONFIG —— 换项目只改这一块
// ============================================================================
const CONFIG = {
  /** 本项目名字。必须和后端 /health 返回的 service 字段一致。 */
  service: 'baby-ai',

  /**
   * 本项目要用的端口。
   *
   * - `role`    展示用
   * - `port`    端口号
   * - `expect`  期望的身份
   *              填 `'self-web'` → 前端端口，只要被占就算起不来（Vite 没有 /health）
   *              填 service 名   → 必须和 /health 的 service 字段一致才算对
   *              填 `null`       → 不校验身份，只报告（精排、Redis 这类没接口的服务）
   * - `blocked` 出问题时是否算"阻断性问题"（退出码 1）
   */
  ports: [
    { role: '前端', port: 5180, expect: 'self-web', blocked: true },
    { role: '后端', port: 8010, expect: 'baby-ai', blocked: true },
    { role: '精排', port: 8011, expect: null, blocked: false },
  ],

  /**
   * 别人家的端口 → 人类可读的名字。
   * 只在**报错信息**里用得上：把"未知服务"翻译成"evalflow 后端"，
   * 你一眼就知道要去哪儿关它。
   */
  neighbors: {
    5173: 'evalflow 前端',
    8002: 'evalflow 后端',
  },
};

/** 探测服务身份时按顺序试的路径。 */
const HEALTH_PATHS = ['/api/health', '/health'];

// ============================================================================
//  Node 版本
// ============================================================================
//
// 为什么也要查:`.nvmrc` **不会自动生效** —— 它只是给 `nvm use` 读的声明文件。
// shell 的默认 node 可能是别的版本,而版本不对时失败方式**极难排查**:
//
//   node 14 + npm 6 不认 `-w` 工作区参数,于是 `npm run dev -w client`
//   被解析成根目录的 `dev` 脚本,而那个脚本又回头调 `dev:client` ——
//   递归自我派生,几十秒内炸出上百个 node 进程。报错信息里没有任何
//   "版本不对"的提示,只有一屏长得一样的 shell 进程。
//   (详见图 docs/pitfalls/perf-and-env.md 坑 2)
//
// 这类"症状离根因十万八千里"的失败,正是这个脚本存在的理由。

/** 读 `.nvmrc` 声明的 Node 主版本号。读不到返回 null（跳过检查，而不是瞎报）。 */
function readRequiredNodeMajor() {
  try {
    // .nvmrc 只认第一行；允许 `20` / `v20` / `20.20.2` 这类写法
    const firstLine = fs.readFileSync(path.join(PROJECT_ROOT, '.nvmrc'), 'utf8').split('\n')[0].trim();
    const major = parseInt(firstLine.replace(/^v/, ''), 10);
    return Number.isNaN(major) ? null : major;
  } catch {
    return null; // 没有 .nvmrc 就不校验
  }
}

/**
 * 生成 Node 版本那一行，必要时给出阻断项或提醒。
 *
 * 分三档处理，因为"版本不对"的后果并不对等：
 *   · 低于要求 → 阻断。会真的跑不起来，且失败方式很迷惑。
 *   · 高于要求 → 提醒。一般没事，但和项目钉的版本不一致，排查怪问题时值得先切回来。
 */
function buildNodeRow() {
  const current = process.versions.node;
  const currentMajor = parseInt(current, 10);
  const required = readRequiredNodeMajor();

  if (required === null) {
    return { row: makeRow('node', `v${current}`, '未校验', COLOR.mute, '没有 .nvmrc', COLOR.mute) };
  }

  if (currentMajor === required) {
    return {
      row: makeRow('node', `v${current}`, '正常', COLOR.ok, `.nvmrc 要求 ${required}`, COLOR.ok),
    };
  }

  if (currentMajor < required) {
    return {
      row: makeRow('node', `v${current}`, '版本过低', COLOR.bad, `.nvmrc 要求 ${required}`, COLOR.bad),
      blocker: [
        `当前 node 是 v${current}，但 .nvmrc 要求 ${required}。`,
        `    → 版本不对时**失败方式通常很难查**：不是一句"版本太低"就完事，`,
        `      而是走偏门。例如低版本 npm 不认工作区参数，会把子目录的脚本`,
        `      解析成父目录的同名脚本、两边互相调用 —— 几十秒内递归派生上百个`,
        `      进程，而报错里一个"版本"字样都没有，只有一屏长得一样的 shell 进程。`,
        `    → 处理：先 \`nvm use\`（它会读 .nvmrc），再重新执行本命令。`,
      ].join('\n'),
    };
  }

  return {
    row: makeRow('node', `v${current}`, '版本偏高', COLOR.warn, `.nvmrc 要求 ${required}`, COLOR.warn),
    warning: `当前 node 是 v${current}，.nvmrc 钉的是 ${required} —— 通常能跑，但和项目声明的版本不一致。遇到怪问题时先 \`nvm use\` 切回来再试。`,
  };
}

// ============================================================================
//  探测
// ============================================================================

/** 探测时两个回环地址都要试 —— 见 checkPort 的说明。 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/**
 * 检测端口上有没有东西在监听。
 *
 * ⚠️ **必须同时试 IPv4 和 IPv6 的回环地址。**
 * Vite 默认 `host` 是 `localhost`，在本机可能只解析到 `::1` —— 也就是说服务
 * 只绑在 IPv6 回环上，`127.0.0.1:<port>` 反而是空的。
 * 只查 IPv4 的话，一个正被别人占着的端口会被报成「空闲」，这个脚本就白写了。
 *
 * @returns {Promise<'free'|'busy'|'unknown'>}
 *   - free    : 两个地址都被拒 → 没人监听
 *   - busy    : 任一个连上   → 有服务
 *   - unknown : 超时等异常   → 说不准（防火墙或半开状态）
 */
async function checkPort(port, timeoutMs = 500) {
  const results = await Promise.all(LOOPBACK_HOSTS.map((host) => connectOnce(port, host, timeoutMs)));
  if (results.includes('busy')) return 'busy';
  if (results.includes('unknown')) return 'unknown';
  return 'free';
}

/** 探测单个地址。 */
function connectOnce(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('busy'));
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', (err) => finish(err.code === 'ECONNREFUSED' ? 'free' : 'unknown'));
  });
}

/** 发一个 GET，把响应体读回来（只读前 4KB）。没响应返回 null。 */
function httpGet(port, path, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 问一下端口上的服务"你是谁"。
 *
 * 优先读 /health 返回体里的 `service` 字段 —— 这就是"服务自报身份"。
 * 没有这个字段的服务只能报告"占用中，无身份标识"。
 */
async function identify(port) {
  let gotHttpResponse = false;

  // 两个回环地址都试 —— 服务可能只绑在 ::1 上（原因同 checkPort）。
  for (const path of HEALTH_PATHS) {
    for (const host of LOOPBACK_HOSTS) {
      const res = await httpGet(port, path, host);
      if (!res) continue;
      gotHttpResponse = true;
      if (res.status !== 200 || !res.body) continue;

      let json = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        /* 不是 JSON —— 大概率是个网页（前端 dev server 把 index.html 当 SPA 回退返回） */
      }
      // 'json' 和 'page' 分开：前者说明对面是个真的后端（只是没报 service），
      // 后者说明对面是个**前端**服务。这个区别直接决定你下一步去哪儿找。
      return { kind: json ? 'json' : 'page', json };
    }
  }

  // 必须区分「对面是 HTTP 服务、只是没有我们能问的接口」和「对面压根不应答」。
  // 混为一谈的后果是实测出来的：Chroma 听在 8000、是标准的 HTTP 服务，
  // 但它没有 /health，只回 404 —— 于是被标成「不是 HTTP」，
  // 而"不是 HTTP"会让人往"这端口上坐的是数据库之类"的方向去想，排查方向直接偏掉。
  return { kind: gotHttpResponse ? 'http' : 'none', json: null };
}

/**
 * 探测不出身份时的三种说明。
 * 分三种而不是一句"未知服务"，是因为**排查方向取决于这个区别**（见上面 identify 的说明）。
 */
const UNKNOWN_LABEL = {
  json: '未知服务（/health 有响应，但没有 service 字段）',
  page: '未知服务（返回的是网页，像是前端服务）',
  http: '未知服务（是 HTTP，但没有 /health 接口）',
  none: '未知服务（非 HTTP 或未响应）',
};

// ============================================================================
//  输出工具
// ============================================================================

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
};

/** 终端里中日韩字符占两格，padEnd 会算错 —— 自己算显示宽度。 */
function displayWidth(str) {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(str, targetWidth) {
  const gap = targetWidth - displayWidth(str);
  return gap > 0 ? str + ' '.repeat(gap) : str;
}

function rule(width = 74) {
  return ANSI.dim + '─'.repeat(width) + ANSI.reset;
}

// ============================================================================
//  主流程
// ============================================================================

/** 一行表格数据。文字和颜色分开存 —— 先按无色的文本算列宽，最后再上色。 */
function makeRow(role, port, statusText, statusColor, ownerText, ownerColor) {
  return { role, port, statusText, statusColor, ownerText, ownerColor };
}

const COLOR = {
  ok: ANSI.green,
  bad: ANSI.red,
  warn: ANSI.yellow,
  mute: ANSI.dim,
};

async function main() {
  const reportOnly = process.argv.includes('--report');
  const rows = [];
  const blockers = [];
  const warnings = [];

  // Node 版本放在最前面查：版本不对的话，后面端口那几行的结论也都不作数
  // —— 你可能是用一个跑不动这个项目的 node 在起服务。
  const nodeCheck = buildNodeRow();
  rows.push(nodeCheck.row);
  if (nodeCheck.blocker) blockers.push(nodeCheck.blocker);
  if (nodeCheck.warning) warnings.push(nodeCheck.warning);

  for (const { role, port, expect, blocked } of CONFIG.ports) {
    const state = await checkPort(port);

    if (state === 'free') {
      rows.push(makeRow(role, port, '空闲', COLOR.mute, '—', COLOR.mute));
      continue;
    }

    if (state === 'unknown') {
      rows.push(makeRow(role, port, '状态不明', COLOR.warn, '探测超时，说不准', COLOR.warn));
      warnings.push(`端口 ${port}（${role}）探测超时。可能被防火墙拦了，也可能服务半死不活。`);
      continue;
    }

    // ---- 有人监听：问它是谁 ----
    const info = await identify(port);
    const actual = info.json?.service ?? null;
    // `named` 只在真的知道名字时才有值（服务自报的 service，或 neighbors 里登记过的）。
    // 区分它和通用的"未知服务…"文案，是为了后面写处理建议时不说出
    // 「去关掉 未知服务…那个进程」这种别扭话。
    const named = actual ?? CONFIG.neighbors[port] ?? null;
    const label = named ?? UNKNOWN_LABEL[info.kind];

    // 前端端口：Vite 没有 /health，被占就等于"起不来"。
    if (expect === 'self-web') {
      // 但要分清两种情况，否则会误报：
      //   · 占着它的是**别的项目** → 真问题，拦住。这正是
      //     「我打开 localhost:5173，看到的却是别人的页面」的来源。
      //   · 占着它的是**本项目自己**（你已经跑着一个 dev server 了；
      //     或者它的 /api 代理把身份探测转发给了自己的后端）→ 只是"已在运行"，
      //     提醒一句就够，别拿红字吓人、更不该拦住。
      const isOtherProject = named !== null && named !== CONFIG.service;

      if (isOtherProject) {
        rows.push(makeRow(role, port, '被占用', COLOR.bad, named, COLOR.bad));
        blockers.push(
          [
            `端口 ${port}（${role}）被「${named}」占着 —— 那是别的项目，不是 ${CONFIG.service}。`,
            `    新的 dev server 起不来（Vite 开了 strictPort），`,
            `    而且更要紧的是：**「我打开 localhost:${port}」看到的会是别人的页面**。`,
            `    处理：去那个项目的终端 Ctrl-C 停掉，或者关掉浏览器里那个标签页。`,
          ].join('\n'),
        );
      } else {
        rows.push(makeRow(role, port, '已在运行', COLOR.warn, named ?? label, COLOR.warn));
        warnings.push(
          `端口 ${port}（${role}）已被占用${named ? `（${named}）` : ''} —— 若是你自己跑着的 dev server，忽略即可。`,
        );
      }
      continue;
    }

    // 不校验身份，只报告（精排 / Redis 这类）
    if (expect === null) {
      rows.push(makeRow(role, port, '监听中', COLOR.mute, label, COLOR.mute));
      continue;
    }

    if (actual === expect) {
      const detail = info.json?.uptime != null ? `uptime ${info.json.uptime}s` : '已就绪';
      rows.push(makeRow(role, port, '正常', COLOR.ok, `${label}（${detail}）`, COLOR.ok));
      continue;
    }

    // ---- 身份不对：这就是那个坑 ----
    rows.push(makeRow(role, port, '身份不符', COLOR.bad, label, COLOR.bad));
    if (blocked) {
      const fix = named
        ? `先关掉占用 ${port} 的进程 —— 是「${named}」的话，通常去那个项目的终端 Ctrl-C。`
        : `先用 \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` 看是谁占着，再决定关不关。`;
      blockers.push(
        [
          `端口 ${port}（${role}）上坐的${named ? `是「${named}」，` : ''}不是你的 ${CONFIG.service}。`,
          `    → ${CONFIG.service} 自己的后端起不来，前端所有 /api 请求都会打到它身上。`,
          `    → 症状是「某个接口 404 / 数据明显不对」，很容易被误当成业务 bug 查半天。`,
          `    → 处理：${fix}`,
        ].join('\n'),
      );
    }
  }

  // ---- 打表 ----
  const roleWidth = Math.max(...rows.map((r) => displayWidth(r.role))) + 2;
  const statusWidth = Math.max(...rows.map((r) => displayWidth(r.statusText))) + 2;

  console.log('');
  console.log(`${ANSI.bold}  端口自检${ANSI.reset} ${ANSI.dim}—— ${CONFIG.service}${ANSI.reset}`);
  if (reportOnly) {
    console.log(`${ANSI.dim}  （--report：只报告，不拦截，退出码恒为 0）${ANSI.reset}`);
  }
  console.log(rule());
  for (const row of rows) {
    const role = pad(row.role, roleWidth);
    const status = pad(row.statusText, statusWidth);
    console.log(
      // 「端口」这一列 node 那行放的是版本号（v20.20.2 = 8 格），留 10 格才不挤
      `  ${role}${pad(String(row.port), 10)}${row.statusColor}${status}${ANSI.reset}${row.ownerColor}${row.ownerText}${ANSI.reset}`,
    );
  }
  console.log(rule());

  // ---- 结论 ----
  console.log('');
  if (blockers.length) {
    console.log(`${ANSI.red}${ANSI.bold}  ✗ 环境不对，先别急着调业务代码${ANSI.reset}`);
    console.log('');
    blockers.forEach((block) => {
      console.log(`  ${block}`);
      console.log('');
    });
    warnings.forEach((w) => console.log(`  ${ANSI.yellow}⚠ ${w}${ANSI.reset}`));
    if (warnings.length) console.log('');
    if (!reportOnly) process.exit(1);
    return;
  }

  if (warnings.length) {
    console.log(`${ANSI.yellow}  ⚠ 没挡住你，但有几点提醒${ANSI.reset}`);
    console.log('');
    warnings.forEach((w) => console.log(`  ${w}`));
    console.log('');
    return;
  }

  console.log(`${ANSI.green}  ✅ 端口对得上，没有别的项目占着你的位置${ANSI.reset}`);
  console.log('');
}

main().catch((err) => {
  // 自检脚本自己崩了不该阻断开发 —— 只提示，不抛栈。
  console.log(`${ANSI.yellow}  ⚠ devguard 自身出错，跳过自检：${err.message}${ANSI.reset}`);
  console.log('');
  process.exit(0);
});
