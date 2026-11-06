# workbuddy-bridge

> 把 WorkBuddy（`codebuddy` CLI）接成任意编程 Agent 的子 Agent，**扫码即可录入账号**。
>
> Claude Code / DeepSeek Harness / Codex / Cursor / OpenCode / Windsurf / Gemini CLI / Cline 通用。

![登录页](assets/login-page.png)

---

## 这解决什么问题

WorkBuddy 能力很强，但它是「一个 App」。你在 Claude Code 里写代码时想让它顺手处理一下报表、生成 PPT、跑一遍长链路调研，只能切窗口、复制粘贴、再把结果搬回来。

Windsurf、Cursor 这些客户端各有各的 MCP 生态，官方没有提供「反向 MCP」让它们把 WorkBuddy 当子 Agent 调。

本项目的做法很简单：**把官方 CLI 包一层标准 MCP**，让任意支持 MCP 的编程 Agent 通过一个工具调用把活派给 WorkBuddy。在此之上补了三件参考实现没有覆盖、但实际用起来最疼的事：

1. **扫码登录**：不用先开终端手动登录一次，Agent 里直接要一张二维码，手机扫完就能用；
2. **多账号隔离**：一个账号一个独立配置目录和 HOME，公司号 / 个人号随时切，互不污染；
3. **号池调度**：多个号自动分配负载，限流或掉登录就换号，带一个能看额度与负载的管理界面。

## 架构

```
  Claude Code / DeepSeek Harness / Codex / Cursor / OpenCode / Windsurf …
        │   MCP (stdio 或 HTTP)
        │   工具：workbuddy_task / workbuddy_login / …
        ▼
  workbuddy-bridge            ← 本项目
        │   ├── 账号管理：~/.workbuddy-bridge/profiles/<name>（配置 + HOME）
        │   ├── 扫码登录：PTY 驱动 TUI → 抓授权链接 → 二维码
        │   ├── 号池调度：选号 → 执行 → 记账 → 失败换号
        │   ├── 数据看板：小时/天桶 → 区间聚合 → 热力图
        │   └── 任务执行：spawn + stream-json 解析
        ▼
  codebuddy -p --output-format stream-json
        │
        ▼
  WorkBuddy 服务（真正干活，文件写到你指定的 cwd）
```

关键点：**不碰私有接口，也不逆向协议**。桥接只驱动官方 CLI，登录走官方 OAuth 流程，凭证由 CLI 自己加密落盘。

## 快速开始

```bash
# 1. 前置：装好 WorkBuddy CLI（只需一次）
npm i -g @tencent-ai/codebuddy-code

# 2. 装桥接
git clone <this-repo> && cd workbuddy-bridge
npm install
npm link          # 之后可以直接用 wb 命令

# 3. 扫码登录（终端里会打出二维码，同时起一个本地登录页）
wb login

# 4. 注册到你已安装的 Agent
wb install

# 5. 有多个号？再登一次，然后打开管理界面看负载
wb login --account alice
wb admin
```

`wb install` 会自动探测并写入：

| 客户端 | 配置文件 |
|:--|:--|
| Claude Code | `~/.claude.json` |
| DeepSeek Harness | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Codex CLI | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline (VS Code) | `.../saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

不在列表里的客户端：`wb install --print` 拿一段通用 JSON，手工粘进去即可。

重启 Agent，然后直接说：

> 让 workbuddy 读一下 ./reports 里的 CSV，出一份中文月度总结

## 号池：多账号 + 自动分配负载

v0.2 起，多个扫码账号不再只是「手动切换」，而是一个可调度的池子。`workbuddy_task` 不指定 `account` 时默认 `auto`，由调度器挑号；某个号挂了会自动换下一个。v0.3 补了完整的用量看板：区间曲线、缓存命中率、年度热力图和最近请求流。

![数据看板](assets/pool-dashboard.png)

### 调度规则

每一轮选号按顺序做两件事：

1. **硬过滤**：停用 / 未登录 / 冷却中 / 并发已满 / 当日预算用尽 → 本轮不参与
2. **排序取第一个**：
   - `balanced`（默认）：先给当前没在跑的号（突发流量不叠在同一个号上），再比「当日 token ÷ 权重」，最后比「最久未使用」
   - `round-robin`：按权重展开成环形队列顺序轮转，游标持久化，跨进程也能保持均匀

失败处理：

| 情况 | 处理 |
|:--|:--|
| 未登录 / 登录失效 | 标记 `unauthorized`，立刻换下一个号；重新扫码后自动恢复 |
| 429 / 额度不足 | 指数退避冷却 1 → 2 → 4 … 分钟，上限 30 分钟，期间不接活 |
| 超时 / 调用方取消 | 不重试，原样返回 |
| 其他错误 | 记一次失败，原样返回 |

**换号有个前提**：任务还没产出任何内容。已经写了文件、或已经吐出半截答案的任务不会重跑——重复执行的副作用比失败更麻烦。

### 额度怎么算

WorkBuddy CLI 没有公开的额度查询接口（`stream-json` 只给 token 用量），所以这里刻意不编数字：

- **已用**：真实数据。从 `result.usage` 取 `input_tokens` / `output_tokens` / `cache_read_input_tokens`。
  实测 CLI 0.2.x 的 `input_tokens` **已经包含**缓存读取部分，所以总输入就是 `input_tokens`，不再二次相加——之前多算一遍会让用量虚高近一倍
- **剩余**：需要给账号设一个每日预算（`budgetTokens`）。设了才算得出剩余和百分比，并据此停派；不设就只显示用量，不做拦截
- **缓存命中率** = `cache_read_input_tokens ÷ input_tokens`
- **费用**：优先用 CLI 返回的 `total_cost_usd`；没有就按 `WB_PRICE_IN` / `WB_PRICE_OUT` 估算；两者都没配时显示「CLI 未上报计价」，不猜

明细保留：小时桶 16 天、天桶 400 天、最近请求 160 条。够画一整年热力图，又不会让 `pool.json` 无限膨胀。

如果你们的部署能拿到官方额度（企业网关、内部计费接口等），可以用 `WB_QUOTA_CMD` 把真数据接进面板：

```bash
export WB_QUOTA_CMD='my-quota --account "$WB_ACCOUNT" --json'
# 需要输出：{"limit":120000,"used":48000,"remaining":72000,"unit":"tokens"}
```

调度仍以本地预算为准，外部额度只用于展示——避免一个探针失败就把整池停掉。

### 管理界面

```bash
wb admin              # 默认 http://127.0.0.1:7667
```

![扫码登录弹窗](assets/pool-login.png)

**顶部看板**，区间可切今日 / 近 3 日 / 本周 / 本月 / 近 30 日 / 全部：

| 区块 | 内容 |
|:--|:--|
| KPI | Token 消耗（输入 / 输出 / 缓存读写拆分）、请求数、生成速度、缓存命中率、API 等价费用、成功率环 |
| 时序图 | Token / 请求数 / 吞吐量三视图，柱状叠折线，悬停看逐点明细；按区间自动切小时或按天聚合 |
| 最近请求 | 实时活动流：时间、模型、账号、token、耗时，失败的标红 |
| 工作回顾 | GitHub 风格年度热力图，按 token 量分五档；右侧是活跃天数、总请求、总 token、峰值日 |

环比取「等长的上一段」：今日对昨日同时段、本周对上周、30 天对前 30 天。「全部」区间没有上一段，显示 `—`。

**账号池**每张卡上能看到：

- **额度**：剩余 token / 预算、今日已用、缓存占比、7 日用量曲线；没设预算时明确显示「未设每日预算」，不会假装是 0
- **负载**：今日请求数、成功率、今日 token、当前并发 / 上限、平均耗时
- **状态**：可用 / 冷却中（带倒计时）/ 未登录 / 已停用，左侧色条同步
- **操作**：扫码登录（弹窗直接出二维码）、测试、设预算、重置冷却、调权重、启停、删除

顶部汇总可用账号数与状态分布，策略下拉即时生效。看板数据走 `GET /api/stats?range=today|3d|week|month|30d|all`，前端每 5 秒轮询一次。

### 命令行

```bash
wb pool                        # 表格总览
wb pool strategy round-robin   # 切换策略
wb pool weight alice 3         # 权重调到 3
wb pool disable alice          # 停用
wb pool reset alice            # 清冷却与失败计数
wb pool test alice             # 发一条最小请求验证
```

> 并发计数是进程内运行态，重启后自动归零。同一个 bridge 进程内的任务会遵守账号的 `maxConcurrency`；如果分别启动多个 stdio MCP 进程，各进程会独立计数，需要全局并发限制时应统一连接同一个 HTTP MCP 服务。

## 扫码登录怎么工作的

`codebuddy` 没有 `login` 子命令——登录界面是启动时渲染的 Ink TUI。所以桥接用伪终端把它跑起来，代替人做三件事：

1. 在 `Select login method` 里按上下键选站点（默认国内站）、回车；
2. 从 TUI 输出里把授权链接抠出来；
3. 盯着它什么时候真正拿到凭证。

新版 CLI 未登录时可能先显示主界面，提交一条消息后才进入登录流程；授权链接也可能只写进本账号日志。桥接会识别这两种情况，且只读取当前账号新增日志中的链接。链接提取做了四层，因为 Ink 还会把长 URL 折行、因重绘重复输出：

| 层级 | 手段 | 说明 |
|:--|:--|:--|
| 1 | OSC 8 超链接 | 终端里可点击的链接，URL 完整不折行，最可靠 |
| 2 | 去换行整体匹配 | Ink 折行不插空格，拼起来就是完整 URL |
| 3 | 逐行 + 尾部清洗 | 兜底，去掉粘在尾巴上的 `Waiting for auth` 之类 UI 文案 |
| 4 | 账号日志兜底 | 只读取本账号新增的 `Opening auth URL` 行，避免串号或使用旧链接 |

拿到链接后：终端直接画二维码；同时若开了 `wb http`，手机浏览器打开 `http://<局域网IP>:7666/login` 也能看到同一张码。

授权完成由 CLI 自己轮询感知，**不依赖手机回调到本机端口**，所以在远程服务器上也成立。

### 三种场景怎么选

| 场景 | 推荐做法 |
|:--|:--|
| 本机开发（有浏览器） | `wb login`，终端扫码即可 |
| 局域网服务器 | `wb login` + `wb http --host 0.0.0.0`，手机连同一 WiFi 打开登录页 |
| 无浏览器的云主机 / 容器 | 本机 `wb login` → `wb export` → 拷到服务器 → `wb import` |

第三种是很多人真正会遇到的情况。镜像里连 TUI 都跑不起来（被强制 headless），扫码无从谈起，搬凭证反而最省事：

```bash
# 你的笔记本
wb login --account work
wb export work.tgz --account work

# 服务器
scp work.tgz server:~/
wb import work.tgz --account work
wb doctor            # 确认已登录
```

> `export` 出来的包里有 token，等同于账号权限。文件权限已强制 600，别传公网、别进 git。

## DeepSeek Harness（dsh）接入细节

dsh 的配置模型和别的客户端都不一样，有两点容易踩坑，`wb install` 已经替你处理：

**1. 它不是 `mcpServers` JSON，而是一份 YAML patch 层。**

用户层在 `~/.dsh/profiles/<profile>/cordis.patch.yml`，顶层是数组，插入插件要用 `insert`：

```yaml
- insert:
    - id: mcp-workbuddy
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: workbuddy
        transport: stdio
        command: '/usr/local/bin/node'
        args:
          - '/opt/workbuddy-bridge/src/server.js'
```

**2. MCP 客户端本身是个插件，版本必须和 dsh 本体对齐。**

dsh 在启动时会做兼容性检查，不匹配就把整行**静默禁用**，日志里只留一句：

```
dsh: disabling profile plugin row "mcp-workbuddy": Plugin @deepseek-ai/dsh-mcp-client@0.0.1-rc.1
is incompatible with dsh 0.2.1-rc.5 ...
```

偏偏 npm 上 `@deepseek-ai/dsh-mcp-client` 的 `latest` 标签还停在 `0.0.1-rc.1`（2026-11 时），直接 `pnpm add` 装到的就是这个老版本。所以桥接会先读出你的 dsh 版本，再装同版本号的插件（如 `@deepseek-ai/dsh-mcp-client@0.2.1-rc.5`）。手动安装时务必带上版本：

```bash
cd ~/.dsh/profiles/web
pnpm add @deepseek-ai/dsh-mcp-client@$(dsh --version)
```

配置生效后，工具在 dsh 里叫 `mcp__workbuddy__workbuddy_task`（MCP 服务器限定命名），其余用法不变。

> `wb install` 会写入 `~/.dsh/profiles/` 下所有已初始化的 profile。设 `WB_DSH_SKIP_PLUGIN_INSTALL=1` 可跳过插件安装、只写配置。

## 工具一览

| 工具 | 作用 |
|:--|:--|
| `workbuddy_task` | 核心。把任务交给 WorkBuddy，返回最终文本；文件写到 `cwd` |
| `workbuddy_login` | 返回二维码（图片 + 终端字符画 + 链接），发起登录 |
| `workbuddy_login_status` | 查进度；`confirm=true` 可在自动检测失灵时手动确认 |
| `workbuddy_pool` | 查看号池负载与额度；切策略、启停、调权重、清冷却 |
| `workbuddy_accounts` | 列出 / 切换默认 / 删除账号 |
| `workbuddy_doctor` | 环境自检 |

`workbuddy_task` 参数：

```jsonc
{
  "prompt": "整理 ./data 下的销售数据，输出 xlsx 和一段结论",  // 必填
  "cwd": "/path/to/project",   // WorkBuddy 读写文件的位置
  "model": "auto",             // auto / hy3 / deepseek-v4-pro …
  "fallbackModel": "deepseek-v4-flash",  // 主模型限流时自动回退
  "timeoutMs": 900000,
  "account": "auto"   // 默认 auto = 号池自动挑；填具体名字则强制用该号，不做故障切换
}
```

长任务会通过 MCP progress 通知持续汇报，避免客户端以为卡死。

## 多账号

一个账号 = 一个独立的 `CODEBUDDY_CONFIG_DIR` + `HOME`。CodeBuddy 会把认证文件写在 `HOME` 下，所以两者必须一起隔离：

```bash
wb login --account work     # 公司号
wb login --account personal # 个人号
wb accounts use work
```

Agent 里也可以指定：`workbuddy_task(..., account: "personal")`。

不指定时默认 `auto`：由号池按负载挑号，某个号掉登录或被限流会自动换下一个。`wb accounts use` 设的「默认账号」只在显式不启用号池时作为兜底。

### 站点选择

```bash
wb login --site cn          # 国内站（默认）
wb login --site intl        # 国际站
wb login --site enterprise  # 企业专享版
wb login --site ioa         # 腾讯内网
```

## 配置

| 环境变量 | 默认 | 说明 |
|:--|:--|:--|
| `WB_COMMAND` | `codebuddy` | CLI 路径，找不到时填绝对路径 |
| `WB_BRIDGE_HOME` | `~/.workbuddy-bridge` | 桥接数据目录 |
| `WB_DEBUG` | – | `1` 打调试日志 |
| `WB_QUOTA_CMD` | – | 可选，外部额度探针命令，输出 JSON 供面板显示 |
| `WB_ADMIN_TOKEN` | – | 可选，给 `/admin`、`/api/pool` 与 `/api/stats` 加访问令牌 |
| `WB_PRICE_IN` | – | 输入价（元 / 百万 token），用于估算费用 |
| `WB_PRICE_OUT` | – | 输出价（元 / 百万 token） |
| `WB_PRICE_CACHE` | 输入价一折 | 缓存读取价（元 / 百万 token） |
| `WB_USD_CNY` | `7.2` | CLI 返回美元成本时用的汇率 |

`~/.workbuddy-bridge/config.json` 里可改默认模型、超时、是否自动授权：

```jsonc
{
  "defaultAccount": "work",
  "defaults": {
    "model": "auto",
    "fallbackModel": "deepseek-v4-flash",
    "timeoutMs": 900000,
    "skipPermissions": true
  }
}
```

号池状态单独一份 `~/.workbuddy-bridge/pool.json`：

```jsonc
{
  "strategy": "balanced",        // balanced | round-robin
  "maxAttempts": 3,              // 单次任务最多试几个号
  "accounts": {
    "alice": {
      "enabled": true,
      "weight": 2,
      "maxConcurrency": 1,
      "budgetTokens": 120000,    // 0 = 不限额
      "today": { "req": 34, "ok": 34, "tokensIn": 50184, "tokensOut": 11016, "ms": 727600 }
    }
  }
}
```

一般不用手改：`wb pool …` 和管理界面都是写这个文件。

## 安全说明

- **默认自动授权**：任务会带 `--dangerously-skip-permissions`，WorkBuddy 请求的文件/网络操作直接执行。个人可信环境没问题；要留人工确认，把 `skipPermissions` 设成 `false`。
- **凭证在本地**：桥接不接管 token，只是给 CLI 指定配置目录。凭证由 CLI 自己加密存放。
- **stdio 不污染**：MCP 的 stdout 是协议通道，桥接所有日志走 stderr 和 `~/.workbuddy-bridge/logs/`。
- **导出包敏感**：`wb export` 的 tgz 等同账号权限，自行保管。
- **管理界面默认只监听 127.0.0.1**：`wb admin --host 0.0.0.0` 会把「删除账号、改权重」暴露给同网段，务必同时设 `WB_ADMIN_TOKEN`。

## 常见问题

**需要 WorkBuddy 桌面端开着吗？**
不需要。桥接驱动的是 CLI，和桌面端同一套引擎，独立运行。

**Agent 里看不到我让它生成的文件？**
文件写在 `cwd`，不会自动进入 Agent 上下文。让它 `cat` 或 `read` 一下就行。

**登录一直卡在 waiting_scan？**
先确认手机上是否真的点了授权；二维码有有效期，超时重新 `wb login`。若 CLI 在你这台机器上根本不渲染 TUI（容器里常见），改用 `wb export` / `wb import`。

**Windows 上扫码失败？**
`node-pty` 是可选的，没装时 Linux/macOS 走系统 `script` 命令，Windows 没有等价物。装一下即可：

```bash
npm i -g node-pty
```

**任务被客户端掐断？**
多数 MCP 客户端对单次工具调用有超时上限。把 `timeoutMs` 设小一点先拿中间结果，或改用 `wb http --mcp` 走 HTTP 传输。

## 开发

```bash
npm test
```

### 测试约定

**测试一律用 deepseek，不用 hy4。**

- 离线测试（`npm test`）不真正调用模型；假 CLI 的回包和断言里的模型名固定为 `deepseek-v4-flash`，日志里不会出现 hy4
- 需要真实链路验证时显式指定模型：

```bash
wb task "只回答两个字：收到" --model deepseek-v4-flash
```

hy4 是旗舰模型，单价高、排队久，拿它跑测试既费额度又拖慢反馈。功能联调用 flash 足够；要看复杂推理表现时再手动单独跑，但不要写进测试脚本或 CI。

52 项测试，不联网、不消耗模型额度。登录链路用一个假的 `codebuddy` 脚本把 TUI 完整演一遍，覆盖 HOME 隔离、主界面触发登录、日志链接兜底、折行 URL 提取、二维码落盘和状态机流转；dsh 的写入 / 幂等 / 卸载用隔离 HOME 验证；号池用同一个假 CLI 模拟「未登录 / 429 / 正常」三种账号，验证过滤、加权轮询、冷却退避、失败换号与额度计算；统计层验证桶合并、空档补零、区间窗口、周/月环比、缓存命中率、事件过滤和年度热力图；管理页验证令牌透传；发布元数据与 CLI 版本输出也纳入检查。

```
src/
  server.js     MCP 工具定义
  login.js      扫码登录状态机
  ansi.js       TUI 输出解析 / URL 提取
  runner.js     codebuddy 进程封装 + stream-json 解析
  pool.js       号池状态：选号、记账、冷却、额度
  stats.js      用量时序：小时/天桶、区间聚合、热力图
  dispatch.js   选号 → 执行 → 失败换号
  accounts.js   多账号
  transfer.js   凭证导出导入
  install.js    各客户端注册（含 dsh 的 YAML patch 与插件版本对齐）
  admin.js      号池管理界面（单文件、零外部依赖）
  http.js       登录页 + 号池 API + Streamable HTTP
```

## 参考与致谢

- [LinHaiJ/workbuddy-mcp](https://github.com/LinHaiJ/workbuddy-mcp)（MIT）——「单工具包装 CLI + 一键注册多客户端」的思路来自这里，本项目的 `run_workbuddy_task` 语义与 `WB_*` 命名与之保持一致，方便迁移。
- [jav1es/workbuddy-bridge](https://github.com/jav1es/workbuddy-bridge) —— 在其之上做的 MCP 桥接封装，验证了这条链路可行。
- 官方 CLI 文档：[codebuddy.cn/docs/cli](https://www.codebuddy.cn/docs/cli/quickstart)
- 号池调度参考：
  - [yasyf/cc-pool](https://github.com/yasyf/cc-pool) —— 「按余量而非请求数分配、会话开始前就选好号」的思路
  - [dhkts1/teamclaude-rs](https://github.com/dhkts1/teamclaude-rs) —— 最少使用轮转、额度进度条、冷却与优先级
  - [GPT-Load](https://www.gpt-load.com/) —— 权重调度、429 冷却、故障切换的工程做法
  - [can1357/c2switcher](https://github.com/can1357/c2switcher) —— 多账号用量看板的交互参考

## License

MIT
