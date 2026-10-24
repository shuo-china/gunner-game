# TapTap 创意工坊 H5 发行

目标应用 `997859`，MiniApp ID `tapmcg8evaubisjmzc`；客户端渠道 `taptap-h5`，PHP 身份提供方 `taptap_mini`。生产 API 为 `https://nurse.kylinsit.com/game/v1`。

当前上传文件使用 [去除 Cocos 启动页的完整游戏 ZIP](../../AI-Workspace/Work/v1/taptap-h5-20261024/delivery/no-cocos-splash-v3/forest-gunner-taptap-h5.zip)。[登录检测 ZIP](../../AI-Workspace/Work/v1/taptap-h5-20261024/delivery/upload-layout-v2/taptap-h5-login-probe.zip) 和 PHP 增量包不变。`delivery` 根目录及 `upload-layout-v2` 的旧游戏 ZIP 仅保留作历史记录。

本次提供的 TapTap H5 上传页面截图要求：**ZIP 不超过 300 MB，解压后只有一个文件夹，该文件夹内包含 `index.html`**。游戏入口为 `taptap-h5/index.html`，检测入口为 `taptap-h5-probe/index.html`。此前“ZIP 根目录直接放 index.html”的说明已更正。

游戏包保留游戏自己的加载画面，关闭 Cocos 默认图标页和其 2 秒等待。当前包大小、文件清单及校验值见 [本次交付目录](../../AI-Workspace/Work/v1/taptap-h5-20261024/delivery/no-cocos-splash-v3/README.md)。接口配置与 PHP 保持不变，已部署的 PHP 无需因本次启动页调整而重复更新。

## 发布前置条件

本轮完成客户端、PHP 接口和本地验证，尚未取得目标 H5 宿主的真实登录凭证。必须先在该应用的 TapTap H5 测试版本验证 `tap.login → PHP code2Session → Bearer`。普通浏览器缺少 `tap.login` 时停留在登录重试页；这不等于证明 TapTap H5 不支持。

若真实宿主没有 `tap.login`，或生成的凭证不能由指定 MiniApp 验证，应停止上线并报告阻断。不得自行改为扫码登录、原生 SDK 或 Tap 小游戏包体。独立诊断包只用于测试版本，不替代正式游戏。

## 登录与游戏行为

- 引擎启动前显式注入 `taptap-h5` 和 `production`，不根据浏览器中偶然存在的 `wx` 判断渠道。
- 每次获取宿主凭证时重新读取 `tap`，允许宿主延迟注入后点击重试。`tap.login` 使用官方回调形式，凭证请求只发送 `{code}`。
- H5 使用浏览器 XHR、JSON 和 Bearer；令牌只在内存中，网络请求不携带跨站 Cookie。取消或超时后的迟到回调不会改变当前会话。
- 后台返回的 provider、MiniApp ID 和玩家 ID 必须匹配。失效会话重登，账号切换阻止旧账号继续写档并保留待同步记录。
- 生产账号复用既有云存档、版本冲突选择、断网补传、签到、离线收益和兑换码。微信与 TapTap 拥有独立玩家 ID；不复制游客或微信存档。
- TapTap H5 的广告配置强制关闭，分享 provider 不可用，相关领奖入口隐藏。PHP 同时拒绝 TapTap 分享领奖，保留当前 `dailyShare` 存档字段和既有经济数值。

## 重建与打包

在 `Project` 目录中，使用 Node.js 20+ 和 Cocos Creator 3.8.8：

```powershell
npm ci
npm run check
& tools/build.ps1 -Platform taptap-h5 -Environment production
& tools/package-taptap-h5.ps1 -Build .\build\taptap-h5 -Destination E:\release\taptap-h5-new
```

首次使用需先通过 Creator 导入项目，生成引擎类型声明；可通过 `-EnginePath` 指定 Creator 3.8.8 可执行文件。H5 构建目标拒绝 test 环境，默认 `all` 构建仍保持原 web + wechat 行为。

`build-taptap-h5.json` 使用 web-mobile、720×1280 竖屏，关闭 debug/sourceMaps，所有资源均位于本地 bundle。H5 不执行源资源删除去重，不使用微信分包或远程资源目录。运行期业务请求仍需要网络。

TapTap 专用构建步骤 `tools/disable-taptap-splash.cjs` 将生成设置中的 `splashScreen.totalTime` 设为 `0`、`logo.type` 设为 `none`，并更新设置、应用启动脚本和入口脚本的 MD5 文件名及引用。Creator 3.8.8 在本机命令行构建中未采用对应的构建配置，故在生成文件后处理；发布检查会拒绝仍开启默认图标页的包。该步骤只用于 `taptap-h5`，不修改微信或普通 Web 构建。

打包目标目录必须不存在。脚本检查入口、首个脚本中的环境及渠道、Creator 设置、本地资源引用、生产 API 和 MiniApp ID、源码映射及敏感配置文件；生成 ZIP、逐文件 SHA-256 清单和 ZIP 校验值，再解压到 `verified-h5/taptap-h5` 重新逐文件核验。游戏 ZIP 的顶层只有 `taptap-h5` 文件夹，入口是该文件夹内的 `index.html`。上传时直接选择修正版 ZIP，不要重新压缩整个交付目录，也不要去掉这一层文件夹。

`verified-h5/taptap-h5` 是从实际 ZIP 解压的游戏副本，不需要单独上传。本次版本位于 `delivery/no-cocos-splash-v3/verified-h5/taptap-h5`。启动新打包目录的本地静态预览：

```powershell
node tools/serve.cjs --root E:\release\taptap-h5-new\verified-h5\taptap-h5 --port 7457
```

普通浏览器预期停在“请在 TapTap 内打开并重试”提示；不能通过改成 web 渠道绕过登录验收。

## 部署与验收

1. 备份服务器六个 PHP 增量源文件，按后台 `docs/TapTap-H5接入.md` 覆盖到现有 PHP 根目录；不要将整个交付目录上传到 public。
2. 在服务器原 `.env` 追加 `[GAME_TAPTAP]`、指定 MiniApp ID 和其 Secret，保留微信、数据库和原管理后台配置。通用 Client ID/Server Secret 不参与本链路。清理配置/路由缓存及 OPcache，确认原后台仍可用。
3. 将诊断 ZIP 上传到应用 `997859` 的 H5 测试版本，真机核验宿主登录、后台身份、会话注销；通过后再上传游戏 H5 ZIP。
4. 在正式游戏的测试版本验收首次登录、重启恢复、账号切换、微信隔离、断网补传、两设备冲突、签到/离线/兑换码及重复领取。
5. 真实设备检查实际 Origin 的跨域预检、成功及错误响应，以及切后台保存、恢复同步、竖屏触摸和音频恢复。全部通过后再正式发布。

没有新增业务表或旧档迁移。增量包依赖已部署的现有登录/存档/奖励后端及 Node 奖励运行文件；不包含 vendor。回滚恢复备份源文件和原 H5 版本，保留已产生的玩家与存档数据。

## 验证边界与依据

客户端自动化使用模拟宿主和 HTTP 响应；PHP 集成使用本机隔离数据库和测试专用上游。它们验证协议、状态机、存档与奖励逻辑，不证明平台凭据已经可用。具体测试数量、包大小和截图以本次交付目录中的验证记录为准。

每次交付的浏览器报告只对应当次 ZIP。最新启动页修改的检查见 `no-cocos-splash-v3/verification`；旧版模拟业务和生命周期验证保留在原目录，不代表新包已经通过 TapTap 真机验收。

官方依据：[形态说明](https://developer.taptap.cn/agents/)、[tap.login 回调协议](https://developer.taptap.cn/minigameapidoc/dev/api/open-api/login/tap.login/)、[code2Session 服务端接口](https://developer.taptap.cn/minigameapidoc/dev/server/login/code2Session/)。小游戏登录协议本身不构成该 H5 应用宿主支持的证明。
