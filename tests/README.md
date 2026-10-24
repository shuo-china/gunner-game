# 回归测试

2026-10-23 **0.1.48 发布验收完成**：基于已验证 0.1.47 快照叠加后端奖励与当前地图闭包，2077 项测试全部通过，类型检查及微信 production 构建通过；直接加载实际压缩产物执行奖励与云存档回归 52/52。上传前后核验 1613 项导入、564 项原生资源映射、6 项故障回退及全部文件 SHA；70 个实际地图图片引用均在服务器资源与微信分包内。主包与 74 个分包满足大小限制，三个部署 ZIP 完整性通过。微信开发版 0.1.48 已上传，服务器和数据库未部署，未做手机真机验收。见[发布记录](../../AI-Workspace/Deliveries/backend-rewards-20261023-ready/release-provenance.json)和[证据目录](../../AI-Workspace/Deliveries/backend-rewards-20261023-ready/evidence)。下列后端奖励接入记录保留当时状态，其中地图并行修改造成的 3 项失败已在本次发布快照解决。

2026-10-23 后端奖励核验：离线、签到、兑换码及云存档/登录/UI/启动相关 344 项定向测试通过，另补 2 项奖励记录冲突恢复回归均通过；类型检查通过。PHP 奖励 62、云存档 29、登录 46 项全部通过，含真实 MySQL、HTTP、跨进程单次码争抢及丢响应恢复。见 [客户端定向日志](../../AI-Workspace/Work/v1/backend-rewards-targeted-final.log)、[后端奖励日志](../../AI-Workspace/Work/v1/backend-rewards-20261023/rewards-test.log)。本轮 `npm run check` 共 2067 项、2064 通过、3 失败，失败集中在工作区同步进行的地图改动（`MapBorderGeometry` 测试依赖、矿山地面、arena 原点布局），未修改这些地图文件；见 [全量日志](../../AI-Workspace/Work/v1/backend-rewards-check-final.log)。未构建发布客户端或部署生产数据库。

2026-10-23 钻石经济调整：挑战/BOSS首关、矿山与七日签到采用原版2倍基数；挑战和BOSS按各自关数每关增加首关金额的10%。`npm run check` 1936项通过、0失败、0跳过，完整类型检查通过。新增配置比例、逐关线性金额、取整、已完成关数与下一关隔离、旧档恢复、广告取消/失败/重复回调及钱包上限回归，并更新真实HUD与新手购买流程的金额断言。见 [检查日志](../../AI-Workspace/Work/v1/logs/diamond-growth-20261023-check-final.log)。 Web/微信 production 构建通过，已同步本地运行目录；直接执行两端构建产物中的奖励模块，核验第1、2、10、11、100关及签到、矿山配置。见 [构建日志](../../AI-Workspace/Work/v1/diamond-growth-20261023/build.log) 和 [产物校验](../../AI-Workspace/Work/v1/diamond-growth-20261023/verification.json)。默认Web旧引擎文件存在访问错误，现通过内容一致的新文件名及导入映射加载；未删除旧文件。构建脚本清理的12张未引用素材及元数据已恢复并核对哈希。本次未上传微信开发版，未做手机真机或真实广告SDK验收。

在项目根目录安装依赖并运行：

```sh
npm ci
npm test
npm run typecheck
npm run check
```

需要 Node.js 20 或以上版本。TypeScript 固定为 5.8.2，与本项目 Creator 3.8.8 使用的版本一致；`package-lock.json` 锁定安装内容。

- `npm test` 自动发现本目录所有 `*.test.cjs`，每次先清空本目录的 `.build` 再编译。无需安装 Creator，也无需原版反编译目录或 AI 工作区。
- `npm run typecheck` 检查完整游戏工程。第一次需用 Creator 3.8.8 打开项目，生成 `temp/tsconfig.cocos.json` 和引擎声明；缺失时命令会明确报错。
- `npm run check` 依次执行回归测试和完整工程类型检查，任一步失败都会返回非零退出码。
- 如需定位单项测试，可使用 `npm test -- --test-name-pattern="关键词"`；正常验收应运行全部测试。

测试覆盖纯逻辑及使用轻量 Cocos 替身的视图和入口行为。它们不代替 Creator 构建、Web/微信运行或真机视觉验收。`runtime-environment.test.cjs` 的 PowerShell 构建参数测试只在 Windows 上运行，其他平台会明确显示该项跳过。

2026-10-19 宠物/旅行故障回归：`npm run check` 1914 项通过、0 失败、0 跳过，类型检查通过，Web/微信 production 构建成功。新增 7 项回归在修复前均失败，覆盖 Creator 宽松数组展开下的 19 格派遣锁、同数量换锁、拖拽目标高亮、入口旧指针取消，以及故障旧档备份、行程恢复、单次退券和备份失败保护。`support/loose-array-spread.cjs` 重现发布构建的 `[].concat(set)` 语义，不能仅用保留原生展开的 ES2018 测试替代。

保持正式 Web 主循环运行完成 46 个交互/状态检查：两种货币抽宠物、手动/自动合成、装备/卸下、详情、派遣/取消/到期领奖、装备旅行锁及重载、四色核心单抽、最大抽取/翻页、碎片升级，以及 360×640、390×844、412×915 跨帧点击。控制台运行错误为零，测试前浏览器存档已恢复。行程到期和固定抽取结果使用明确测试夹具；当前浏览器不支持 CDP 原生触摸派发，因此实际交互为鼠标点击/拖拽，不代表微信真机或真实广告验收。未上传或发布。证据见[运行报告](../../AI-Workspace/Work/v1/pet-adventure-audit-20261019/runtime-report.json)、[全量检查](../../AI-Workspace/Work/v1/pet-adventure-audit-20261019/check.log)及[双端构建](../../AI-Workspace/Work/v1/pet-adventure-audit-20261019/build.log)。

## 当前加载与界面调度回归

当前统一注册表将下载、解析和可交互界面准备分开。启动时准备全部已解锁必需主面板，首次启动以 10 秒、已有启动标记以 3 秒作为诊断目标；核心或必需面板未就绪不能放行，隐藏期间不能发布可交互状态。所有依赖完成且处于前台时自动进入，无需点击开始；超时继续等待，失败重试复用原有资源和界面。启动标记不代表缓存命中，实际设备总耗时仍需微信真机验证。

已锁定重资源、全部地图、全部皮肤与宠物外观不再自动下载。图鉴排除 4 张独占图片并用虚拟卡片池准备首屏，主面板完成后后台准备，显式打开接入同一个模块任务。下载调度独立于忙帧退让；每个满足负载许可的帧共享 1 毫秒 UI 预算，完成的面板优先提交且每帧最多一个提交，剩余预算继续构造。资源解析独立按 32 毫秒节流，不再挤占隔帧的 UI 准入。持续 1 秒无进展时仅允许一个小步骤，单个不可分割引擎调用仍可能超时。

| 测试 | 当前重点 |
| --- | --- |
| `resource-module-manager.test.cjs` | 资源与界面就绪独立、重复请求合并、点击提权和依赖、失败重试、代次检查、关闭界面失效重建，以及持久化状态默认 unknown |
| `startup-preparation-budget.test.cjs` | 从入口时间计算预算、首次/返回 10 秒和 3 秒、核心与必需面板门控、隐藏不放行，以及超时继续等待全部就绪 |
| `background-resources.test.cjs` | 全部已解锁主面板、未解锁重资源排除、武器主面板/图鉴依赖边界、下载和解析分离、需求提权、回收后停止自动重建，以及共享纹理去重 |
| `background-preparation-scheduler.test.cjs`、`ui-preparation-queue.test.cjs` | 忙帧退让、1 秒有界防饥饿、单步准入、构造/布局/提交由 tick 推进，以及每 tick 最多一个 commit |
| `maintenance-view.test.cjs`、`bootstrap-upgrades.test.cjs` | 真实 update 推进初始化，首屏数据绑定后才 viewReady，启动输入屏障，预算超时后的原任务复用，后台/销毁取消显示，以及内存警告保留当前界面、入口与在途共享纹理 |
| `art-library-cache.test.cjs`、`game-resource-loader.test.cjs` | 动态资源引用计数、独占帧释放、失效缓存重载、迟到结果不能污染新代次、实际缓存文件检查与缺失索引区分 |
| `weapon-hud.test.cjs` | 背包先就绪、图鉴虚拟池复用、后台/前台同任务、滚动换绑与取消陈旧点击、关闭/销毁防迟到显示、释放后重新加载 |
| `battle-resource-loading.test.cjs`、`skin-color-pipeline.test.cjs` | 下一关逐项准备与入关复用、后台模式控制，以及隐藏面板不分配全屏渲染纹理和场景统一释放 |
| `loading-performance-trace.test.cjs` | 有界帧/阶段事件缓存、顺序、快照隔离及非法时长处理 |

集成测试中的等待必须推进真实 `app.update` 或 `UiPreparationQueue.tick`，并在 tick 之间让 Promise 续体运行。`maintenance-view` 默认启动夹具推进真实初始化队列；`deferHiddenHuds` 明确模拟核心加载已经耗尽预算、界面留待后台的情况，`manualStartup` 由测试自己驱动时间和帧。`drainPreparation` 仅为与战斗无关的旧玩法夹具逐 tick 等待；调度和生命周期用例直接推进游戏更新。不要用同步清空队列、直接执行全部 generator 或自动完成所有 Promise 的替身掩盖跨帧边界。

对照模式由 `ResourceLoadingPolicy.preparationMode` 控制：`download-only` 只下载，`decode` 进一步解析已解锁面板，`full` 继续创建隐藏 HUD。显式点击和必要弹窗不受对照模式阻断。模式不会取消已发出的引擎请求或清掉已加载资源，设备对照需保持场景、版本和初始缓存一致并分别重新启动。

`__forestGunnerLoading.snapshot()` 的 `modules`、`uiReady`、`startup`、`timings.resources.cache.files` 和 `trace` 分别提供模块状态、绑定完成状态、启动预算、真实文件存在检查和 CPU 阶段证据。未核验的模块持久化保持 `unknown`；缓存索引数不等于文件存在数。解析计时包含异步等待，不能直接推断 GPU 上传/执行或 GC；节点替身和桌面浏览器不能代替微信真机耗时、帧率和内存验收。

## 历史验证记录

2026-10-16 此前界面分帧版本源码回归 1679 项及完整类型检查、Web `test` 和微信 `production` 构建通过。三种模式完成 98 个浏览器检查点、36 次面板打开，页面、控制台和资源错误为零；共享纹理最多两张，退出场景归零。补充自然后台准备采样验证三个常用面板依次提交，低频面板与图鉴不自动构建；三次提交前后各两秒均未出现超过 40 毫秒的帧。微信 0.1.25 已上传开发版本，上传前后各 14 项包校验通过，未提交审核或发布。见 [本轮验证记录](../../AI-Workspace/Work/v1/ui-loading-smoothness-20261016/verification.json) 和 [运行汇总](../../AI-Workspace/Work/v1/ui-loading-smoothness-20261016/summary.json)。浏览器使用隔离桌面 Chromium / SwiftShader，不代表微信真机帧率、首开耗时和内存已验收，也没有测得优化前后提速比例。

2026-10-16 上一轮后台预加载调度优化：`npm run check` 1646 项通过、0 失败、0 跳过，完整类型检查通过。该轮新增回归覆盖启动缓冲、慢帧与游戏更新耗时退让、连续稳定帧恢复、30 帧设备、切回前台不集中补派发、图片解析与预取共用派发上限、同步失败限流，以及游戏更新优先、界面创建与资源派发错峰、前台点击绕过后台冷却且不推进其他隐藏界面。原有缓存复用、失败重试、相机占用、离线弹窗和场景销毁回归保持通过。见 [检查日志](../../AI-Workspace/Work/v1/preload-scheduling-check.log)。该轮未构建或上传新包，也未进行手机帧率实测。

2026-10-16 安全区适配修复：`npm run check` 1527项通过、0失败、0跳过，完整类型检查通过。新增20项回归覆盖微信新旧接口、窗口偏移、DPR、缺失/畸形数据、异常上下边独立丢弃、全部HUD与延迟面板接入，以及前台恢复时仅在边距改变后重排。Web测试构建及微信production构建成功。隔离浏览器验证360×640、360×814、412×915、428×951的全屏、异常底边距与正常安全区共12种组合，实际升级卡和武器面板保持正确边界；该注入测试不等于华为X9真机验收，也未上传发布。见 [检查日志](../../AI-Workspace/Work/v1/safe-area-20261016/check-verified.log) 和 [运行报告](../../AI-Workspace/Work/v1/safe-area-20261016/runtime-report.json)。

## 钻石基数与统一加载验收

2026-10-15 本轮 `npm run check` 完成：1352项通过、0失败、0跳过，完整工程类型检查通过；Web和微信 `test` 构建成功。Web使用独立浏览器上下文验证冷启动、静音、11个面板首开、地图切换与刷新、矿山和Boss奖励、新手120→120→20，页面及资源请求错误均为0。奖励场景通过真实会话事件注入，广告仅验证测试回调结算；微信未操作开发者工具或真机，也未上传发布。见 [完整检查日志](../../AI-Workspace/Work/v1/economy-loading-20261015/check-final.log)、[双端构建日志](../../AI-Workspace/Work/v1/economy-loading-20261015/build.log) 和 [Web运行报告](../../AI-Workspace/Work/v1/economy-loading-20261015/web-smoke-2026-10-15T08-15-18-940Z/report.json)。

2026-10-15 微信 0.1.12 发布封装检查：`npm run check` 1361项通过、0失败、0跳过，完整类型检查通过；当前工程重新构建 `production`。新增9项元数据分包回归，验证共享请求、失败/120秒超时清理、迟到回调、显式重试、CDN降级、初始化顺序和各包预算。最终包独立审计10项通过，324个代码文件和4194个服务器文件逐条哈希一致，2805份JSON及272个地图/UI原生资源通过离线下载挂钩。见 [全量检查日志](../../AI-Workspace/Work/v1/logs/wechat-v022-check-final.log) 和 [最终包审计](../../AI-Workspace/Work/v1/qa/wechat-v022-release/release-audit-2026-10-15T08-44-46-480Z.json)。这些离线结果不代表微信真机验收；本次新资源需部署服务器后再做远端运行检查。

2026-10-15当时的挑战奖励为120+360钻、BOSS为600+1200钻；矿山普通/钻石矿为4/40积分，每10积分兑换1钻，整局取整。新手补足100钻、兑换码2000钻、测试钻石200万和消费价格保持原值。本次覆盖以下行为：

微信补充检查：实际构建的13个JavaScript文件可解析、3个bundle版本文件完整、43个后台配置存在；用模拟Cocos I/O执行实际编译的加载器、批次和后台队列，验证请求合并、失败恢复、load/preload隔离及暂停/销毁。微信平台加载专项29项通过。见 [离线产物报告](../../AI-Workspace/Work/v1/economy-loading-20261015/wechat-offline-report.json)；这不是开发者工具或手机运行验收。

- 配置变更同时影响预览与真实结算；基础奖励、广告额外奖励各发一次，取消、失败、过期和重复回调不加奖；旧余额、已领记录和矿山历史最高不追补。
- 矿山9个普通矿加1个钻石矿为76积分：战中7.6钻、基础到账7钻、广告追加21钻；飘字为+0.4/+4，提前退出不结算，存储失败重试不重复发奖。
- 正常新手首胜到账120钻，首次打开武器面板不补差但保存首次补给标记；抽一次后剩20钻，刷新、重开与转生不再次补给。
- `GameResourceLoader` 合并同类型、同路径的并发请求，load/preload分别管理；失败后可重新加载，后台预下载不能冒充前台已经实例化。`ArtLibrary` 与 `GameResourcePreloader` 共用加载器，策略集中在 `ResourceLoadingPolicy`。
- 保留冷启动只加载当前地图/装备、面板首次加载、下一地图预取、前台请求暂停后台、静音不下载音频、销毁后迟到回调不弹UI，以及微信分包重试和本地资源回退；重点运行 `background-resources`、`battle-resource-loading`、`resource-batch`、`weapon-visual-startup`、`maintenance-view` 和 `wechat-*` 用例。

下文带日期的测试数量、金额和运行证据属于对应历史版本，不代替本次验收记录。

2026-10-11 内容解锁管理器接入后、五步主引导接入前 `npm run check`：**567项通过、0失败、0跳过**，完整类型检查通过。该阶段覆盖正式开放门槛、当时的首次钻石补足、转生后的永久解锁、旧v3兼容及测试资源；各领域、HUD和广告回归显式配置广告开启，发布默认仍关闭。该阶段Web/微信测试包构建成功，Web实测与范围见 [内容解锁说明](../docs/内容解锁说明.md)。这一历史结果不代替下面新增主引导的验证。

## 新手引导回归

2026-10-11 五步主引导接入后最终 `npm run check`：**614项通过、0失败、0跳过**，完整工程类型检查通过，见 [tutorial-check.log](../../AI-Workspace/Work/v1/logs/tutorial-check.log)。新增覆盖场景重载失败与重复请求、非中心锚点，以及广告关闭时胜利界面显示实际30钻奖励。最终Web/微信`test`包均构建成功，见 [Web日志](../../AI-Workspace/Work/v1/logs/web-20261011-021823-228.stdout.log)、[微信日志](../../AI-Workspace/Work/v1/logs/wechat-20261011-021839-944.stdout.log)。独立端口7458浏览器已走通升级、挑战、开武器、抽枪、拖动装备，并验证刷新续接及重放退出恢复；[运行记录](../../AI-Workspace/Work/v1/qa/tutorial/verification.json)。微信未做真机验收。

正式新档默认开启 `upgrade → challenge → gunOpen → gunBuy → gunEquip → done`；普通测试档默认跳过。首次挑战结算120钻并开放武器入口；首次打开已解锁的武器面板仅将不足100钻的余额补至100，正常流程保留120钻。关闭重开、刷新和转生不能重复领取，也不能降低已有较高余额。教学步骤持久保存，旧档缺少教程块时跳过主引导。

升级猫爪仅在攻击等级不足3且金币足够时显示；达到Lv.3后出现挑战入口，没有单独的挑战猫爪。正式转生入口还受历史第3关门槛限制，主引导进行中暂时隐藏；引导完成后恢复正常入口判断。

| 测试 | 覆盖行为 |
| --- | --- |
| `tutorial-manager.test.cjs` | 五步顺序、成功动作判定、失败动作不推进、保存恢复、完成后不倒退及环境开关 |
| `tutorial-hud.test.cjs` | 提示目标、箭头动画、节点隐藏和阻挡时暂避；非中心锚点矩形中心、嵌套缩放、拖拽中布局变化及生命周期行为 |
| `tutorial-preview.test.cjs` | 测试重放与正常存档隔离、重启后重置预览、刷新续预览、退出恢复原档、生产拒绝重放、预览关闭测试资源补给 |
| `maintenance-view.test.cjs` | 调试重放的实际场景重载、重复请求、缺失场景与重载失败，以及正常存档保护 |
| `speedrun-ui.test.cjs` | 广告关闭时隐藏加奖入口，胜利界面显示本关实际奖励（首关60钻） |
| `content-unlock.test.cjs` | 正式解锁条件、武器面板补足时机、单次补给与存档、转生保留及旧v3兼容 |
| `weapon-hud.test.cjs` | 真实入口进入GunBuy并立即刷新余额、关闭重开保留步骤和补给标记、装备完成、新枪弹窗优先；主引导期间暂停独立合成箭头和Auto动画，完成后恢复 |

既有武器HUD测试显式设置 `tutorialEnabled: false`，单独验证武器规则；教学集成用例开启教程。合成保持独立：首胜120钻抽一把后剩20钻，不赠送材料，不把首次合成设为主引导完成条件。

测试包手动重放使用游戏运行页控制台：

```js
__forestGunner.tutorial.state()
__forestGunner.tutorial.preview
__forestGunner.tutorial.replay()
// 游戏重启后，从隔离新档体验五步；刷新可继续当前预览。
__forestGunner.tutorial.exitReplay()
// 再次重启后恢复正常测试档。
```

应验证从零资源、攻击升级、挑战胜利、打开面板、抽枪到装备的真实操作链；补钻前后、关闭重开、弹窗暂避和刷新续步分别检查。重放使用 `forest-gunner:economy:v3:test:tutorial-preview`，不覆盖正常测试档和正式档。该API不对应额外界面按钮；脚本回归仍不能代替Web/微信触摸与视觉验收。

2026-10-11 公共广告与圆形地图修正后 `npm run check` 通过：**537 项通过、0 失败、0 跳过**，完整类型检查通过。新增跨入口互斥、提供者异常清理、一次回调、后台暂停恢复、全局广告忙时武器过期保护及原版圆盘裁切回归。三个HUD统一公共弹窗，付费子树与资源已删除。Web/微信构建和运行、五入口同款弹窗、三尺寸截图及存档恢复见 [奖励广告说明](../docs/奖励广告说明.md)。

2026-10-11 首次挑战接入后 `npm run check` 通过：**523 项通过、0 失败、0 跳过**，完整工程类型检查通过，见 [挑战检查日志](../../AI-Workspace/Work/v1/qa/speedrun/check-final.log)。该轮Web与微信test包串行构建成功，两端实际完成胜败及模拟广告流程。首次三尺寸视觉对照、运行证据、存档恢复与验收边界见 [挑战说明](../docs/挑战说明.md)。

2026-10-10 转生轮次 `npm run check` 通过：**486 项通过、0 失败、0 跳过**，完整工程类型检查通过，见 [该轮检查日志](../../AI-Workspace/Work/v1/logs/rebirth-round2-check.log)。Web `test` 包于 22:48:43、微信 `test` 包于 22:49:01 构建成功，见 [Web 日志](../../AI-Workspace/Work/v1/logs/web-20261010-224826-517.stdout.log) 和 [微信日志](../../AI-Workspace/Work/v1/logs/wechat-20261010-224843-856.stdout.log)。

本轮 Web 运行验收另以 CDP 鼠标输入验证标题翼部、移出移回、标题拖到底图和空白区域的命中行为；普通确认真实点击后推进 121 个 `1/60` 秒帧，验证两秒特效、单次奖励、重置与完整武器快照保留，见 [运行数据](../../AI-Workspace/Work/v1/qa/rebirth-round2/runtime-normal.json)。运行截图 `02/03` 保留上述测试；[截图对照](../../AI-Workspace/Work/v1/qa/rebirth-round2/comparison-final.png) 另使用与原版相同转生 UI 状态的 `06-main-matched.png`、`07-normal-matched.png`。遮罩背后的关卡、金币等游戏数据仍不同，字体抗锯齿也有引擎差异，不用于宣称逐像素一致。Web 测试档已恢复并与操作前备份完整深比较一致；微信本轮仅构建，未重新运行。源码回归、运行验收和手机真机验收分别记录。

初次接入的 465 项结果与上一轮 **473 项通过**均为历史记录；上一轮已复核转生字体图集、浏览器广告与长按交互，并恢复当轮 Web 测试档。微信当轮因并发构建重载未恢复测试档，其他 TTF 的 `loadFont` 权限问题仍在。逐轮证据与边界见 [转生说明](../docs/转生说明.md#验证记录与边界)，历史运行结果不代替本轮运行包验收。

## 挑战回归

| 测试 | 覆盖行为 |
| --- | --- |
| `speedrun-session.test.cjs` | 60秒生命周期、零秒最后击杀、首关60/240钻及逐关递增的单次奖励、广告取消/失败/失效回调、挑战属性、主线重开、转生保留及v3存档兼容 |
| `speedrun-world.test.cjs` | 20/35/185/190树数、原版环形与随机顺序、数值、绝对坐标、树池身份、模式切换弹丸与连续时钟 |
| `speedrun-health.test.cjs` | 原InfVal精度下伤害对齐与生命扣除 |
| `speedrun-ui.test.cjs` | 原版节点/字体/素材、移除PlusPack与扫荡子树、触摸捕获、广告取消/失败/多点触摸及失效token |
| `maintenance-view.test.cjs` | 实际入口与战斗组件集成、进入仅Warp一次、退出隐藏旧地图、返回主线与Loading尾帧 |

## 独立 BOSS 回归

| 测试 | 覆盖行为 |
| --- | --- |
| `boss-content.test.cjs` | 历史第5/6/9/10关显示与解锁、测试门槛绕过、独立广告开关及迟到回调 |
| `boss-session.test.cjs` | 2秒进入、60秒零点让帧与末帧原始计时、1.5秒退出、首关300/900钻及逐关递增的合并结算、免费重试、旧回合隔离、广告token与武器到期保护、v3可选块、转生保留及高关预览 |
| `boss-loadout.test.cjs` | 排除金币倍率及等级0精度提升，保留转生和紧凑actorIndex星级；转生攻速Lv.20/21边界与float32冷却顺序 |
| `boss-combat.test.cjs` | 1,000项原生命表、表外递推、旋转盒碰撞、三维导弹与飘字、七类武器、死亡/超时禁伤、漫游与固定步、30/60/120fps三猫追击 |
| `boss-ui.test.cjs` | 原版UI尺寸、九种头像、胜败动画引用、图片依赖及免费子树；锁定入口、生命/时间/奖励、负数和恰零的失败计数、胜败广告操作、三种竖屏、多指归属及非零安全区 |
| `maintenance-view.test.cjs` | 真实Bootstrap入口、进入只建一次战场、停战后特效、退出恢复主线、Loading尾帧、广告与后台取消 |

2026-10-11 最终 `npm run check`为**770项通过、0失败、0跳过**，完整工程类型检查通过，见 [check-final.log](../../AI-Workspace/Work/v1/qa/boss-20261011/check-final.log)。最终Web `test`与微信 `production`构建成功，浏览器三尺寸、九皮肤、实际胜败/结算/存档/后台和其他玩法回归见 [最终验证记录](../../AI-Workspace/Work/v1/qa/boss-20261011/验证记录.md)。浏览器错误为0；微信未真机运行。多指和顶部44/底部24安全区由真实BossHud的Cocos替身测试覆盖，内置浏览器不支持本轮多指CDP输入，不记为手机实测。

首轮**750项通过、0失败、0跳过**和首轮Web `test`构建保留为历史结果，见 [check-initial.log](../../AI-Workspace/Work/v1/qa/boss-20261011/check-initial.log)与 [BOSS说明](../docs/BOSS说明.md#验证状态)。缺少原版同状态运行图，逐像素验收未完成，不将节点/资源断言或Cocos替身测试解释为像素一致。

`fixtures/boss-health-original.json`独立保存从 `data.unity3d level0:124699`提取的原1,000项生命操作数；正常测试不依赖原bundle或外部工具。`support/boss-session-fixture.cjs`默认读取`.build/session`，可用`FOREST_GUNNER_SESSION_TEST_BUILD`切换到专项编译目录以避免并行开发覆盖，不改变普通`npm test`入口。

## 转生回归

| 测试 | 覆盖行为 |
| --- | --- |
| `rebirth-math.test.cjs` | 原版整数/双精度构造、有效数字、逐步截断、加减乘除与快速幂；66 组奖励、26 组升级价格/加成边界；余额累加、零值特殊指数及序列化精度 |
| `rebirth-session.test.cjs` | 历史入口门槛与当轮执行门槛；单次保存、重置/保留字段、广告取消/失败/重复回调、跨本地自然日、旧 v3 与损坏新增块、刷新恢复、永久倍率、未来完成通知；计时零点与旧失败过场在转生期间的顺序 |
| `stage-round-reset.test.cjs` | 转生保留角色实例、跟随 AI、攻击计时和目标切换记忆；清除旧目标，恢复首帧索敌，特效期间继续手脸姿态更新；跨地图弹丸保留原伤害、剩余寿命、时钟与稳定树池命中身份，普通重开局仍清理 |
| `original-impact-fx.test.cjs` | 转生期间全局弹丸视图、命中特效、金币和数字池保留，特效时钟连续；普通重开局维持清理行为 |
| `rebirth-ui.test.cjs` | 原版节点与素材来源、中文内联货币图标、入口位置及安全区、奖励刷新时机、长按购买、模拟广告、禁用付费购买、十层圆形动画及关闭窗口；移出移回、外部松开、快速重按、子 Graphic 与缩放命中、确认框阻断已捕获触摸 |
| 既有经济与入口回归 | 首次转生前仍提供测试金币；完成转生后刷新不再补金币；旧战斗、武器和关卡流程继续运行 |

UI 回归运行实际组件代码并替换引擎节点，验证事件、状态及布局数值；不能据此宣称字体栅格、透明叠加或设备触摸已与原版逐像素一致。详细规则及手动验收场景见 [转生说明](../docs/转生说明.md)。

## 新增测试

纯逻辑模块由 `run-tests.cjs` 编译到以下目录：

| 目录 | 示例入口 |
| --- | --- |
| `.build/core` | `index.js`、`CombatWorld.js` |
| `.build/session` | `session/BattleSession.js`、`session/RuntimeEnvironment.js` |
| `.build/feedback` | `view/OriginalParticleSimulation.js` |
| `.build/character` | `OriginalCatAnimation.js` |
| `.build/color` | `OriginalColorMath.js` |
| `.build/money` | `view/MoneyBurstSimulation.js` |

新编译入口加到 runner 的 `builds`；无需维护测试文件清单。视图测试通过 `require('typescript')` 转译生产源文件，注入所需引擎替身。优先测试实际业务调用链，避免仅验证同义实现。

`support/paths.cjs` 提供 `projectRoot`、`projectPath(...parts)` 和 `fixturePath(...parts)`。读取资源时使用这些路径，或基于当前测试的 `__dirname` 定位，不写本机绝对路径。临时测试输出放在 `.build` 内。

## 参考资料与夹具

`fixtures/provenance.json` 记录每份夹具的来源、源文件 SHA-256、夹具 SHA-256 和提取范围。路径仅用于追溯，测试不会读取这些外部来源。

转生夹具另在 `fixtures/rebirth-golden.json` 内记录自己的 `provenance`，包含 Cat Gunner 1.1.61、管理器伪代码及 ARM64 库的 SHA-256、函数地址和常量。它由 `fixtures/rebirth-oracle.py` 使用独立整数系数算法生成，不导入 TypeScript 实现，也不是原版运行时抓取值。正常回归只需要已提交的 JSON，不需要 Python 或外部原版文件；本地恰好存在原始资料时会额外核对其哈希。维护夹具需先核对原版指令和证据，不能仅为通过测试修改期望值。

- 动画曲线和枪口变换保存原始小型 JSON；金币数字和枪口速度限制只保留现有断言实际读取的字段。
- `fixtures/cocos-3.8.8/*.ts.txt` 是 Creator 3.8.8 的两个 MIT 引擎源文件快照，保留原许可证，用于真实索引缓冲增长、上传和重置契约测试。使用 `.ts.txt` 避免被游戏工程 TypeScript 检查当作项目源文件。
- 引擎快照验证固定版本的契约，升级 Creator 时需要主动更新快照和来源记录，不能把这项测试解释为对任意本机引擎版本的验证。
- 武器参数表和弹丸映射测试直接检查项目内 [武器系统与特效说明](../docs/武器系统与特效说明.md)，保持文档与当前数据同步。

原 AI 工作区的 `run-tests.cjs` 保留为兼容入口并转发到这里；旧测试文件仅保留历史记录，后续修改统一落在本目录。

## 狩猎回归

`hunt-balance/combat/world/session/ui/map-view` 与 `pet-daily-ad` 覆盖五小关、独立原版2000项生命表、胶囊碰撞、七武器、主猫锁定与跟随猫缓存、清关两秒、30/60/120 FPS、即时宠物币、跨组、失败重试、v3兼容、转生、广告互斥/重复/跨日/满包与配置共用。`maintenance-view` 另测完整Bootstrap模式切换、后台、懒加载和过期战场加载回调。浏览器通过独立上下文和实际触摸验收，记录见[狩猎说明](../docs/狩猎说明.md)，不操作日常存档。

2026-10-16 武器首次打开优化：`npm run check` **1638 项通过、0 失败、0 跳过**，完整类型检查通过。背包首轮只创建 823 个原始节点，独立图鉴为 1702 个；覆盖背包在图鉴完成前的抽取/合成/装备、提前点图鉴共享请求、关闭后的迟到完成、失败重试、准备中尺寸变化和场景销毁。新增真实源渲染器隐藏图鉴验证、使用优先级跨启动/环境隔离验证，以及网络/缓存读取/解析和界面执行耗时诊断验证。使用记录和游戏存档分别保存，转生原子保存断言只统计游戏存档 key。实际引擎的两次启动、图鉴、详情和尺寸变化结果见 [浏览器记录](../../AI-Workspace/Work/v1/weapon-first-open-20261016/browser-results.json)，全量结果见 [检查日志](../../AI-Workspace/Work/v1/weapon-first-open-20261016/check-final.log)。浏览器使用隔离测试档与桌面软件 WebGL，不能代替微信持久缓存或手机耗时验收；本轮未上传微信。
