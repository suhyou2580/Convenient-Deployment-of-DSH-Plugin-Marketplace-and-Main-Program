# DSH 插件一键部署器

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的本地插件管理器：**搜索全网 dsh 插件 → 看中文功能介绍 → 一键安装到本地 profile**。

一个零依赖的本地 Web 应用。后端只用 Node 内置模块，前端是原生 HTML/CSS/JS，没有构建步骤、没有 `node_modules`。

---

## 功能特性

- **插件市场** — 直接检索 npm registry 上所有带 `dsh-plugin` 关键词的包，按月下载量 / 更新时间 / 名称排序，支持本地关键词过滤。
- **AI 中文简介** — 接入任意 OpenAI 兼容接口（默认 DeepSeek），为插件批量生成「做什么、为谁解决什么问题」的中文说明和分类标签，告别英文 description 复读。
- **一键安装** — 选定目标 profile，二次确认后执行 `dsh plugin --profile <name> add <pkg>`，安装日志实时流式输出。
- **已安装管理** — 列出当前 profile 的插件，区分「已安装 / 已启用 / 内置」；可启用、禁用、卸载（内置 bundle 受保护，不可更改）。
- **pnpm 体检** — 启动时自动检测 `dsh` / `pnpm` 是否就绪，缺 pnpm 时提供一键安装。
- **启动 / 重启 dsh web 本体** — 顶部徽章实时显示本体是否在运行（运行中可点击直接打开）；按钮对本体做「没运行就启动、在运行就重启」，改完插件不用手动敲命令。启动时会自动捕获本体打印的带 token 访问地址，徽章一键打开、免手动复制。

---

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| **Node.js** ≥ 18 | 运行本应用（用到 ES Module、`node:` 前缀导入） |
| **DeepSeek Harness (`dsh`)** | 被管理的目标。本应用通过命令行调用它 |
| **pnpm** | `dsh` 安装插件的底层依赖，通常随 dsh 一起装好 |

> 本应用**自身没有任何 npm 依赖**，克隆下来即可运行，无需 `npm install`。

---

## 快速开始

### 方式一：一键启动（Windows）

双击项目根目录的 **`启动.bat`**。它会检查 Node 环境、等 2 秒后自动打开浏览器，并在当前窗口运行服务。

关闭那个窗口即停止服务。

### 方式二：手动启动（跨平台）

```bash
node server.js
```

看到下面这行就说明起来了：

```
DSH 插件一键部署器: http://127.0.0.1:3210
Profiles 目录: C:\Users\<你>\.dsh\profiles
```

然后浏览器打开 <http://127.0.0.1:3210>。

### 启动排查：自检

```bash
node check.js     # 或 npm run check
```

逐项检查 Node 版本、必需文件、`.bat` 换行符、端口占用、`dsh` / `pnpm`、profiles 清单、registry 连通性，并列出所有问题。`启动.bat` 会在启动前自动跑一遍，有「错误」级问题时暂停并提示。

### 自定义端口

默认端口 `3210`。用环境变量覆盖：

```bash
# Windows (cmd)
set PORT=8080 && node server.js

# PowerShell / macOS / Linux
PORT=8080 node server.js
```

---

## 使用说明

界面分左右两个标签页。

### 插件市场

1. 点 **「加载插件」** 拉取 npm 上的 dsh 插件（默认按 `dsh-plugin` 关键词）。
2. 用 **本地过滤** 输入框按名称 / 描述 / 标签筛；用下拉框切换排序和每页数量，**加载更多** 翻页。
3. 点某张卡片上的 **安装**，会弹出二次确认（显示将要执行的真实命令），确认后开始安装，日志在右侧抽屉实时滚动。
4. 点 **「✦ 为当前列表批量生成 AI 简介」** 可为当前页插件生成中文说明 —— 需先在 **设置** 里填好 API Key。

### 已安装管理

1. 点 **「刷新已安装」** 读取目标 profile 的插件清单。
2. 每个插件显示状态：**已启用 / 已禁用 / 内置**。
3. **启用 / 禁用** 直接改写 profile 的 `dsh.profile.bundles`，改完需重启 dsh web 生效（界面会提示）。
4. **卸载** 已安装插件；内置 bundle（如 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）不可卸载。

### 设置

点右上角 **⚙ 设置**：

| 项 | 作用 |
| --- | --- |
| **目标 Profile** | 插件安装到哪个 profile（下拉列出 `~/.dsh/profiles` 下的目录） |
| **dsh web 端口** | 「重启 dsh web」按钮要操作的端口，默认 `3080` |
| **AI 提供方** | DeepSeek（默认）或自定义 OpenAI 兼容端点 |
| **Base URL / 模型名** | AI 接口地址与模型，默认 `https://api.deepseek.com/v1` + `deepseek-chat` |
| **API Key** | AI 简介所需的密钥 |

> **API Key 只保存在你本机浏览器的 `localStorage` 里**，请求时经本机服务转发给 AI 接口，不会被本应用持久化或上传到其他地方。

---

## 目录结构

```
.
├── server.js          # 后端：静态托管 + npm 搜索代理 + dsh 插件安装 + AI 简介 + 启动/重启 web
├── check.js           # 自检：逐项检查环境与文件，列出问题（node check.js）
├── 启动.bat           # Windows 一键启动（启动前自动自检）
├── public/
│   ├── index.html     # 单页界面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式
├── package.json
└── README.md
```

---

## HTTP 接口

供参考（全部绑定在 `127.0.0.1`，仅本机可访问）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 环境探测：dsh / pnpm 版本、profile 列表 |
| GET | `/api/web-status?port=` | 探测 dsh web 本体是否在指定端口监听 |
| GET | `/api/search?q=&page=&size=` | 代理 npm 搜索 `dsh-plugin` |
| GET | `/api/installed?profile=<name>` | 列出某 profile 的插件及状态 |
| POST | `/api/deploy` | `{ package, profile }` → 安装插件（SSE 流式日志） |
| POST | `/api/deploy-pnpm` | 全局安装 pnpm（SSE 流式日志） |
| POST | `/api/plugin/toggle` | `{ package, profile, enabled }` → 启用/禁用 |
| POST | `/api/plugin/remove` | `{ package, profile }` → 卸载（SSE 流式日志） |
| POST | `/api/restart-web` | `{ port }` → 重启 dsh web（SSE 流式日志） |
| POST | `/api/ai/describe` | `{ packages, baseUrl, apiKey, model }` → AI 中文简介 |

---

## 安全说明

- 服务只监听 `127.0.0.1`，不对局域网 / 公网暴露。
- 所有会拼进命令行的参数都经过校验：包名须符合 npm 命名规则，profile 须命中 `~/.dsh/profiles` 白名单，端口须为合法整数。
- 安装 / 卸载前会弹出二次确认，明确展示将要执行的命令 —— 因为**安装插件等于在本机运行第三方代码**，请只装你信任的包。
- 卸载内置 bundle、越权路径等操作在服务端被显式拒绝。
- 本应用不收集、不上传任何数据；AI 简介请求直连你填写的接口。

---

## 常见问题

**Q：双击 `启动.bat` 一闪而过？**
没有装 Node.js。装好 <https://nodejs.org/> 后重试；或在命令行里手动 `node server.js` 看报错。

**Q：点安装没反应 / 报「未检测到 pnpm」？**
dsh 安装插件依赖 pnpm。界面顶部出现黄色横幅时点 **安装 pnpm**，或自行 `npm i -g pnpm`。

**Q：安装成功但 dsh web 里看不到新插件？**
dsh 需要重启才会加载新插件。点右上角 **「⟲ 启动 / 重启 dsh web」**，或在**已安装管理**里确认插件是「已启用」。

**Q：顶部显示「dsh web 本体 未运行」？**
本应用不会自动拉起本体。点右上角 **「▶ 启动 dsh web」** 即可拉起（端口在**设置**里改，默认 3080）；运行后徽章变绿，点它可直接打开本体。

**Q：打开本体提示 `dsh web authentication required`（HTTP 401）？**
新版 dsh 给本体加了访问鉴权：根路径需要一次性 `?token=`（每次启动随机生成、只打印在 `dsh web` 控制台），访问成功后浏览器会种下一枚 **30 天**有效的 cookie。本应用在**自己启动本体时**会读取并记住那条带 token 的 URL，徽章链接直接可打开；若本体是在本应用之外启动的，则只能点普通链接——此时请复制 `dsh web` 控制台打印的带 `?token=` 的完整 URL 打开一次，之后普通链接即可用。

**Q：AI 简介报错？**
检查 **设置** 里的 API Key、Base URL、模型名。自定义端点须是 OpenAI 兼容的 `/chat/completions`。

**Q：端口 3210 被占用？**
用环境变量换一个端口启动（见上文「自定义端口」）。
