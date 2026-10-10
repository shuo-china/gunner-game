# Forest Gunner — 第一版

参考 Cat Gunner 的竖屏微信小游戏原型：一只猫、一把基础手枪、一张地图、30 棵可受伤的树。角色自动寻找树木、移动、瞄准和开火。普通关卡使用原版 HUD，击败树木会爆出纸钞、显示奖励并累计金币；清场后可重开。

## 打开与试玩

- 引擎固定为 **Cocos Creator 3.8.8**：`E:\CocosEditors\Creator\3.8.8\CocosCreator.exe`。原有 3.8.2 保留。
- 用 Creator 3.8.8 打开本目录，主场景为 `assets/scenes/main.scene`。
- 双击 `启动试玩.cmd`：先构建 Web 版本，再打开竖屏试玩页 `http://127.0.0.1:7457/play`。宽浏览器窗口会自动留出深色侧边；窄屏会铺满可用宽度。需要 PATH 中有 Node.js；本机已安装。
- `http://127.0.0.1:7457/` 保留为真实游戏入口；`/play` 仅用竖屏 iframe 展示该入口。
- 试玩窗口对应的命令行窗口保持运行，按 `Ctrl+C` 停止服务器。修改源码或美术后需重新构建，浏览器刷新即可读取新产物。

也可在本目录运行：

```powershell
# 默认顺序构建 Web 和微信小游戏
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build.ps1

# 只构建一个平台
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build.ps1 -Platform web
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build.ps1 -Platform wechat

# 已构建后启动本地服务；端口冲突时可追加 --port 7458
node .\tools\serve.cjs --open
```

构建配置是 `build-web.json`、`build-wechat.json`；产物位于 `build/web-mobile` 和 `build/wechatgame`。构建日志统一写入 `E:\gunner\AI-Workspace\Work\v1\logs`。Creator 官方 CLI 的成功退出码是 36，工具也兼容退出码 0，并检查入口文件是否生成。

## 测试与正式环境

使用 `FOREST_GUNNER_ENV` 环境变量选择 `test` 或 `production`，也可给构建命令传入 `-Environment`。优先级为：显式参数、环境变量、默认 `production`。取值区分大小写，非法值会在启动 Creator 前报错。环境选择独立于构建配置的 `debug`，微信压缩构建也能运行测试环境。

```powershell
# 测试构建：Web 和微信都生效
$env:FOREST_GUNNER_ENV = 'test'
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build.ps1

# 显式参数覆盖环境变量，构建正式微信包
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build.ps1 -Platform wechat -Environment production

# 清除本终端环境变量，恢复普通构建默认值
Remove-Item Env:FOREST_GUNNER_ENV -ErrorAction SilentlyContinue
```

双击 `启动试玩.cmd` 时，未设置环境变量则默认 `test`；已有值会保留。Creator 内置预览默认使用测试环境。测试环境每次启动补满金币，升级照常扣费；局内重开不会再次补满。测试与正式环境使用独立的本地存档，正式存档不会读入测试余额与升级进度。

`tools/build.ps1` 在构建完成后把环境写入 Web 的 `index.html` 或微信的 `game.js`，输出 `Forest Gunner environment: test/production` 验证信息。入口内的 `FOREST_GUNNER_ENV_START` 标记便于检查产物。环境在构建时固定，单独重启 `serve.cjs` 或更改终端变量不会改变既有产物；需要重新构建。直接从 Creator 构建面板生成、未经过该脚本的包默认使用正式环境。

## 微信开发者工具

将 `build/wechatgame` 导入微信开发者工具，项目类型选择小游戏。当前使用本机微信开发者工具“测试号”入口实际提供的 AppID `wx2af23eaa33e48d81`，已成功导入并运行。引擎文档中的示例 AppID `wx6ac3f5090a6b99c5` 被当前账号拒绝，不能当作通用可用身份。关联自己的小游戏时修改 `build-wechat.json` 中的 `packages.wechatgame.appid`，然后重新构建。

浏览器试玩与微信环境不同。微信产物使用压缩脚本且不包含 source maps；Web 保留调试信息。第二轮已完成 Web 与微信构建，浏览器真实组件五轮加速清场检查通过，微信工具也已实际运行。完整结果、最终包体和仍未验证的部分见 `E:\gunner\AI-Workspace\Reports\首版架构与验收.md`。本次没有手机扫码、上传或发布。

最新画面修正包括：猫与枪的正确翻转、双手和脸部跟随、原后坐力与枪口粒子；树木原版压缩回弹和血条；原图持续旋转准星；第一关地面平铺、边界、光照与相机偏移。子弹和命中补齐六个原粒子系统，数字使用原位图字体与曲线。原参数和随机规则已转入工程，跨引擎粒子内部积分及逐像素一致性仍有边界，详见验收记录。

第六轮已继续按原版代码和序列化资源逐项审计现有功能，修正人物 Update/Attack 与 Animator/后坐的先后、撤退脸角、子弹池与生命周期、墙面命中、拖尾及飘字/树回弹；地面改用原始平面和独立 Repeat 纹理，并修正相机清屏色和 renderScale 尺寸取整。发射点仍按原40° CamDir换算到Y=2，保留原版与可见枪口的微小偏差。逐项状态、源码证据和本轮验证记录见 `E:\gunner\AI-Workspace\Reports\首版架构与验收.md` 第六轮；历史轮次的测试和构建数字不作为本轮验收数字。

维护重构后124项测试与整工程类型检查通过，已启用 `noUnusedLocals` / `noUnusedParameters`，Web/微信构建成功。浏览器真实组件五轮清场的战斗统计和帧数保持第六轮结果；另外验证了暂停期间不重复重绘、组件销毁重建和父节点销毁时的资源释放。最新验收与证据见架构报告末尾“维护重构”节。微信真机、性能及剩余引擎差异仍单列，不能据此认定严格逐帧或逐像素1:1。

## 代码与资源

| 目录/文件 | 用途 |
| --- | --- |
| `assets/scripts/core` | 不依赖 Creator 的战斗模拟、每画面帧角色逻辑、独立物理步长、地图、目标搜索、移动和子弹命中 |
| `assets/scripts/view` | Creator 节点、美术加载、人物动画、地面与战斗反馈 |
| `assets/scripts/core/config.ts` | 首版战斗数值与场景参数 |
| `assets/resources/art` | 首版使用的原版图片、资源清单及人物骨骼动画数据 |
| `tools` | 本地构建和试玩工具 |

逻辑坐标保留原版 Unity 的 XZ 地面语义，画面投影与碰撞/血量分开。射线候选、攻击锁与自动移动目标分别保存，再按原版优先级组合；角色可以边走边开枪。子弹使用原27槽循环对象池，优先借用未激活对象，其次回收已死亡但尚有尾迹的对象；打树结算伤害，打墙只产生命中特效，树木死亡只计数一次。

移动和索敌按原 `Cat.Update / ResolveAttackTarget / HandleAutoMove` 核对。普通森林模式每0.3秒重新评估移动目标，有效且在射程内的自动目标会接管攻击，因此原版本身允许树尚未死亡时切换。每个画面帧先消费原约50Hz物理步，再执行一次角色逻辑。手/脸依据此前已写入的骨骼更新，Attack 翻向后取枪口；后坐协程和 Normal Animator 在其后更新用于绘制的变换。详细移动规则与当轮运行数据见验收报告第五轮，第六轮补充动画时序与其他现有功能的核对。

美术替换流程见 `ART-GUIDE.md`。业务逻辑通过资源 ID 和挂点使用外观，不应在战斗代码里引用图片路径。

## 维护约定

- 核心逻辑继续独立于 Creator；动画曲线、粒子和反馈配置使用明确类型。维护时保留索敌优先级、物理/帧时钟及随机调用顺序，不以清除类型错误为由放宽为 `any`。
- `ArtLibrary` 缓存并合并同路径 SpriteFrame 加载请求。资源系统加载的图片由各视图共享，销毁单个视图时不销毁共享资源；代码创建的材质、RenderTexture 和对应 SpriteFrame 则由创建者释放。
- `GameBootstrap` 限制同一 Canvas 上重复挂载；异步加载、构造失败、组件先销毁及父 Canvas 销毁都须能清理已有对象、事件和本实例调试接口。Cocos 销毁延后执行，检查资源是否失效要等待销毁队列完成。
- 高频更新复用动画/粒子缓冲及预先分组的数据；带输出缓冲的结果如需长期保存，应另存快照。树木仅在 XZ 位置变化时重算投影，改动布局时仍需更新逻辑位置。
- HUD 进度仅在数值变化时重绘，重开时恢复缓存及显示状态。未使用的 `leaf` 已移出运行资源和清单，原图、导入信息和清单项保存在 `AI-Workspace/Work/v1/art-reference/unused-leaf`，导入工具也不再导出它。

本轮没有清理历史原版证据或生成缓存。`build`、`library`、`temp` 是生成目录，不应作为源码修改入口；维护前备份为 `AI-Workspace/Work/v1/backups/before-maintenance-20261010.zip`（这两个 `AI-Workspace` 路径相对于仓库根目录）。

## 检查与当前边界

```powershell
npm test
```

纯逻辑测试位于相邻的 `AI-Workspace/Work/v1/tests`。测试覆盖范围和实测结果记录在架构与验收报告；测试通过不等于微信真机、画面还原和全部动画已通过验收。

本版包含原版三项升级、金币收入与消费、本地经济存档；不包含多角色编队、宠物、其他枪型、转生、广告、支付、账号、联网和正式发布流程。原版分析资料保留在 `E:\gunner\CatGunner-Original`，原版素材不在本项目里直接改写。

## 原版关卡 HUD 与奖励

关卡界面使用原版顶部完成条/时间条、五节点关卡线与猫头像、设置图标、金币和钻石，底部为“攻击力／攻击速度／金币获取”。当前仍是单关 `Stage 1-1`；五节点不会随本局击杀数假装推进，顶部百分比才表示本局清理进度。180秒倒计时随战斗暂停，归零后继续战斗，清场后冻结。设置图标暂不响应。

`BattleSession` 管理当前模式、钱包、升级和经济存档，`GameHud` 根据状态挂载独立的 `Main_UI` 与底部 `Upgrade_List`。切到其他模式时卸载关卡 UI 并清理临时战斗效果；尚未实现其他玩法，也没有对外的模式切换入口。Web 调试接口 `__forestGunner.setMode('Mine' | 'SpeedRun' | 'Main' | 'Boss' | 'Monster' | 'Raid')` 和 `upgrade('power' | 'speed' | 'money')` 仅用于验收，微信发布构建不包含该接口。

首关两种普通树的基础奖励为20、36金币，乘以当前“金币获取”百分比即时入账，保留小数，均爆出5个原版绿色纸钞粒子。纸钞从树根上方发射，奖励飘字从树根显示原版钞票图标及绿色数字。表现池、飘字冷却与余额独立，奖励不依赖动画完成或文本显示。金币和三个等级在重开、关闭或刷新后保留，钻石暂为0。最后一棵树的奖励效果播完后才弹出清场卡片。

三项升级独立从 Lv.0 到 Lv.10000。初始数值均为100、价格50；价格采用原版逐级递推与截断，前六档为50、68、95、131、181、249，不使用幂函数替代。金币没有人为余额上限，使用十进制大数保存；显示缩写不改变可消费余额。攻击升级只影响新发射的子弹，攻速影响冷却和散布，原版冷却范围为0.05–2秒。升级时保留已累计攻击计时并重置散布。

底部卡片使用原版图片、中文标题字形和数字字体，支持单击和长按（延迟0.4秒、重复间隔0.1秒）。余额不足显示红色价格与向上填充，满级显示Max；切后台、取消触摸和结算遮罩会取消连升。正常与测试环境使用独立的本地存档键；测试启动只补足三项从零升满的预算，不会降低更高余额，也不会对后续收入封顶。

源码新增 `assets/scripts/session`，美术分别位于 `art/hud`、`art/effects/money-burst` 和 `art/effects/money-numbers`；原版字体裁成约27KB的ASCII字符子集。原版参数、提取脚本和跨引擎粒子/文字渲染边界见 `ART-GUIDE.md`。引擎配置已启用 HUD 裁切所需的 `mask` 模块。
