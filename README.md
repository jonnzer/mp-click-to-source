# mp-click-to-source

微信小程序开发期的 `Option/Alt + 点击` 源码定位工具，体验对齐 [`click-to-react-component`](https://github.com/ericclemmons/click-to-react-component)：

```text
按住 Option(mac) / Alt(win) + 移动鼠标  ->  模拟器里高亮当前元素
按住 Option(mac) / Alt(win) + 点击元素  ->  自动打开 VS Code/Cursor/WebStorm 到对应 .vue/WXML 行列
```

![mp-click-to-source 整体工作流](https://raw.githubusercontent.com/jonnzer/mp-click-to-source/main/assets/mp-click-to-source-workflow-illustrations/01-overall-workflow.png)

- **零依赖、零编译**：不依赖任何 npm 包；修饰键检测用系统自带命令（macOS `osascript` / Windows `powershell`），无需安装 Xcode 或其他工具
- **无感接入**：一行 `vue.config.js` 配置；不改业务源码、不用单独起服务（本机服务随编译进程自动启停）
- **生产安全**：production 构建下插件是空操作，产物零痕迹（见"生产隔离"）
- 支持 macOS 与 Windows、webpack4/5（HBuilderX 与 uni-app CLI 均可）

## 项目边界

这个仓库只负责“小程序元素 -> 源码位置”的开发工具链：编译期写入定位信息、运行期识别目标元素、本机服务校验修饰键并唤起编辑器。它不包含业务组件、接口、账号体系或特定项目配置，也不会修改业务源码。

## 环境要求

- Node.js >= 14
- 微信开发者工具（模拟器内使用）
- uni-app vue2/webpack 项目一行接入；其他 webpack 小程序构建可用通用插件；原生无构建链项目见下文 CLI

## 快速开始（uni-app / HBuilderX）

**1. 安装**

```bash
npm i -D mp-click-to-source
```

**2. 接入 `vue.config.js`（仅此一处改动）**

```js
const { withMpClickToSource } = require('mp-click-to-source/uni')

module.exports = withMpClickToSource({ /* 你原有的 vue config */ }, {
  root: __dirname,
  // editor: 'cursor',   // 默认 'code' (VS Code)
})
```

**3. 微信开发者工具设置**

`详情 -> 本地设置` 勾选：

```text
不校验合法域名、web-view、TLS 版本以及 HTTPS 证书
```

（小程序运行时需要访问本机 `http://127.0.0.1:17365`，仅本地开发，不需要配置微信后台域名）

**4. 运行**

正常启动开发编译（HBuilderX 运行 / `npm run dev:mp-weixin`）。编译日志出现：

```text
[mp-click-to-source] inspector server listening on http://127.0.0.1:17365 (editor: code)
```

即可在模拟器里按住 `Option`（Windows 为 `Alt`）使用。

## 使用说明（交互手感）

- **跳转源码**：按住修饰键点击任意元素，编辑器自动打开对应 `.vue`/WXML 的行列。
- **绝不拦截业务点击（纯旁观）**：工具只挂非阻塞的观察绑定，不 catch、不代理、不补发任何 tap——业务事件链与原生行为（`button open-type`、`form-type`、`navigator`、`picker` 等）100% 原样。因此按住修饰键点击时业务行为也会同时执行（如页面跳转）；建议在非交互元素上点击跳源码，或跳转后返回即可。
- **高亮跟随**：按住修饰键移动鼠标，当前元素显示渐变描边。
- **预热**（开发者工具的事件模型限制）：每个页面需要先**点一下任意位置**（修饰键+点击也算，不会触发业务），之后仅按修饰键移动即为像素级跟随；未预热时按"进入元素"粒度跟随。切换页面后需重新预热一次。
- **按住修饰键拖动不会滚动页面**：拖动被工具接管用于连续跟随；要滚动页面就松开修饰键，滚动行为与未装工具时完全一致。
- 鼠标停在页面空白处不会高亮整页容器；页面滚动时描边先隐藏、停止后重新吸附。
- 高亮框默认不显示 `文件:行:列` 文字标签，需要时开启 `runtime: { overlayLabel: true }`。

## 配置项

`withMpClickToSource(vueConfig, options)` / `createMpClickToSourceWebpackPlugin(options)`：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `UNI_INPUT_DIR` 或 `process.cwd()` | 项目根目录，建议显式传 `__dirname` |
| `enabled` | mp-weixin 平台且非 production | 显式开关；传布尔值时跳过自动判断 |
| `platforms` | `['mp-weixin']` | 自动判断时允许的平台列表（仅 `withMpClickToSource`） |
| `editor` | `code` | `code` / `cursor` / `webstorm`；也可用环境变量 `MP_CLICK_TO_SOURCE_EDITOR` |
| `modifier` | `option` | `option` / `cmd` / `shift` / `control` / `none`；Windows 上 `option`=Alt、`cmd`=Win |
| `port` / `host` | `17365` / `127.0.0.1` | 本机服务地址（多项目同时开发时给其中一个换端口） |
| `server` | `true` | `false` 则不自动起服务（改用 CLI 手动跑） |
| `injectRuntime` | `true` | `false` 则不注入运行时（自行在入口 require） |
| `injectOverlay` | `true` | 是否向模板追加高亮 overlay 节点 |
| `transformVue` | `true` | 预处理 `.vue` 模板以获得真实源码行号 |
| `trigger` | `option-click` | `option-click` / `longpress` / `tap` / `both` |
| `runtime` | `{}` | 透传给小程序运行时的配置，见下 |

`runtime` 常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `overlayLabel` | `false` | 高亮框上显示 `文件:行:列` 标签 |
| `hover` | `true` | 关闭后仅保留点击跳转 |
| `hoverThrottleMs` / `rectCacheTtl` | `48` / `500` | hover 节流与元素矩形缓存时长（毫秒） |
| `devtoolsOnly` | `true` | 真机（ios/android/ohos）自动禁用 |

## 生产隔离

1. `withMpClickToSource` 在 production（或平台不匹配）时**原样返回配置**，插件不会被创建；
2. 插件内部第二道 `NODE_ENV` 校验，production 下 `apply()` 为空函数：不转换模板、不注入运行时、不起服务；
3. 业务源码零引用：运行时是编译期内联进开发产物的文本，不在模块依赖图里，发行构建产物零痕迹。

发布前可自检（可挂 CI）：

```bash
grep -rl "mpCodeInspector\|data-code-loc" <发行产物目录> && echo "发现调试代码!" || echo "干净"
```

## 通用 Webpack 项目

```js
const { createMpClickToSourceWebpackPlugin } = require('mp-click-to-source')

module.exports = {
  plugins: [
    createMpClickToSourceWebpackPlugin({ root: process.cwd() })
  ]
}
```

## 原生小程序（无构建链）

```bash
# 把项目转换到开发专用目录，用开发者工具打开输出目录
npx mp-click-to-source rewrite /path/to/miniprogram /path/to/miniprogram-inspector
# 手动起本机服务
npx mp-click-to-source server --root /path/to/miniprogram --editor code --modifier option
```

## 排查

小程序控制台：

```js
wx.__mpClickToSource                     // undefined => 跑的是未注入的旧产物
wx.__mpClickToSource.isServerOnline()    // false => 本机服务没起来（编译进程是否还在？）
wx.__mpClickToSource.isModifierActive()  // 按住修饰键时应为 true
wx.__mpClickToSource.getDebugInfo()      // 全链路状态
```

`getDebugInfo()` 字段含义：`hoverEvents` 为 0 = 事件未派发（产物旧/未预热）；`modifierActive` 恒 false = 修饰键检测或服务问题；`lastRectCount` 为 0 = 元素矩形查询失败；`renders` > 0 仍无边框 = overlay 渲染问题；`lastError` = 捕获到的异常。

常见问题：

- **点击不跳编辑器**：确认 `code`/`cursor` CLI 在 PATH（VS Code 安装时勾选 "Add to PATH"）；先用 `--modifier none` 验证打开编辑器链路。
- **修饰键检测不到**：macOS 个别情况需给运行编译的应用授权"输入监控"；Windows 确认 PowerShell 未被管控禁用。
- **升级工具后行为没变**：插件代码缓存在编译进程里，需**重启**开发编译任务（不能只靠增量编译）；同时确认没有旧版本的手动 server 进程占着端口。

## 实现原理

整条链路分为编译期、小程序运行期和本机服务三部分。定位信息只进入开发产物，编辑器调用只发生在本机。

### 1. 编译期注入

`.vue` 预处理阶段注入带真实行列的 `data-code-loc`。WXML 产物阶段补充观察事件、`mpcts-target` class 和 overlay 节点，同时把小程序运行时内联到 `app.js` 产物头部。插件随编译进程幂等启动本机服务，业务源码不需要引用运行时。

![编译期注入](https://raw.githubusercontent.com/jonnzer/mp-click-to-source/main/assets/mp-click-to-source-workflow-illustrations/02-compile-time-injection.png)

### 2. 运行期命中

运行时 patch `Page`/`Component`，注入只观察、不吞掉业务 tap 的方法。修饰键状态通过长轮询同步；hover 根据指针坐标、元素矩形缓存和最小面积规则确定最精确的目标。按住修饰键拖动时，条件 `catchtouchmove` 会暂时接管移动事件以连续更新高亮，但不会接管点击。

![运行期高亮与点击](https://raw.githubusercontent.com/jonnzer/mp-click-to-source/main/assets/mp-click-to-source-workflow-illustrations/03-runtime-hover-tap.png)

### 3. 本机服务打开源码

本机服务只监听 `127.0.0.1`，提供三个端点：`/modifier` 同步修饰键状态，`/open` 校验并打开源码位置，`/health` 返回服务状态。修饰键检测使用 macOS `osascript` 或 Windows PowerShell；编辑器通过 CLI 或文件 URL 打开 `file:line:column`。

![本机服务打开编辑器](https://raw.githubusercontent.com/jonnzer/mp-click-to-source/main/assets/mp-click-to-source-workflow-illustrations/04-local-server-editor.png)

## 本地开发

项目没有运行时 npm 依赖。测试套件使用 Node.js 18 及以上版本；修改代码后执行：

```bash
npm test
npm pack --dry-run
```

测试覆盖模板转换、Vue SFC 行号、webpack4/5 注入、运行时命中、本机服务、编辑器命令和生产隔离。贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
