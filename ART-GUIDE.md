# 美术维护与替换

本项目采用“**单图和动画数据用于维护，图集用于发布优化**”的方式。不要把所有资源手工塞进同一张大图，也不要把人物改成一张静态整图来替代现有动画。

## 当前资源接口

`assets/resources/art/catalog.json` 是外观入口，运行时通过以下稳定 ID 读取：

- `characters.cat_basic`：基础猫，`rig` 指向骨骼和动画 JSON。
- `weapons.pistol_basic`：基础手枪外观和枪口挂点。
- 树木、阴影及基础效果资源由同一清单管理；地图和复杂反馈有独立配置，见下表。

图片路径相对于 `assets/resources`，不带文件扩展名。例如图片 `assets/resources/art/weapons/pistol_basic/sprite.png` 在清单中写为 `art/weapons/pistol_basic/sprite`。代码会加载该图片导入后生成的 `spriteFrame`。

当前实际目录是：`characters/cat_basic`（`rig.json`、`parts`、脸和手部）、`weapons/pistol_basic/sprite.png`、`enemies/tree_pine`、`enemies/tree_round`、`maps/forest`、`effects` 和 `hud`。血条、伤害数字、金币飘字、金币粒子和关卡界面分别维护。`source_layout.png`、原始动画曲线和粒子参考数据保存在 `E:\gunner\AI-Workspace\Work\v1\art-reference`，其中 `provenance-manifest.json` 及各专项 evidence JSON 记录溯源；这些对照资料不进入运行图集。

| 表现 | 维护入口 |
| --- | --- |
| 猫的朝向、双手/脸部、后坐力、动画速度和切换 | `characters/cat_basic/rig.json` 的 `dynamics` |
| 第一关地面、18×18 平铺、完整边界及填充 | `maps/forest/map.json` |
| 地面原始平面光照 | `maps/forest/original-floor.effect` 与 `map.json` 的 `ground.lighting` |
| 树木受击与血条、旋转准星 | `effects/original_feedback/config.json` |
| 原版数字字体、65 点曲线与子弹/命中粒子 | `effects/original-feedback.json`；数字单图在 `effects/damage` |
| 枪口双层火星/光晕 | `catalog.effects.muzzle` |
| 普通关卡 HUD、五波节点、顶部双进度条、设置和货币显示 | `hud/config.json`；独立图片和字体在 `hud` |
| 树木死亡爆出的现金粒子 | `effects/money-burst/config.json` 与 `cash_atlas.png` |
| 金币飘字、现金前缀图标及动画 | `effects/money-numbers/config.json` 与 `glyph_<字符编码>.png` |
| 场景线性混合与最终显示转换 | `rendering/original-sprite.effect`、`original-graphics.effect`，由 `OriginalColorPipeline` 管理 |

原猫部件默认朝左，所以人物朝右时外观根节点镜像 X；枪的原始 `[0.4,-0.4]` 翻转必须保留，两者配合才能使枪柄向下。不要用再次翻转 PNG 来修正角色朝向。Idle/Walk 动画资源都是 2 秒，原控制器中 Walk 播放速度为 1.5，切换混合为 0.25 秒。

地面小草已经画在原地面 PNG 中，随原材质 UV 重复，不是随机撒布的独立图片。地面使用一个原始平面、18×18 UV 重复和独立纹理；`ground.png` 的 SpriteFrame 保持 `packable=false`，Texture 使用双线性 Repeat、无 mipmap。不要把它改回图集小图或324个 Clamp 重复块，两者在接缝的过滤行为不同。其他适合打包的单图继续使用自动图集。

每项图片配置的核心字段：

| 字段 | 含义 |
| --- | --- |
| `path` | 图片路径，不含扩展名 |
| `sizePx` | 图片原始像素宽高，供检查和维护 |
| `sizeUnits` | 显示宽高，使用游戏表现坐标单位 |
| `anchor` | 相对于当前单图宽高的锚点，左下为 `[0,0]`；裁边后可能超出 0～1，不能强制截断 |
| `localPosition` / `localRotationDeg` | 相对父节点的位置和旋转；仅在该项存在时使用 |
| `localScale` | 相对父节点的缩放，负值表示翻转；枪械原值为 `[0.4,-0.4]` |
| `color` | 可选 RGBA 乘色，四通道范围 0～255；持枪手使用原版肤色 |

首次换图时先保持 `sizeUnits` 和 `anchor`，只替换图片内容，可避免整个人物忽大忽小或脚底漂移。需要改造型比例时，再有意识地调整显示尺寸和挂点。

## 关卡界面与金币反馈

`GameHud` 按 `BattleHudState.mode` 管理界面。只有 `Main` 创建 `Main_UI`；切换到刷钻石等其他模式时移除该根节点，返回后重新建立。其他模式目前只有接口与显隐边界，没有对应玩法和完整界面。五波节点及 `Stage 1-1` 的显示使用独立的 `stageIndex`、`waveIndex`；击杀百分比不能当作波次编号。当前仍是一张首波地图，180 秒时间条归零不会自行触发新失败流程。

HUD 的 `layout` 保留原版 1080 宽 Canvas 坐标，通过整体缩放适配屏幕宽度，并从安全区顶部定位；它的图片 `sizeUnits` 是参考 UI 像素，不是地图世界单位。调整位置和尺寸优先改 `hud/config.json` 的 `layout`，颜色改 `palette`，不要把屏幕适配缩放重复乘进配置。`settingsPosition`、`settingsSize` 控制左侧设置图标，目前没有点击处理。顶部先绘制时间条，再绘制清场进度条，原本存在交叠；填充使用九宫格图片加裁剪，不能压缩图片宽度来代替进度裁剪。

进度条斜纹由 `images.hatch` 和 `palette.hatch` 指定，运行时在裁剪区域内平铺。平铺宽度为 100 参考像素，滚动使用战斗 `elapsed` 每秒推进一格；如需改动平铺密度或速度，修改 `GameHud` 的 `StageHud` 构造和更新逻辑。暂停期间不使用系统时间继续滚动。字体、描边和阴影在 `font` 配置中维护；当前 `MPLUSRounded1c-Black-ASCII.ttf` 是原字体 Font320 的 U+0020–U+007E 子集，只覆盖英文关卡文本、数字、符号及金额单位。加入中文或其他字符时应重新导出所需字形或另配字体，不能认为原字体子集已包含中文。中文结果卡仍使用独立字体设置。

以下原版 ID 用于查证来源，运行时继续引用上述稳定资源路径：

| 内容 | 原版来源 |
| --- | --- |
| `stage_background` / `stage_fill` / `stage_hole` / `stage_dot` / `cat_icon` | `sharedassets0.assets` 的 Sprite660 / 390 / 736 / 684 / 821 |
| `bar` / `bar_outline` / `settings` / `hatch` | Sprite482 / 466 / 510 / 144 |
| `money_icon` / `diamond_icon` / `currency_background` | Sprite375 / 904 / 658 |
| HUD 字体、字效与金额单位表 | Font320，TMP 字体资源1006、材质75；`resources.assets:2068` |
| 现金粒子 | `level0:72018`，池148042，Renderer79812；Texture136 / Material41 |
| 金币飘字 | `level0:137998` 的 `money` 配置 → prefab960 / animation1025；Font315 → Material38 → Texture98 |

树木奖励包含两种独立表现。现金粒子从树根上方 Y=2 产生，每棵普通树显式发射 5 个；不要误用序列化播放 burst 的 25 个，也不要把它改为飞向货币栏的收集效果。`cash_atlas.png` 是原版 128×128 的 3×3 贴图，粒子随机选定一个格子并保持该帧，使用尺寸曲线收尾。128/3 不是整数，因此保留完整纹理和运行时分数 UV，atlas 及生成的九个 SpriteFrame 均保持 `packable=false`，不能先四舍五入切成九张图再打包。

金币飘字从树根 Y=0 出现，使用原版 1.5 秒、50 套随机动画及每套 65 个采样点；`gap=-0.36`、`worldScale=0.02` 对应原 `spriteGap=-18`。42 个原字形包括数字、字母、单位别名、小数点及字符 `+`；其中 `+` 实际画的是现金图标，不是普通加号。`DamageNumbers` 同时管理伤害和金币：伤害沿用 Y=2、0.12 秒间隔，金币沿用 Y=0、0.2 秒间隔，两者共享按世界 **X/Y**、1.5 单位分桶的冷却表，不能按地面 X/Z 或每棵树分别限流。

奖励数值在 `BattleSession` 消费死亡事件时立即入账，不等待粒子消失；飘字被冷却抑制也不能少发奖励。当前首波两种树分别奖励 20/36，余额仅在本次应用实例内保留，重开保留余额但清空树 ID 结算记录；不读写原游戏存档或长期钱包。美术替换不应改变这些会话规则。

现金粒子和飘字使用死亡事件的 `sourceTime`，出生帧只推进该物理时刻至当前 `world.simulationTime` 的时间，不提前消耗整个画面帧。后续动画使用缩放战斗时钟，清场后仍继续，暂停和切后台则冻结；结果遮罩等所有奖励表现结束后才显示。重开和模式切换清除活跃效果及飘字冷却；池保留已分配节点供复用。现金粒子使用独立 xorshift 随机流，飘字选曲线使用表现随机，均不消费 `CombatWorld` 的射击随机序列。

金币相关参数来自原粒子配置和方法调用，但本项目的 120 Hz 积分、速度阻尼、扫掠盒碰撞和随机采样是跨引擎实现；不能用参数一致推断与 Unity 的每条轨迹逐位相同。HUD 的原始布局和图片已保留，TMP SDF 描边/阴影通过 Cocos 字效适配，也不等同于原引擎逐像素输出。

## 武器配置只改一处

枪械图片、显示尺寸、握点和枪口均以 `catalog.json` 的 `weapons.pistol_basic` 为唯一配置来源。角色的 `rig.json` 通过 `attachments.gun.weaponId` 引用它，不再保存第二份武器图片或枪口配置。

| 要调整的内容 | 修改位置 |
| --- | --- |
| 枪械 PNG / 像素尺寸 / 显示尺寸 | `catalog.weapons.pistol_basic.path` / `sizePx` / `sizeUnits` |
| 图片上的握点和旋转基准 | `catalog.weapons.pistol_basic.anchor` |
| 图片相对持枪挂点的微调、角度和翻转 | `catalog.weapons.pistol_basic.localPosition` / `localRotationDeg` / `localScale` |
| 枪口在图片局部坐标中的位置 | `catalog.weapons.pistol_basic.muzzle.localPosition` |
| 角色由哪根骨骼持枪、手上的挂点位置 | `rig.attachments.gun.bone` / `localPosition` / `localRotationDeg` / `localScale` |
| 改用另一把已配置的武器外观 | `rig.attachments.gun.weaponId` |

`muzzle.localPosition` 使用图片局部单位，以 `anchor` 为原点，向右和向上为正，随后继承武器 `localScale`、持枪骨骼、人物比例及投影。基础枪口是 `[8.08,1.96]`，图片局部缩放是 `[0.4,-0.4]`；不要预先把缩放再乘进枪口数字。调整枪身尺寸、裁边或握点后，应同步校正同一配置中的枪口。若已知枪口在 PNG 上的像素坐标 `[px,py]`（左上原点），可换算为 `[(px/width-anchorX)*sizeUnitsX, (1-py/height-anchorY)*sizeUnitsY]`。

人物 `rig.display.scale=0.55` 由外观层统一应用一次；图片 `sizeUnits`、骨骼和枪口数据都不提前乘该系数。武器配置中的 `source`、`trim`、`sourceTransform` 是原版溯源资料，不是另一个运行参数入口。

## 基础猫的特殊结构

原版基础猫采用 Unity SpriteSkin 和 Animator。实际网格是 9 个骨骼、215 个顶点，全部顶点只有一个权重为 1 的骨骼，三角形也未跨骨骼；因此本版按刚性部件重建，不引入 Spine。

人物 rig 包含：

- `bones`：骨骼 ID、父子关系和初始位置/旋转/缩放。
- `parts`：每张部件图片及其绑定骨骼。
- `animations.idle` / `animations.walk`：保留原版 streamed cubic 系数，运行时直接求值；采样姿态用于未动画通道的默认值和替换 rig 的兼容回退。
- `attachments`：面部、手部、持枪挂点等附属资源。
- `display`：整体显示比例、偏移与投影校正。

脸、手、枪和枪口是需要保留的独立关系。身体动画与瞄准方向分别更新，换枪时应同时检查握把、枪口和后坐力位置。不要随意重命名骨骼 ID、调整数组顺序或删除挂点。

主角进入减速分支时立即设置 Walk=false，仍以 0.25 秒混合到 Idle，不能等残余速度归零再切换。每个画面帧先消费原约50Hz物理步，再更新索敌、移动速度和程序手/脸。这里读取的是此前已经写入的动画骨骼及后坐变换；若开火，Attack 再朝向敌人，保留本帧手/脸局部角度，然后读取枪口。之后才恢复已等待的后坐协程、求值 Normal Animator 并绘制粒子，不能把整套 Animator 提前到取枪口之前。原 Idle/Walk 没有左右臂旋转通道，后动画阶段保留程序手角，使其随新父骨变换显示。

首次后坐先等待一次 `yield null`，下一帧 Update 结束后才开始改变枪和手的位置/缩放；正在后坐时再次触发只重置计时。脸角需要保留瞄准方向和当前朝向的符号，撤退时不能使用绝对值折叠。枪口 Glow 与 Spark 保留各自的 ClampVelocity 参数。逐帧调试应分别检查 Update 内的发射姿态和随后绘制的姿态，不能把两者强制当成同一时刻。

可见枪口挂点与物理子弹生成点是两个接口：`getMuzzleProjectionOffset()` 提供画面中的枪口，`getBulletSpawnOffset(height)` 按原 `Cat.CamDir`（40°俯角）把枪口换算到子弹 Y=2 平面。这里不能用实际相机约35.264°的方向强制对齐屏幕点；原版允许子弹与枪口有微小屏幕高度差。命中光圈则直接使用碰撞体对上一物理位置的 ClosestPoint，没有另加外推偏移。

世界层使用线性 LDR 离屏目标，整体合成后再转换到显示颜色；UI 保持独立。清屏色来自原 Camera64047，先转为线性值；renderScale 使用原 float32(0.7)，离屏尺寸按乘积截断，不能额外四舍五入或加任意2048上限。不要给单个粒子先做显示转换后再叠加，也不要用全局饱和度补偿混合差异。原 Sorting Layer 顺序为 Default→Cat→Boss：子弹与命中在 Default，Cat 在其上。Default 的子弹/拖尾 10、11、13、14，与血条 10、11 交错；命中 40、41；数字从 1000 起。Cat 内 Glow1、Spark2、枪3、手4、描边5。相同 Order 的 Unity 距离排序仍有跨引擎边界，不能只按数值认定唯一先后。

这里的线性RGBA8是本项目复现线性混合的实现选择，不是原URP存储格式已完全复制的结论：原Linear管线的RenderTexture启用sRGB，本项目缓冲的量化位置仍不同，手动纹理解码也发生在过滤之后。不要把这些边界用PNG改色或全局饱和度掩盖。

只更换部件画风时可保留骨架和 Idle/Walk 数据。如果将来换成完全不同的骨架，应更新 rig 的全部部件绑定与动画，或新增外观适配器；战斗逻辑无需因为换骨架而修改。

## 资源与运行时维护

2026-10-10上一轮维护的 **36张PNG、9骨骼、2动画** 是加入关卡 HUD、现金粒子和金币飘字之前的校验快照，不是当前资源总数。未使用的 `leaf` 已从运行时 `resources` 和 `catalog.json` 移出；原图、目录/图片 `.meta` 与原清单项保存在 `E:\gunner\AI-Workspace\Work\v1\art-reference\unused-leaf`，`convert_original_art.py` 不再导出它。历史证据中的37张图同样是当轮快照，不应为凑齐旧数量而恢复运行依赖。

`ArtLibrary` 对同路径 SpriteFrame 共享缓存，并合并并发加载请求；加载失败后可重试。普通图片属于资源系统共享资产，视图销毁时不要主动销毁这些 SpriteFrame 或纹理。`OriginalColorPipeline` 创建的 RenderTexture、对应 SpriteFrame 和材质，以及地图创建的材质，属于各自实例，应随实例释放；不要把这类对象当作共享图片缓存。地图 effect 的运行缓存与 JSON 数据分开维护，不向配置 JSON 填入引擎对象。

HUD 图片、字体和金币位图字形也属于共享资源。`OriginalMoneyBurst` 从共享现金纹理创建的九个 SpriteFrame 则由该视图实例独占，应在显式销毁或父节点销毁时释放一次，不能销毁底层共享纹理。HUD、飘字及现金节点分别归各自所有权根节点管理；异步资源加载期间被销毁、构造中断或父 Canvas 先销毁时，仍须清理已有节点和实例资产。池重置只停用节点，最终视图销毁才释放它们。

人物曲线、粒子及反馈配置已有明确 TypeScript 接口。动画和粒子更新复用工作缓冲以减少分配，调试代码需要保存历史姿态时应复制结果；`OriginalParticleSimulation.pose` 传入输出缓冲会复用该对象，不传时返回独立快照。静态树投影缓存以逻辑 XZ 坐标为依据，改变树的位置应修改逻辑位置，让树身和两层血条一起更新。

参数维护继续以原数据和已有回归为准。此前维护重构已对既有手枪粒子的固定种子轨迹摘要和随机抽样次数建立回归约束；新增现金效果使用自己的随机状态，不应修改这些既有结果。不要为减少代码或分配而改变抽样顺序、曲线采样、后坐及粒子更新阶段。新增图片仍需保留既有资源 ID、锚点和 `.meta` 的维护约定。

## 替换步骤

1. 以 `catalog.json` 中的实际路径为准，找到对应单图。保留 PNG 透明通道，优先保持原有画布尺寸和定位。
2. 在原路径覆盖图片，**保留旁边的 `.meta` 文件**；需要改名或搬目录时，在 Creator 内操作并同步更新清单路径。
3. 图片必须以 SpriteFrame 方式导入。项目 `.creator/default-meta.json` 为新图片设置了默认导入类型；已有图片仍检查自己的导入设置。
4. 在 Creator 或 Web 试玩中观察静止、行走、左右朝向、不同射击角度，以及人物经过树木前后时的遮挡。
5. 重新构建 Web 和微信小游戏，确认发布产物显示的是新图片，而非编辑器内的旧预览。

对武器额外核对 `muzzle`；对人物额外核对脚底锚点；对树木额外核对根部与碰撞体的视觉对应。改变图片轮廓不会自动改变 `core/config.ts` 中的碰撞参数。

## 图集约定

维护目录按角色、武器、树木、地图、效果及 HUD 分组，不按原版打包时的杂糅大图分组。现有 5 份 Creator Auto Atlas `.pac` 配置为：`characters/characters.pac`、`weapons/weapons.pac`、`enemies/enemies.pac`、`maps/maps.pac`、`effects/effects.pac`。HUD 保留独立图片、九宫格边距和字体；现金九宫格 atlas 也保持独立纹理。编辑时继续维护单图，适合打包的资源在构建时自动打包，代码继续引用稳定图片路径或资源 ID。

配置来自已安装 Creator 3.8.8 的原生模板。图集保留 SpriteFrame 的原有尺寸、锚点与裁边信息，间距 2 像素并扩展边缘颜色，禁止旋转；地图图集最大 2048×2048，其他组最大 1024×1024。第六轮把地面从地图图集排除，以保留原 Repeat 采样；边界仍可打包。旧版5张图集的尺寸和包体是历史构建结果，最终数量、独立纹理及尺寸以当次构建验收为准。需要 Repeat 或分数 UV 的独立纹理保持专用；避免把其他图集内小图的 Texture2D 同时直接作为材质纹理使用，否则可能重复打包。

原版导出资源与转换工具属于分析/导入资料；重新运行导出工具可能覆盖已替换的图片。制作自己的美术后，先备份或提交版本，再执行重新导入。

原版重新生成工具是 `E:\gunner\AI-Workspace\Work\v1\tools\convert_original_art.py`，使用本机 `C:\Python311\python.exe` 执行。它会从原 bundle 重新导出并覆盖本项目 art，**不是日常换图所需步骤**。转换质量资料位于相邻 `tools/qa` 目录。

新增资源有独立导出入口，不依赖重新生成整套角色资源：

| 导出脚本（均位于 `E:\gunner\AI-Workspace\Work\v1\tools`） | 输出及溯源 |
| --- | --- |
| `convert_original_hud.py` | `art/hud` 的12张图片、原字体 ASCII 子集及配置；`art-reference/original-hud-evidence.json` |
| `convert_money_burst.py` | `art/effects/money-burst` 的完整现金 atlas 及原参数；`art-reference/money-burst-evidence.json` |
| `convert_money_numbers.py` | `art/effects/money-numbers` 的42个字形及50套动画；`art-reference/original-money-numbers.json` |

这些脚本读取原 bundle，写入本项目资源和工作区证据，不修改原版目录。HUD 字体子集转换使用工作区 `hud-python-deps` 中的 fontTools；具体重建依赖见脚本开头。重新导出会覆盖自制美术，应先保存替换成果。修改 HUD 文本字符范围时同时更新导出字符集与运行时字体路径；修改现金 atlas 时保留3×3排布、透明通道及非打包约定。

日常换图后可运行以下只读检查，不会覆盖美术：

```powershell
& 'C:\Python311\python.exe' -B 'E:\gunner\AI-Workspace\Work\v1\tools\validate_art.py'
```

静态检查通过后仍需重新构建并看一次实际画面，确认图集更新、尺寸、透明边缘及动画挂点都符合预期。
