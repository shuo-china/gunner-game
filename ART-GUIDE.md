# 美术维护与替换

## 关卡顺序、挑战预览与飞镖尺寸（2026-10-23）

第一关改用原第八关的林间试炼场；原第一关的森林遗迹移至第八关。`art/stages/config.json` 中两组地面、边界、填充色和四档目标物整体互换，并保留各自的锚点与缩放。资源目录名称仍沿用原编号；运行顺序以配置下标为准，加载和微信地图分包须按资源路径引用解析。目标生命、收益与存档关数不变。

挑战弹窗文案改为“在1分钟内摧毁所有建筑！”，Stage 上方预览直接引用当前关卡的实际目标图片。首关采用林间试炼场靶子，其他关卡也与场景中的目标保持对应；保持图片原比例和居中显示，不再引用旧树木预览素材。

全部 12 档拳套飞镖的 `bodyLength` 由 3.15 调为 2.835，在现有尺寸上再缩小 10%；本体、残影、拖尾宽度与接合距离同比缩小。配置同时写入 `weapon-system/visuals.json` 与生成的 `weapon-runtime/projectiles/glove.json`，后续导入须保留此值。飞行轨迹、伤害及碰撞范围不变。

## 武器 PNG 无损压缩（2026-10-23）

当前 65 张武器本体运行 PNG 共 1,565,957 字节；本轮压缩前为 1,714,720 字节，节省 148,763 字节（8.7%）。原版导入项目后的 65 张对应武器 PNG 共 855,071 字节，当前仍高于原版；本轮优先满足“不要影响现在的显示效果”，没有减色或缩图。

仅优化 PNG 的扫描行过滤与 Deflate 编码，比较 oxipng level 6 与 Zopfli 30 轮的候选后逐张采用更小结果。全部 65 张解码后的 RGBA 像素（包括全透明像素的 RGB）及颜色管理信息与压缩前完全一致；保持画布、透明边缘、描边、握点、炮口、UUID、`.meta`、战斗和 UI 配置。没有改变纹理解码后的像素量，节省的是存储和下载体积。

最新文件哈希登记在 `tests/fixtures/weapon-redraw-v2-assets.json` 的 `weapons[].sha256`，压缩来源和像素哈希见 `losslessEncodingRevision`；此前描边修订记录保持历史原值。旧绘图、描边校准和压缩脚本不得覆盖本轮编码成果。修改前备份、优化脚本、逐图记录和验证位于 `../AI-Workspace/Work/v1/weapon-png-compression-20261023/`，其中 `report.json` 记录各编码候选和体积，`verification.json` 核对像素、保护文件及构建图片。

本轮 `npm run check`：1962 项测试及类型检查通过。Web 与微信 production 本地构建均成功，两种产物的全部 65 张 PNG 均与安装文件哈希一致，总量均为 1,565,957 字节；65 份导入元数据及 5 份运行配置／尺寸基准保持逐字节不变。独立构建目录为 `build/weapon-png-compression-web` 和 `build/weapon-png-compression-wechat`。显示一致性的依据为解码 RGBA、颜色信息、导入设置和构建资源的完整比对；本轮没有重新进行手机画面验收或线上发布。

## 全部武器描边下限复核（2026-10-23）

按“只能与原版一样粗或更粗，尽量一致”的新要求，复核全部 65 把武器，本轮使用内置 ImageGen 替换 50 张 PNG，15 张复查保留。上轮 9 把中再次加粗 ID 19／33／36／41／48／55／58，43／53 保留。程序仅用于测量、透明边裁切缩放和画布配准，没有程序生成或修改描边。此阶段 65 张本体 PNG 共 1,714,720 字节；后续无损压缩结果见上文。

同一游戏尺寸下，所有有效容差档的主描边中位数比均不低于原版，最低 1.001 倍；47 把主估算值处于 1.00–1.12 倍，其余仍偏粗，最大 1.258 倍。色差容差为 24／36／48，每把至少两档有效且包含 36。该结论为主描边统计复核，不代表每段装饰线逐像素一致。局部轮廓、色块和明暗存在生成编辑差异。

每张画布、alpha≥16 可见包围盒、握点、炮口、UUID、战斗缩放及玩法配置保持原值。两份 UI 配置同步实际透明轮廓和适配尺寸；拳套图鉴基准的内部缩放作轮廓补偿，七类 UI 可见尺寸目标保持不变。当前来源登记在 `tests/fixtures/weapon-redraw-v2-assets.json` 的 `lineWeightFloorRevision`；历史压缩来源和上一轮记录保留，旧导出器不得覆盖当前成果。

1948 项测试和类型检查通过，独立 Web test 构建成功，65 张构建 PNG 与安装文件哈希一致。本轮未做微信或手机验收。[原版／本轮修复前／最终修复后完整对比](../AI-Workspace/Deliverables/weapon-line-floor-20261023/index.html)、[测量与验证](../AI-Workspace/Deliverables/weapon-line-floor-20261023/verification.json)、母版及提示词位于同一交付目录；备份和复现脚本位于 `../AI-Workspace/Work/v1/weapon-line-floor-20261023/`。

## 上轮 9 把武器描边校准（2026-10-23，历史记录）

本轮替换 9 张运行贴图：ID 33／43／48／53／58 火炮调细，ID 55 法杖、19 拳套、36／41 扇子加粗。使用内置 ImageGen 编辑并注册到原 208 px 长边画布；原可见包围盒、握点、炮口、战斗尺寸与外观变换全部保持，局部轮廓和色块存在生成编辑差异。其余 56 张武器 PNG 未变。两份 UI 配置的透明轮廓和适配尺寸已同步，65 张 PNG 总计 1,810,621 字节。

同一游戏局部缩放下，估算线宽／原版从 0.57–1.56 倍收敛至 0.80–1.25 倍；XXX、ZZ 火炮仍分别偏粗约 20%、25%，不作逐像素一致承诺。母版、提示词、修改前后对比和逐图测量在 `../AI-Workspace/Deliverables/weapon-line-fix-20261023/`，备份与导出脚本在同名 `AI-Workspace/Work/v1` 目录。旧重绘或压缩导出器不得覆盖这 9 张当前贴图；当前哈希及沿革登记在 `tests/fixtures/weapon-redraw-v2-assets.json`。

本轮通过 1936 项测试、类型检查及独立 Web test 构建；9 张构建 PNG 与安装文件哈希一致。未构建微信或做手机验收。

## 十种宠物形象（2026-10-23）

当前 D–ZZZ 十阶采用简约无腿 v4：布丁小狗、桃桃小猪、团团企鹅、栗壳刺猬、月芽垂耳兔、竹叶熊猫、霜羽小鸮、林灯幼鹿、晨羽巨嘴鸟和星芽幼龙。本轮按用户要求，以原版同阶宠物为依据分别校准战斗贴图与背包头像的棕色圆润描边。SSS 幼象改为自然竖向蛋形的霜羽小鸮，题材参考冒险岛图鉴的白色猫头鹰（物品 5002183），使用内置 ImageGen 重绘。

资源路径和 UUID 稳定：完整透明身体位于 art/pet-system/characters/0..9/part-0.png；头像位于原有 sXXX 图片路径。动画继续使用 10×6 连续加权网格与 0.2 秒过渡；猫头鹰控制左右翅膀和头顶耳羽，移除幼象的象鼻控制。保留原场景变换，校准中心、底边和共享几何阴影。头像最长边 99–128 px，四周 2 px；身体贴图最长边 71–115 px，透明边距 1–2 px。所有缩放保持原图宽高比。

同一 Cocos 镜头、待机 0.2 秒时，当前身体网格宽、高为原版 0.888–1.128 倍，底边差小于 0.01 视口像素；此数据含透明边，不是不同形象的逐像素一致性声明。20 张 PNG 共 52,110 B，含动画 JSON 为 177,653 B；原版对应资源 183,368 B。玩法参数和存档结构保持。

当前工作目录：../AI-Workspace/Work/v1/pet-redesign-20261023/stroke-unification-v4/。提示词、母版、来源、量测和截图均保存在该目录。export.py 仅裁去透明边、等比缩放、编码和编排网格；calibrate-rigs.cjs 校准投影；install.py 同步资源和 UI 规格。before/ 保存修改前 v3，上级 before/ 保存原版。旧版导出器不得覆盖当前资源。

npm run check：1936 项测试和类型检查通过；Web 构建成功，20 张构建 PNG 哈希一致；9000 帧生产动画和 4800 帧浏览器动画检查通过。已检查原版/新版等倍率细看、背包、战斗与营地。本轮未做微信构建或真机验收。交付目录：../AI-Workspace/Deliverables/pet-redesign-20261023/simple-set-v4-runtime/。

## 钻石货币图标（2026-10-23）

钻石货币图标使用原版素材：`boss-system/images/s904.png`（钱包、价格及吸入粒子）、`boss-system/images/s901.png`（奖励与签到）、`pet-system/images/inline-1016-1.png`（宠物及皮肤文字内嵌价格）均已从重设计前的原图备份逐字节恢复。三张图片保留各自原版形象、148×148画布、透明度和留白；资源路径、UUID、锚点与元数据不变。矿山入口的双晶体与镐头仍是独立图标。

原图备份为 `../AI-Workspace/Work/v1/diamond-redesign-20261023/` 下的 `diamond-before.png`、`reward-before.png` 和 `inline-before.png`。恢复脚本、文件哈希及验证记录在其 `restore-original/` 目录。之前的 ImageGen 版本只作为设计历史保留，不再用于当前游戏；后续维护不得用旧重绘脚本覆盖已恢复的原图。

## 关卡物件画风与人物比例（2026-10-23）

建筑命中特效按当前贴图的不透明轮廓定位，包含锚点、旋转、缩放和受击弹跳；停止的弓箭在实际命中点保留0.05秒接触画面。此调整只作用于表现，原伤害和碰撞判定保持。替换 `art/stages/config.json` 引用的建筑图片后，运行 `node tools/sync-tree-hit-surfaces.cjs --write` 更新 `TreeHitSurfaceData.ts`；回归会核对轮廓数据与图片一致。

10 套场景的 40 张物件已分两批统一重绘。第一批 22 张获用户认可后，其余 18 张以这批成品为直接画风参考，并继续对照原版树木的暖棕圆润描边；保留各物件题材，减少细碎绳结、编织、木纹、苔藓、铆钉与高光，使用简洁大色块。全部物件都是无表情、无自主移动的场景道具。第 4、5、6、8、9 套地图的上下边墙继续复用原版图块。

第一批资源与记录保存在 `../AI-Workspace/Deliverables/stage-art-refinement-20261023/`。第二批 18 张的生成原稿、最终提示词、导出素材、尺寸与体积清单、40 张总览及最新实机验证保存在 `../AI-Workspace/Deliverables/stage-art-unification-20261023/`；修改前快照及复现脚本在同名 `AI-Workspace/Work/v1` 目录。第二批只替换这 18 张 PNG，保留已认可的 22 张、全部地图图块及已校准的显示倍率。

用户进一步确定线宽下限：在相同可见高度下，现版描边只能与对应原版树木一样粗或更粗，不能更细。当前版本使用内置 ImageGen 对偏细或接近临界值的 30 张分别加粗，另 10 张原已足够粗的物件保持不变；保留已认可的造型、配色及人物比例。优先保证外轮廓与主要结构线的厚度、圆润接头和清楚的负空间，不能用加深颜色代替加粗，也不能为统一而把原已较粗的线变细。40 张最终成品共 1,392,960 字节，逐张不超过对应原版预算。

描边校准的原稿、最终提示词、导出 PNG、全部 40 张现用素材清单和同高度对照图位于 `../AI-Workspace/Deliverables/stage-outline-floor-20261023/`。`outline-verification.json` 记录按可见高度归一后的浅斜率侧轮廓实心线宽估算；该近似采样用于筛查和复核，不能代表每一个转角像素，须结合对照图及游戏显示一起检查。后续编辑必须保留此线宽下限。

40 个物件在 `art/stages/config.json` 的各个 `treeSprites[].localScale` 中分别设置显示倍率。参考实机中角色身体（不含武器与阴影）约 4.8 世界单位的高度，普通物件目标为人物的 0.95～1.50 倍，Boss 为 1.85～2.15 倍；桶罐、支架、立柱按各自用途区分，不能再次统一放大到树木的尺寸。具体倍率与目标高度见交付目录的 `scales.json`。

`TreeAppearance` 将该倍率乘到原版普通/首领 `skinScale`，并同步血条位置与首领光点父节点。血条本身保持可读尺寸；受击反弹、排序、碰撞体、敌人分布与战斗数值继续沿用既有逻辑。PNG 的画布、原透明边距、`sizePx`、`sizeUnits`、锚点和 `.meta` 保持原规格，不能通过在贴图内额外留白来缩小物件。重绘导出文件逐张限制在对应原版 PNG 的字节预算以内。

复用原边墙时要同步该地图的 `fillColors`，以免外侧填充与原图产生色差。后续调整应同时核对 10 套地图的普通波、Boss 波、人物比例及受击表现；描边校准版的验证记录位于 `stage-outline-floor-20261023/verification.json` 与 `runtime-verification.json`。旧导出脚本不能覆盖本次加粗后的 PNG、把描边恢复为偏细版本，或恢复之前过大的显示倍率。

木墙、糖果墙和天空城墙（皮肤索引 1、6、9）的上沿存在独立于底边的拼接高度差。`view/MapBorderGeometry.ts` 在左端 64 源像素内使用静态网格校正，并在墙脚前恢复原坐标；原图片、锚点、底边、地面和战斗布局不变。不要用整块缩放或平移替代此校正，也不要回滚已确认的地图美术。换肤会刷新同一网格，其他皮肤恢复原形状。替换这三张上边墙后，运行 `tests/map-border-geometry.test.cjs` 对实际 PNG 的墙顶与两种重叠宽度进行校验，再核对运行画面；新图片若已无缝，应撤销对应校正参数。验收资料在 `../AI-Workspace/Work/v1/map-seams-20261023/`。

## 小队出征加载页（2026-10-19）

启动插画现为三只狐狸结伴出发的手绘场景，正式名称为「小队出征」。源资源位于 `tools/startup-screen/background.jpg`（720×1280，178,240 字节），标题已包含在插画内；不增加字体下载。完整母版、内置 ImageGen 提示词及浏览器对照保存在 `../AI-Workspace/Work/v1/startup-redesign-20261019/`。先前猫小队草稿已被狐狸版取代。

`tools/startup-screen/runtime.js` 继续供 Web 启动遮罩、微信 first-screen 和 Cocos 加载页共用，绘制细进度条、动态百分比、当前加载/失败信息及版本。不得把百分比画死在背景中；保持进度单调、图片失败不阻塞启动和资源释放逻辑。画面主体留在长屏安全区域，新增 UI 文字使用系统字体。修改后运行 `node tools/install-startup-screen.cjs web build/web-mobile` / `wechat build/wechatgame` 同步现有产物；正常构建也会自动执行。此次只同步本地启动资源，没有重新构建引擎或上传微信版本。

本轮完整测试与类型检查通过，最终浅色描边调整后加载页专项再次通过；已检查 9:16 和长屏、失败状态及正常进入游戏。详见 `design-qa.md`；微信真机表现未在本轮验证。

## 资源加载与发布（2026-10-15）

首屏只准备当前战斗：基础角色、已装备武器与皮肤、当前地图及四种树、共享战斗反馈、主 HUD 和教程。启动完成后预热当前武器音效，并在启动五秒后、主线未暂停时预取下一关地图。恢复存档时直接准备存档所在地图；未准备好的地图或首领会暂停战斗计时，失败时显示点击重试。

武器、转生、竞速、讨伐、首领、皮肤的入口与完整面板分开加载。`tools/sync-feature-entries.cjs` 从原配置生成 `art/feature-entries`，只保留入口子树、必要图片及固定文字字形；完整面板在首次点击时加载并复用。入口改图或改字后运行该脚本；`tools/build.ps1` 会自动执行。讨伐与首领战斗贴图只在进入对应战斗时准备当前首领。

微信地图分包按 `common` 和十套地图分别打包，每套包含对应树图；跨地图共享纹理归入 `common`，单包仍遵守 3 MiB 的内部预算。`tools/package-wechat-release.cjs` 在复制发布文件前执行 PNG 无损重编码，要求 Python 与 Pillow；源 PNG 不变，发布目录的 CDN 文件、分包和校验清单使用相同优化结果。

已移除 8 个确认无引用的旧媒体文件、8 组闲置弹丸配置和 49 组闲置枪口配置。被历史回归测试使用的旧弹丸样本存放在 `tests/fixtures/retired-projectile-profiles.json`，不进入运行资源。音效来源资料移至 `tools/weapon-audio-selected-sources.json`；原始文件与修改前配置保存在工作区 `AI-Workspace/Work/v1/loading-optimization-20261015`。资源重导时不要恢复未使用配置或把测试样本放回 `assets/resources`。

运行时字体已精简为 8 个 TTF（当前合计约 309 KB，随提示字库补字略有变化）：主 HUD、金币升级、关卡过场、共享提示、武器界面的三个字体，以及设置的 ASCII 输入字库 `settings-system/font317.ttf`。转生、挑战、Raid、Boss、皮肤的文字均使用位图字库，其配置不再携带废弃的 TTF 路径；不要在重新导出时恢复这些字体依赖。设置里被真实 EditBox 替代的两个隐藏文字节点只保留布局与输入样式配置。23 个旧 TTF、两张隐藏输入图集及原配置已归档到相邻工作区 `AI-Workspace/Work/v1/font-cleanup-20261015/before`。详见 [设置与音频说明](docs/设置与音频说明.md)。

2026-10-16 字体与 JSON 精简：运行时仅保留配置实际引用的 65 张 `latin-fonts` 共用图集（5,300,697 字节），图集像素、字形矩形、有效字距、轮廓与阴影参数均未改变。111 张旧 `*/fonts/*.png`（17,034,506 字节）及元数据已备份到 `AI-Workspace/Work/v1/font-json-optimization-20261016/before` 后移出项目。`tools/optimize-resource-data.cjs` 会拒绝存在目录加载或旧字体动态路径的清理；不得将没有路径命中直接推广为任意资源可删除。

已具备 `bitmapFonts[key]` 的 `textProfiles[key].advances` 留作空字典：西文字宽由 `glyph.advance` 决定，中文由系统字体实测；没有位图字体的旧 TTF 配置保留完整字宽表。字距表仅移除左右任一字形不在 `glyphs` 中的记录，支持的字形对与运行参数完全保留。`sync-feature-entries.cjs` 会在裁出入口字形后再清理这些不可达记录。重新导出后先运行 `node tools/optimize-resource-data.cjs --check`，如需写入必须指定项目外的新备份目录，并完成全套测试。

挑战界面使用 `assets/resources/art/speedrun-system/config.json` 的原版1080×1920节点、图片、位图字体和动画数据，按宽度缩放；由 `SpeedRunHud` 呈现。导出工具为工作区 `convert_original_speedrun.py`。PlusPack、扫荡、免广告推广与付费子树及其独占图片已剔除，禁用的Image组件不得恢复绘制。挑战地图继续使用现有地图与树资源，场景原点为 `(-100,0)`；地面按原版shader的未平铺UV裁切为半径76.8的圆盘，经原镜头投影呈椭圆。主线保持原地图材质效果。进入/退出挑战保留全局弹丸、特效与连续时钟，不能沿用普通主线重开的清池逻辑。详见 [挑战说明](docs/挑战说明.md)。

Raid（突袭）界面和5种每周轮换的突袭首领由 `assets/resources/art/raid-system/config.json`、`visuals.json`维护，使用工作区 `convert_original_raid.py`从原Unity数据导出。保留免费准备、选枪、任务、战斗、结算的节点坐标、字体、内嵌星石图标、按钮反馈及结果动画；付费助手、任务券、储蓄、重复领取和联网排名子树在导出时剔除。换图不可恢复这些分支。完整规则与验收边界见 [Raid说明](docs/Raid说明.md)。

原版 Raid（突袭）与 Boss（BOSS玩法）是独立模块；`raid-system` 只维护突袭资源，`boss-system` 维护已接入的独立Boss。`RaidBossView`、原版 `Raid_Boss` 和 `raid-system` 内的 `boss` 字段均指突袭首领；保留原始对象名与资源引用，避免破坏来源核对。

独立 Boss 的 `assets/resources/art/boss-system/config.json`、`visuals.json`由工作区 `convert_original_boss.py`导出，运行时由 `BossHud`、`BossView`和 `BattlefieldView`使用。准备、战斗、胜败和九种龙保留原节点、字体及部件动画；PlusPack、扫荡和购买推广子树已剔除，不应随换图恢复。规则及本轮验收边界见 [BOSS说明](docs/BOSS说明.md)。

皮肤功能使用 `assets/resources/art/skin-system/config.json` 的原入口、四列列表、详情节点和位图字体，以及 `visuals.json` 的 25 套角色部件与持枪手颜色。工作区 `convert_original_skins.py` 按原 mesh 导出 225 张刚性部件，复用基础猫的 9 骨骼与动画；`SkinHudColorPipeline` 仅在皮肤弹窗打开时处理背景捕获和线性混合。完整规则、资源维护约束与验收状态见 [皮肤说明](docs/皮肤说明.md)。

本项目采用“**单图和动画数据用于维护，图集用于发布优化**”的方式。不要把所有资源手工塞进同一张大图，也不要把人物改成一张静态整图来替代现有动画。

## 旅行与能力资源维护（2026-10-18）

旅行使用 `assets/resources/art/adventure-system/config.json`，由 `AdventureHud`、`AdventureCamp` 和共享的 `OriginalWeaponUi` 呈现。导出器是 [convert_original_adventure.py](../AI-Workspace/Work/v1/tools/convert_original_adventure.py)，只读原包并写出旅行资源；依赖同目录的原版场景读取、通用 UI 和位图字体导出工具。在 `Project` 下可执行 `C:\Python311\python.exe -B ..\AI-Workspace\Work\v1\tools\convert_original_adventure.py`。重导后执行 `node tools/sync-feature-entries.cjs` 同步轻量入口，再按现有资源检查流程核对引用、字形和元数据。

九个原根节点依次为 `level0:1419`（入口）、`:977`（主面板）、`:1248`（地图列表）、`:126`（派遣）、`:1228`（宠物选择）、`:1612`（取消确认）、`:611`（领奖）、`:1042`（能力详情）和 `:1543`（抽取结果）。配置的 `source`、节点 ID、组件引用、图片 `source` 和文字 profile 保留原始追溯关系；旅行/能力管理组件为 `level0:123441`、`:123933`。不要用节点名或中文文案推测并替换原始 ID。

原始引用图为 `../CatGunner-Original/Art/evidence/full-reference-graph.json.gz`，行为依据为 `../CatGunner-Original/Decompiled/native/Assembly-CSharp/Adventure_manager__t7406.c`、`Relic_manager__t7421.c` 及各弹窗方法。`tests/adventure-ui.test.cjs` 核对资源结构、面板构造和关键交互；这类自动化检查不能代替原版整屏截图或实际渲染对照。

[导出记录](../AI-Workspace/Work/v1/adventure-20261018/export-report.json) 保存配置 SHA-256、九个根节点和剔除列表，以及节点、图片、字体页和营地对象数量。该记录只证明本次提取的数据与资源范围，不是构建、浏览器操作或视觉验收报告；其 `visualVerification` 字段明确记录导出时尚待截图检查。

保留原 1080 参考宽度、锚点、九宫格边距、遮罩、填充方向、字体与内嵌核心图标度量，以及 `tweens` 中的动画参数。图片的资源路径可能复用其他模块的同源图片；不要因旅行目录没有对应 PNG 就复制或重命名。`bitmapFonts` 和 `textProfiles` 继续遵守项目的中文/西文混排规则，重导不能恢复废弃 TTF 或冗余字宽表。入口只加载 `art/feature-entries/adventure`，完整界面资源属于 `adventure` 功能模块。

营地来自 `Adventure_RenderTexture_Map` 场景：原相机 `level0:2299`、19 个宠物位置和各级变换链投影到 `level0:2151`，静态图形和宠物网格共用相机坐标。宠物复用 `PetVisualAssets`、`PetAnimation` 和已导出的十级骨骼资源，不能换成静态头像或省略相机父节点旋转；布局变化只调整一次投影比例。共享图片和宠物资源不随单个旅行面板关闭或销毁而释放。

PlusPack、付费核心及原版隐藏的强制完成分支不开放，导出器的 `EXCLUDED` 和配置 `source.excluded` 记录相关剔除节点。收益、价格、概率及成长表不由 UI JSON 驱动；三份 300 项能力表通过 `tools/extract-adventure-balances.py --check` 对照原场景，实际数值维护于 `EconomyConfig.ts`。规则、原版浮点边界和验收范围见 [旅行与能力说明](docs/旅行与能力说明.md)。源码备份和本轮检查工作目录为 `../AI-Workspace/Work/v1/adventure-20261018`；此处不代表构建、截图或微信真机验收已经完成。

## 当前资源接口

`assets/resources/art/catalog.json` 是基础外观入口，运行时通过以下稳定 ID 读取；当前七类 65 把武器的实际换装数据由 `weapon-system/visuals.json` 提供：

- `characters.cat_basic`：原版基础猫；保留原资源 ID 和路径，`rig` 指向原骨骼和动画 JSON。
- `weapons.bow_D`：构造角色时的打猎弓外观和出箭挂点，当前指向 `art/weapons/redesigned/bow_D_1452001`；实际武器外观随装备 ID 从 `weapon-system/visuals.json` 读取。
- 树木、阴影及基础效果资源由同一清单管理；地图和复杂反馈有独立配置，见下表。

图片路径相对于 `assets/resources`，不带文件扩展名。例如图片 `assets/resources/art/weapons/redesigned/bow_D_1452001.png` 在清单中写为 `art/weapons/redesigned/bow_D_1452001`。代码会加载该图片导入后生成的 `spriteFrame`。

当前实际目录是：`characters/cat_basic`（`rig.json`、`parts`、脸和手部）、`weapons/redesigned`（65 把当前武器）、`enemies/tree_pine`、`enemies/tree_round`、`maps/forest`、`effects` 和 `hud`。血条、伤害数字、金币飘字、金币粒子和关卡界面分别维护。`source_layout.png`、原始动画曲线和粒子参考数据保存在 `E:\gunner\AI-Workspace\Work\v1\art-reference`，其中 `provenance-manifest.json` 及各专项 evidence JSON 记录溯源；这些对照资料不进入运行图集。

| 表现 | 维护入口 |
| --- | --- |
| 角色的朝向、双手/脸部、后坐力、动画速度和切换 | `characters/cat_basic/rig.json` 的 `dynamics` |
| 第一关地面、18×18 平铺、完整边界及填充 | `maps/forest/map.json` |
| 地面原始平面光照 | `maps/forest/original-floor.effect` 与 `map.json` 的 `ground.lighting` |
| 树木受击与血条、旋转准星 | `effects/original_feedback/config.json` |
| 原版数字字体、65 点曲线与子弹/命中粒子 | `effects/original-feedback.json`；数字单图在 `effects/damage` |
| 枪口双层火星/光晕 | `catalog.effects.muzzle` |
| 普通关卡 HUD、五波节点、顶部双进度条、设置和货币显示 | `hud/config.json`；独立图片和字体在 `hud` |
| 底部攻击力、攻击速度、金币获取三卡 | `upgrades/config.json`；8张图片与中文标题字体在 `upgrades`，攻速使用下述v4闪电设计 |
| 树木死亡爆出的现金粒子 | `effects/money-burst/config.json`，使用原版 `cash_atlas.png` 的3×3绿色纸币图集 |
| 金币飘字、现金前缀图标及动画 | `effects/money-numbers/config.json`；使用原 Font315 的绿色金额字形与现金图标 |
| 场景线性混合与最终显示转换 | `rendering/original-sprite.effect`、`original-graphics.effect`，由 `OriginalColorPipeline` 管理 |
| 当前 65 把武器的图片、握点、枪口、后坐力与弹道外观 | `weapon-system/visuals.json`；由 `WeaponVisualAssets` 按武器 ID 加载 |
| 武器背包、详情、图鉴、概率与升星界面 | `weapon-system/config.json`，由 `OriginalWeaponUi` 和 `WeaponHud` 使用 |
| 暴击数字、品质效果和共用音效 | `weapon-system/critical/config.json`、`weapon-grade-effects/config.json`、`original-sfx/config.json` |
| Raid（突袭）入口、准备、选枪、任务、战斗、结果与位图字体 | `raid-system/config.json`，由 `RaidHud` 和 `OriginalWeaponUi`使用 |
| Raid（突袭）地面、5种突袭首领部件、待机/受击动画、入场与死亡粒子 | `raid-system/visuals.json`，由 `BattlefieldView` 和 `RaidBossView`使用 |
| 独立Boss入口、准备、战斗、胜败、奖励与位图字体 | `boss-system/config.json`，由 `BossHud` 和 `OriginalWeaponUi`使用 |
| 独立Boss地面、九种龙的部件、头像、待机/行走/死亡及受击表现 | `boss-system/visuals.json`，由 `BossView` 和 `BattlefieldView`使用 |
| 皮肤入口、四列列表、详情、价格钻石及位图字体 | `skin-system/config.json`，由 `SkinHud`、`OriginalWeaponUi`、`OriginalWeaponScroll` 使用 |
| 25 套猫身体、原 mesh 裁切与持枪手颜色 | `skin-system/visuals.json`、`skin-system/characters/<id>/`，由 `SkinVisualAssets` 和 `CatView.setSkin` 使用 |
| 皮肤弹窗的背景捕获、线性叠加和显示转换 | `SkinHudColorPipeline`，复用 `rendering/original-sprite.effect`、`original-graphics.effect` |
| 旅行入口、三张地图、派遣/选择/取消/领奖、能力详情和抽取结果 | `adventure-system/config.json`，由 `AdventureHud`、`OriginalWeaponUi` 使用；轻量入口为 `feature-entries/adventure.json` |
| 旅行营地静态图形、相机投影和19个宠物位置 | `adventure-system/config.json` 的 `camp`，由 `AdventureCamp` 使用；宠物骨骼共用 `PetVisualAssets` |

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
| `color` | 可选 RGBA 乘色，四通道范围 0～255；原版持枪手使用 `[241,210,172,255]` |

首次换图时先保持 `sizeUnits` 和 `anchor`，只替换图片内容，可避免整个人物忽大忽小或脚底漂移。需要改造型比例时，再有意识地调整显示尺寸和挂点。

角色的12张 PNG 已从换图前备份恢复为原版猫，与初始 Git 版本及 `art-design/cat-original-reference` 逐字节一致。持枪手乘色、尾巴裁切元数据和猫头像引用同步恢复。十套地图、40种树木以及基础森林的备用资源也已恢复原图及必要导入设置，保留现有资源 UUID、骨骼和动画。恢复前备份与逐文件校验记录位于 `E:\gunner\AI-Workspace\Work\v1\qa\restore-original-art-20261011`；此前设计稿作为工作区历史资料保留。

## 关卡界面与金币反馈

`GameHud` 按 `BattleHudState.mode` 管理界面。只有 `Main` 创建 `Main_UI`；切换到普通挑战或Raid时移除该根节点，返回后重新建立，各模式使用自己的HUD。五波节点及 `Stage 1-1` 的显示使用独立的 `stageIndex`、`waveIndex`；击杀百分比不能当作波次编号。主线每波180秒，清场进入下一波，超时重试；普通挑战和Raid分别按各自60秒流程结算。

HUD 的 `layout` 保留原版 1080 宽 Canvas 坐标，通过整体缩放适配屏幕宽度，并从安全区顶部定位；它的图片 `sizeUnits` 是参考 UI 像素，不是地图世界单位。调整位置和尺寸优先改 `hud/config.json` 的 `layout`，颜色改 `palette`，不要把屏幕适配缩放重复乘进配置。`settingsPosition`、`settingsSize` 控制左侧设置图标，目前没有点击处理。顶部先绘制时间条，再绘制清场进度条，原本存在交叠；填充使用九宫格图片加裁剪，不能压缩图片宽度来代替进度裁剪。

进度条斜纹由 `images.hatch` 和 `palette.hatch` 指定，运行时在裁剪区域内平铺。平铺宽度为 100 参考像素，滚动使用战斗 `elapsed` 每秒推进一格；如需改动平铺密度或速度，修改 `GameHud` 的 `StageHud` 构造和更新逻辑。暂停期间不使用系统时间继续滚动。字体、描边和阴影在 `font` 配置中维护；当前 `MPLUSRounded1c-Black-ASCII.ttf` 是原字体 Font320 的 U+0020–U+007E 子集，只覆盖英文关卡文本、数字、符号及金额单位。加入中文或其他字符时应重新导出所需字形或另配字体，不能认为原字体子集已包含中文。中文结果卡仍使用独立字体设置。

关卡进度头像已恢复原版 `hud/cat_icon.png`，配置键为 `images.cat_icon`，加载路径为 `art/hud/cat_icon`；保留128×95画布、原锚点、显示尺寸、`.meta` UUID及布局字段 `catSize`、`catOffset`。攻击力 `upgrades/power.png`、钻石 `hud/diamond_icon.png` 以及转生、武器、突袭、挑战入口继续使用原版图片。攻速图标已按下述 v4 闪电设计统一替换。此前狐狸头像及其他入口设计保存在工作区历史资料中。

### 攻击速度闪电图标（2026-10-15）

当前攻速图标使用 [v4 透明 PNG](../AI-Workspace/Deliverables/attack-speed-lightning-20261015/v4/speed-lightning-180.png)，沿用青蓝、浅蓝白、金橙配色与深棕粗描边。以下五份运行图片必须保持相同内容：`upgrades/speed.png`、`weapon-system/images/s383.png`、`raid-system/images/s383.png`、`rebirth-system/images/s383.png`、`skin-system/images/s383.png`。它们覆盖主界面升级1处、武器装备槽及详情4处、突袭装备槽及禁用说明4处、转生强化1处、皮肤累计及详情2处，共12处显示。

替换直接复制180×180透明PNG，保留资源路径、`.meta` UUID、尺寸、无裁边设置、pivot和布局。突袭禁用说明的 `inlineSprites["raid-upgrade-2"]` 仍引用 `s383`，删除斜线由 `OriginalBitmapText` 叠加；历史 `inline-1017-2.png` 当前未使用。配置中的 `source=sharedassets0.assets:383` 保留为原始语义来源，当前美术以v4交付为准。旧图、导入元数据与配置备份及替换哈希见 [接入记录](../AI-Workspace/Work/v1/art-design/attack-speed-lightning-20261015/v4/integration/installed-manifest.json)。重新从原Unity导出上述模块后，应重新同步这五张已确认的闪电图标。

`hud/money_icon.png`、`upgrades/cash.png`、`upgrades/money.png` 三处货币图已从 `ui-icons-v1/reference` 逐字节恢复原版 PNG，各自分辨率、透明度及留白均恢复原值。前两张为148×148，第三张为180×180；保留原布局、显示尺寸、pivot和 `.meta` UUID。上述图标的 `source` 均指向原版来源。战斗奖励粒子和飘字也恢复为下述原版素材配置。

以下原版 ID 用于查证来源，运行时继续引用上述稳定资源路径：

| 内容 | 原版来源 |
| --- | --- |
| `stage_background` / `stage_fill` / `stage_hole` / `stage_dot` | `sharedassets0.assets` 的 Sprite660 / 390 / 736 / 684 |
| `cat_icon` 原猫头像 | `sharedassets0.assets` 的 Sprite821 |
| `bar` / `bar_outline` / `settings` / `hatch` | Sprite482 / 466 / 510 / 144 |
| `money_icon` / `diamond_icon` / `currency_background` | Sprite375 / 904 / 658 |
| HUD 字体、字效与金额单位表 | Font320，TMP 字体资源1006、材质75；`resources.assets:2068` |
| 现金粒子 | `level0:72018`，池148042，Renderer79812；Texture136 / Material41 |
| 金币飘字 | `level0:137998` 的 `money` 配置 → prefab960 / animation1025；Font315 → Material38 → Texture98 |

树木奖励包含两种独立表现。现金粒子从树根上方 Y=2 产生，每棵普通树显式发射5个；不要误用序列化播放 burst 的25个，也不要改为飞向货币栏的收集效果。粒子使用原版 `effects/money-burst/cash_atlas.png` 的128×128、3×3绿色纸币，`tiles=[3,3]`；独立纹理保持 `packable=false`，图集切帧保留原版分数UV。发射速度、随机采样、旋转、碰撞及尺寸收尾曲线继续按原配置运行。

金币飘字从树根 Y=0 出现，使用原版1.5秒、50套随机动画及每套65个采样点；`gap=-0.36`、`worldScale=0.02` 对应原 `spriteGap=-18`。42个字形映射包含数字、字母、单位别名、小数点及字符 `+`，全部使用 `effects/money-numbers/glyph_*` 的原 Font315 图片；`+` 为原现金前缀，其余为原绿色字形。`DamageNumbers` 每次生成或复用节点都会重设字形乘色，保持共享节点的颜色正确。伤害沿用 Y=2、0.12秒间隔，金币沿用 Y=0、0.2秒间隔，两者共享按世界 **X/Y**、1.5单位分桶的冷却表，不能按地面 X/Z 或每棵树分别限流。换肤前后备份保存在工作区，当前资源与原版金币导出配置一致。

奖励数值在 `BattleSession` 消费死亡事件时立即入账，不等待粒子消失；飘字被冷却抑制也不能少发奖励。当前首波两种树基础奖励为20/36，乘以当前金币获取百分比并保留小数。余额和三项升级等级写入本项目的本地存档，测试与生产环境隔离；重开保留经济状态，只清空树 ID 结算记录。不读写原游戏存档。美术替换不应改变这些规则。

`UpgradeHud` 使用与顶部同宽的1080参考坐标，从底部安全区定位。按钮、图标、价格底板与闪光均来自原版；标题字体使用原 NotoSansSC Bold 的所需汉字子集，数字沿用 HUD 的 Rounded Mplus。修改卡片布局、配色和交互参数时以 `upgrades/config.json` 及 `original-upgrades-evidence.json` 为准。余额不足使用原面板自下向上裁切，不能拉伸图形代替；文字缩写仅影响显示，不能反过来作为余额或扣款值。满级显示 `Max`。

攻击升级后伤害可能超过普通数值范围，`effects/damage` 已补齐原 Font313 的42个字符槽，包含金额单位及科学计数法所需字母和小数点。Font313 的 `+` 源槽本来全透明，保留其间距；它与奖励 Font315 的现金图标不同，不补画加号。只读检查仅对源哈希完全匹配的这一透明槽放行。数值使用十进制大数，逐级截断规则在 `UpgradeEconomy`，不属于美术参数。

现金粒子和飘字使用死亡事件的 `sourceTime`，出生帧只推进该物理时刻至当前 `world.simulationTime` 的时间，不提前消耗整个画面帧。后续动画使用缩放战斗时钟，清场后仍继续，暂停和切后台则冻结；结果遮罩等所有奖励表现结束后才显示。重开和模式切换清除活跃效果及飘字冷却；池保留已分配节点供复用。现金粒子使用独立 xorshift 随机流，飘字选曲线使用表现随机，均不消费 `CombatWorld` 的射击随机序列。

金币相关参数来自原粒子配置和方法调用，但本项目的 120 Hz 积分、速度阻尼、扫掠盒碰撞和随机采样是跨引擎实现；不能用参数一致推断与 Unity 的每条轨迹逐位相同。HUD 的原始布局和图片已保留，TMP SDF 描边/阴影通过 Cocos 字效适配，也不等同于原引擎逐像素输出。

## 武器外观配置

角色的 `rig.json` 通过 `attachments.gun.weaponId="bow_D"` 引用 `catalog.json` 的 `weapons.bow_D`，用于构造初始打猎弓外观。加载武器系统后，`CatView.setWeapon(id)` 使用 `weapon-system/visuals.json` 的 `weapons` 数组更新实际图片、握点和枪口；维护当前 65 把武器时，应按 `id` 找到对应条目，并同步当前初始武器的 catalog 项。角色骨骼和手部挂点仍在 `rig.json` 中维护。

| 要调整的内容 | 修改位置 |
| --- | --- |
| 枪械 PNG / 像素尺寸 / 显示尺寸 | `weapon-system/visuals.json` 对应武器的 `image.path` / `sizePx` / `sizeUnits` |
| 图片上的握点和旋转基准 | 对应武器的 `image.anchor` |
| 图片相对持枪挂点的微调、角度和翻转 | 对应武器的 `image.localPosition` / `localRotationDeg` / `localScale` |
| 枪口在图片局部坐标中的位置 | 对应武器的 `muzzle.localPosition` |
| 角色由哪根骨骼持枪、手上的挂点位置 | `rig.attachments.gun.bone` / `localPosition` / `localRotationDeg` / `localScale` |
| 改用另一把已配置的武器 | 通过背包装备对应 ID，由会话同步到战斗和 `CatView.setWeapon`；不是修改 `rig.attachments.gun.weaponId` |

`muzzle.localPosition` 使用图片局部单位，以 `anchor` 为原点，向右和向上为正，随后继承武器 `localScale`、持枪骨骼、人物比例及投影。当前初始打猎弓的出箭点约为 `[1.0666667,0]`，图片局部缩放是 `[0.42,-0.42]`；不要预先把缩放再乘进挂点数字。调整武器尺寸、裁边或握点后，应同步校正同一配置中的枪口或出箭点。若已知挂点在 PNG 上的像素坐标 `[px,py]`（左上原点），可换算为 `[(px/width-anchorX)*sizeUnitsX, (1-py/height-anchorY)*sizeUnitsY]`。

人物 `rig.display.scale=0.55` 由外观层统一应用一次；图片 `sizeUnits`、骨骼和枪口数据都不提前乘该系数。武器配置中的 `source`、`trim`、`sourceTransform` 是原版溯源资料，不是另一个运行参数入口。

### 当前 65 把武器：v2 造型与 208 像素运行贴图（2026-10-16）

七类、13 品阶共 65 把武器以 [weapon-redraw-cohesive-v2-by-grade-20261014](../AI-Workspace/Deliverables/weapon-redraw-cohesive-v2-by-grade-20261014/manifest.json) 的最终 `final512` PNG 为造型来源；C 级猎弩 ID63 使用下述 2026-10-15 同级比例 v5。2026-10-16 按用户要求压缩全部运行贴图，当前画布长边为 208 像素、主体长边最多 204，四边至少 2 像素透明边距，65 张合计 1,816,960 字节。采用 Lanczos 缩图和 RGBA PNG 优化，不减色、不追加描边；原高清素材均保留。基础包的 512 像素与 ID63 原生尺寸只适用于来源归档，不能再作为运行资源检查条件。

接入入口为 [install.py](../AI-Workspace/Work/v1/art-design/weapon-game-integration-v2-20261014/install.py)，逐件来源、哈希、运行路径、原外观和新挂点见 [installed-manifest.json](../AI-Workspace/Work/v1/art-design/weapon-game-integration-v2-20261014/installed-manifest.json)，修改前文件位于同目录 `game-backup/`。65 个存档武器 ID、运行资源路径和 `.meta` UUID 保留；SpriteFrame 的尺寸、UV、无裁边设置、ppu 与 pivot 随新图同步，纹理过滤及 packable 设置不变。`catalog.weapons.bow_D`、`weapon-system/visuals.json`、武器 UI 与 Raid UI 使用同一套新图。

尺寸由 `sizeUnits=sizePx/ppu` 保持等比。压缩后的 ppu 根据每张实际 alpha≥16 轮廓及原绝对尺寸目标重新计算；七把弓主体高仍为 `137/7.5` 单位，战斗缩放和每阶 3% 规则保持。握点、上下弦端和静止弦坐标随缩图映射，`drawPx`、`handRetreatPx`、`lineWidthPx` 按 ppu 比例换算，保持原世界距离与弦宽。所有武器的原出弹变换、战斗缩放、图片位置、动作、数值、特效及音效均保留；另一轴轮廓的像素取整差异低于 2%。当前数据以 `weapon-system/visuals.json` 和测试资源清单为准，重新运行旧高清安装器后必须重新压缩并同步注册。可复现脚本与备份见 [压缩目录](../AI-Workspace/Work/v1/weapon-image-compression-20261016/report.json)。

两份 UI 配置同步实际 `sizePx`、`sizeUnits`、`anchor`、`ppu`、可见边界与凸包；凸包按 alpha≥16 的可见像素取样。七弓继续共同引用 `bow_D_1452001`，该参考项的 `uiHeightReferenceFrame` 冻结替换前 `[75,143]` 画布与凸包，以保留原 UI 展示尺寸；`uiBowString` 与战斗中的静止弦坐标同步。后续换图不要清掉此冻结框，除非有意调整全部弓的 UI 尺寸。

以下三把扇子的最终源文件名与稳定运行名不同；按游戏 ID 和清单映射安装，不能因文件名差异改动存档 ID：

| 游戏 ID | 最终源文件键 | 保留的运行文件键 |
| --- | --- | --- |
| 17 | `fan_S_1292002` | `fan_S_1292008` |
| 21 | `fan_SS_1292005` | `fan_SS_1292009` |
| 41 | `fan_XXX_1292035` | `fan_XXX_1292016` |

11 根法杖最终图为竖向，战斗 `image.localRotationDeg=90`、`muzzle.localRotationDeg=90`；图片的 Y 负缩放使两次旋转保持原发射器方向。UI 仍使用竖向原图。不要只旋转图片而遗漏枪口子节点的角度。

本轮独立静态审计核对了 65 张源图哈希、65 套 SpriteFrame 和 196 处武器资源引用，未发现遗漏；备份对比确认外观条目只改 `image`、`muzzle`、`supportGripPx`、`bowString`，其余武器字段及非武器表现数据不变。测试 924/924、类型检查以及 test 环境 Web 和微信小游戏构建已通过；两个构建各 65 张原生 PNG 均与批准图逐字节一致。网页运行验收完成：65 件左右持握共 130 个画面、左右攻击共 130 次视图调用，人工查看七类持握接触表、九件代表武器攻击效果和全部图鉴；七类代表及 Z/ZZZ 火炮还经过实际装备与战斗推进。截图与审查记录位于本轮工作目录 `runtime/`。测试使用临时内存存档；放大角色仅用于检查，未写入游戏配置。微信端完成构建及资源审计，未进行微信设备运行验收。

### 当前 C 级猎弩：同级比例及内外线条 v5（2026-10-15）

ID63 `crossbow_C_1462003` 当前使用 [v5 批准图及清单](../AI-Workspace/Work/v1/art-design/hunting-crossbow-c-proportions-v5-20261015/manifest.json)，替代下述 v4。原生透明 PNG 为 1378×1141，SHA256 为 `2397120baff89414c77ac83bf6f0c4a63071fd35ab9d88ca2867d2a635400eab`；直接逐字节复制，保留定稿内外线条，不再次处理像素。可见高宽比约 0.81973，与另一把 C 级弩 ID3 的 0.82549 接近，比 v4 的 0.56434 更饱满。

挂点见 [registration-v5.json](../AI-Workspace/Work/v1/art-design/hunting-crossbow-c-proportions-v5-20261015/registration-v5.json)：握点 `[175,584]`、前托点 `[650,584]`、中轴 U 口出箭点 `[1287,584]`。alpha≥16 包围盒为 `[14,15,1362,1120]`；`ppu=79.13894324853229` 保持可见宽度 `511/30` 单位，当前战斗缩放 `[0.3925845,-0.448668]`、偏移及角度保留。同显示宽度下高度比 v4 增加约 45%，与其他 C 级弩的体量接近。

SpriteFrame、战斗注册、武器 UI 与 Raid UI 使用同一张新图；资源路径、UUID、过滤及其他武器不变。图鉴和当前六个动态 UI 场景的 ID63 缩放按现有尺寸同步工具更新，政策文件不改。独立 fixture 校验原图哈希、原生尺寸、透明轮廓与挂点。安装脚本、修改前备份和验证记录位于 v5 目录的 `game-integration/`。该版本优先于旧 v2 全武器和 v4 单武器安装记录；不要重跑旧安装器覆盖它。

### 历史 C 级猎弩紧凑造型及加厚外描边 v4（2026-10-15）

ID63 `crossbow_C_1462003` 的历史 v4 使用 [批准原图及清单](../AI-Workspace/Work/v1/art-design/hunting-crossbow-compact-v4-outer-20261015/manifest.json)，现已由上述 v5 替代。原生透明 PNG 为 1672×940，逐字节安装，SHA256 为 `c83a9b8f965b1ac3f66f2928936ddefbd49dc905792ee0730d12beba11a60bbd`。外形采用收窄的后掠弩臂、保留开孔与中轴 U 形出口，使用 C 级深棕线色、灰白及木棕配色。

挂点见 [registration-v4.json](../AI-Workspace/Work/v1/art-design/hunting-crossbow-compact-v4-outer-20261015/registration-v4.json)：握点 `[230,497]`、前托点 `[775,497]`、出箭点 `[1576,497]`。alpha≥16 的可见包围盒为 `[20,13,1652,934]`。`ppu=95.81213307240705` 保持原可见宽度 `511/30` 单位；接入时战斗缩放 `[0.3925845,-0.448668]`、偏移和角度保留，因此可见高度降至旧图约 66.6%。注册同时更新两份 UI 图片配置、SpriteFrame 和可见凸包，资源路径及 UUID 不变。

图鉴、背包和装备栏的 ID63 显示缩放由现有 `sync-weapon-collection-sizes.cjs`、`sync-weapon-inventory-sizes.cjs` 重新计算。当前尺寸以三份尺寸策略和各同步工具为准，上节 v2 接入时的固定缩放属于历史快照。ID63 的原生尺寸、哈希、alpha 包围盒由独立测试 fixture 校验，其余 64 张保留基础包尺寸约束。安装及修改前备份位于该 v4 目录的 `game-integration/`。

### 历史八弩重绘 v4 的维护约定

以下记录保留 v4 当时的素材和参数，当前安装以以上 65 把武器 v2 接入清单为准。

八把弩按 `1、62、3、63、6、64、10、14` 展示，分别对应 D/D/C/C/B/B/A/S，素材键依次为 `crossbow_D_1462001`、`crossbow_D_1462210`、`crossbow_C_1462028`、`crossbow_C_1462003`、`crossbow_B_1462029`、`crossbow_B_1462006`、`crossbow_A_1462011`、`crossbow_S_1462125`。它们是当前 65 把武器中的八项；59–61 仍是上一版新增的三把弓。美术按上传的原枪械参考保持线条粗细和厚度：用厚深棕实体框架包住内嵌品阶色块，外轮廓与内部隔线一并画进图片，通过浅层分区阴影表现厚度，不画明显反光或镜面高光。握把的长度、宽度尽量一致，品阶通过主题色、轮廓和装饰区分。

导出保留原图非零 alpha，只做等比缩放、紧裁切和四边 3 像素透明边距；不能通过分别缩放宽高强行对齐握把，不能恢复旧 `256×143` 大留白画布。`sizePx` 取实际 PNG 尺寸，`ppu=7.5`，`sizeUnits=sizePx/ppu`，战斗缩放保持 `[0.56,-0.64]`。握点、前托点与出箭口从原图注册同步换算；锚点为 `[gripX/width,1-gripY/height]`，图片偏移继续使用 `hand.localPosition−gun.localPosition`，前托点仅作为美术定位资料。保留原枪械双手、瞄准、伸缩后坐和角色绘制阶段。

图片自身已包含完整结构线，战斗与 UI 使用同一素材，不增设描边叠层或额外轮廓节点，不使用固定纹理尺寸的弩描边 shader。图鉴、背包、详情、获得弹窗和 Raid 按全部非零 alpha 的 `uiVisibleBoundsPx` 与 `uiVisibleHullPx` 居中；`.meta` 的实际尺寸、pivot、无裁边设置同步更新，并保留已有路径的 UUID。新增路径使用稳定 UUID。

v4 使用局部接入器 [install_crossbow_redraw_v4.py](../AI-Workspace/Work/v1/tools/install_crossbow_redraw_v4.py)，源图、注册与清单位于 [crossbow-redraw-v4](../AI-Workspace/Work/v1/art-design/crossbow-redraw-v4)。该历史工具会更新八套 appearance、两套 UI 注册、新增图鉴卡和必要中文字形，不用于当前 65 把武器的日常换图；不得重跑它或早期全量 59 武器安装器覆盖后续修订。历史版本的通过记录也不替代当前接入验收。

## 皮肤资源维护

`skin-system/visuals.json` 的每款皮肤包含 9 个 `RigPart`、原 mesh 来源和 `handColor`。25 个 mesh 共用基础猫 bind pose，但各自裁边和三角形绘制顺序不同；维护时保留 `bone`、`anchor`、`localPosition`、`localRotationDeg`、`localScale`、`drawOrder` 与原 `.meta`。不要把不同皮肤统一成基础猫的部件画布或裁切尺寸。角色最终显示比例仍由 `rig.display` 应用一次。

`CatView.setSkin` 只替换身体、更新持枪手颜色，保留武器、脸、描边、动画时钟、瞄准和后坐力。旧皮肤的骨骼跟随节点须从 `poseFollowers` 清除，隐藏猫和后续新猫也需继承同一个选中 ID。225 张部件为线性过滤、无 mipmap、`packable=false`；全量 SpriteFrame 在开局加载并由 `ArtLibrary` 共享，不在每次装备时加载或销毁。

皮肤 UI 保留原序列化 alpha，在线性目标上混合遮罩、卡片、图片与位图字体；不要靠改颜色或 alpha 补偿显示空间混合差异。`SkinHudColorPipeline` 创建的背景与线性 RenderTexture、包装 SpriteFrame、材质及相机属于实例；关闭恢复主相机和前景层，销毁释放实例资源。原字体图集、角色部件和其他共享 PNG 不随弹窗销毁。输入适配仅为渲染到纹理的皮肤节点复用引擎屏幕命中查询，仍需保留祖先 Mask 和滚动捕获检查。

资源复核工具为 `AI-Workspace/Work/v1/tools/validate_original_skins.py`，报告及全 25 款 Idle/Walk 拼图在 `AI-Workspace/Work/v1/qa/skins`。原版实机和当前运行资料在 `AI-Workspace/Work/v1/qa/skins-20261011`；最终运行对照状态见 [皮肤说明](docs/皮肤说明.md#验证状态与证据)。

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

HUD 图片、字体和金币位图字形也属于共享资源。`OriginalMoneyBurst` 从共享金币纹理创建的 SpriteFrame 由该视图实例独占，应在显式销毁或父节点销毁时释放一次，不能销毁底层共享纹理。HUD、飘字及金币节点分别归各自所有权根节点管理；异步资源加载期间被销毁、构造中断或父 Canvas 先销毁时，仍须清理已有节点和实例资产。池重置只停用节点，最终视图销毁才释放它们。

人物曲线、粒子及反馈配置已有明确 TypeScript 接口。动画和粒子更新复用工作缓冲以减少分配，调试代码需要保存历史姿态时应复制结果；`OriginalParticleSimulation.pose` 传入输出缓冲会复用该对象，不传时返回独立快照。静态树投影缓存以逻辑 XZ 坐标为依据，改变树的位置应修改逻辑位置，让树身和两层血条一起更新。

参数维护继续以原数据和已有回归为准。此前维护重构已对既有手枪粒子的固定种子轨迹摘要和随机抽样次数建立回归约束；新增现金效果使用自己的随机状态，不应修改这些既有结果。不要为减少代码或分配而改变抽样顺序、曲线采样、后坐及粒子更新阶段。新增图片仍需保留既有资源 ID、锚点和 `.meta` 的维护约定。

皮肤展示统一采用正面朝前、手指端朝下并略向内的固定姿势，25 款及列表、详情、锁定剪影保持一致。左右手需分别旋转，不能都转 180°，否则腕部和指端会倒置。展示双脚相对身体居中，两侧尺寸及落脚高度一致。由 `SkinPreview` 调整共用战斗骨架的展示姿势和脸部位置，继续使用各自的战斗 SpriteFrame，不新增整身预览图，不修改战斗动画；取景框、整体缩放和位置沿用原展示标准。

## 替换步骤

新增或重新生成图片时，应同时对照原版的像素尺寸与文件体积，以接近原版或更小为目标；明显变大时先优化运行用文件，再完成构建验收。高分辨率生成稿放在工作区归档，不直接打入游戏包。压缩优先保留已经确认的轮廓、线条、透明边缘与游戏显示比例，不能只看生成文件尺寸。

2026-10-19 的 25 张统一轮廓衣身已压缩为 149×99 PNG8，总计 279,684 字节；原版对应文件为 327,205 字节。采用逐图高质量减色、无抖动编码，基础轮廓模板的 alpha≥128 形状不变。战斗与皮肤界面继续共用同一组纹理和轮廓材质。详情和逐张对照见 [皮肤说明](docs/皮肤说明.md) 与 [压缩报告](../AI-Workspace/Work/v1/skin-png-compression-20261019/report.json)。如从高清稿重新导入身体贴图，需要重新执行体积和画面对照，不能把较大的中间稿直接当成交付文件。

皮肤身体与脚根的连接必须沿用原版轮廓。`skin-system/body-contour.png` 为直接恢复的原版 149×99 身体，25 款通过 `visuals.bodyContour` 共用其 alpha 和描边，服装 PNG 只提供内部颜色；不得再把生成稿的底边当作模板。左右脚、骨骼注册和遮挡顺序保持原版。新增共用轮廓 6,016 字节，身体图片合计 285,700 字节，仍小于原版总量。

同日尝试的18款领口、肩部补色已按用户要求撤回，服装恢复补色前的原文件，保留原来的浅色领片和肩部留白。此版本为当前采用版本，不要重新运行领口补色导入脚本。25张身体图仍为149×99，合计279,684字节，加原版共用轮廓共285,700字节；原版外描边和已校正的展示手脚姿势继续保留。见[恢复核对记录](../AI-Workspace/Work/v1/skin-collar-fix-20261019/qa/rollback.json)。

1. 以相应资源配置中的实际路径为准，找到对应单图；基础资源看 `catalog.json`，实际武器看 `weapon-system/visuals.json`。保留 PNG 透明通道，优先保持原有画布尺寸和定位。
2. 在原路径覆盖图片，**保留旁边的 `.meta` 文件**；需要改名或搬目录时，在 Creator 内操作并同步更新清单路径。
3. 图片必须以 SpriteFrame 方式导入。项目 `.creator/default-meta.json` 为新图片设置了默认导入类型；已有图片仍检查自己的导入设置。
4. 在 Creator 或 Web 试玩中观察静止、行走、左右朝向、不同射击角度，以及人物经过树木前后时的遮挡。
5. 重新构建 Web 和微信小游戏，确认发布产物显示的是新图片，而非编辑器内的旧预览。

对武器额外核对 `muzzle`；对人物额外核对脚底锚点；对树木额外核对根部与碰撞体的视觉对应。改变图片轮廓不会自动改变 `core/config.ts` 中的碰撞参数。

## 主界面入口图标

2026-10-23 调整武器、挑战等11项侧边入口：图像在此前68×68名义尺寸上放大10%至74.8×74.8；源字号45→47，并同步扩展文字框，避免自动缩字抵消调整。文字子节点局部y=-57，为放大的图像保留间距。完整面板和轻量入口使用相同配置；130×120按钮、点击框、侧栏位置及顶部设置/签到保持原值。

2026-10-19 按用户要求重新生成13张独立透明入口图，全部128×128，紧裁至主体可见边界，无额外四边透明留白，保留造型本身的透明角落和孔隙。总计 78,525 字节。当前PNG、原始高清稿、逐张内置imagegen提示词、清单及游戏截图位于 `AI-Workspace/Deliverables/main-menu-entry-square-128-20261019`；安装脚本、替换前备份及验证记录位于同名 `AI-Workspace/Work/v1` 目录。高清稿不进入运行资源。入口PNG已进一步压缩至接近原版13图总计78,132字节的预算；维持128×128尺寸、完整透明轮廓和原显示配置。

侧边11项保留130×120按钮及点击框，主体统一显示68×68；图标中心左x=-5/右x=5、y=18，文字中心y=-36，字号不变。顶部设置和签到均显示65×65，点击框保持原样。`preserveAspect` 与 `uiDisplayScale` 只作用于图像子节点。配置图片尺寸、sizeUnits和meta帧几何已同步128，保留原UUID、导入设置、anchor和ppu。设置仅保留齿轮；鱼为头左尾右的水平横游姿态，无水滴；武器右上45度；转生为两条完整循环箭头。

武器、转生、矿山、狩猎、旅行继续使用独立 `entry_<id>` 图片键和 `images/entry-<id>.png`，原装备、货币及奖励图片保持独立。后续维护完整模块配置后运行 `node tools/sync-feature-entries.cjs`；勿覆盖这些共享原图，勿给入口追加装备弓弦/轮廓字段。

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
| `convert_original_upgrades.py` | `art/upgrades` 的8张图片、中文标题字体子集及布局；`art-reference/original-upgrades-evidence.json` |
| `export_damage_glyphs.py` | 原 Font313 的42个伤害字形及 `original-feedback.json` 的字形映射；`art-reference/original-damage-glyphs.json`。完整反馈导出也会调用此步骤。 |
| `convert_original_weapons.py` | 65把武器的外观、枪口、弹道、原武器弹窗与字体；完整执行同时调用下列按钮、音效和品质特效导出。 |
| `convert_original_weapon_feedback.py` | 对武器UI配置补入原 BounceBtn、SFX_BtnScript 和首次合成箭头参数。由主武器导出器调用 `augment_ui`。 |
| `convert_original_sfx.py` | `art/original-sfx/config.json`，17个原SFX编号的音量、同帧/50ms限流；复用武器目录的14个独立音频资源。 |
| `convert_weapon_grade_effects.py` | `art/weapon-grade-effects`，13品质根、36个启用粒子系统、6张图片；保留子发射器、轨迹、排序和原shader材质语义。 |
| `convert_original_raid.py` | `art/raid-system/config.json`、`visuals.json`、图片和字体；免费UI原节点、5种突袭首领、独立地面、原结果/待机动画与粒子。配置内的source保留Unity对象引用。 |
| `convert_original_boss.py` | `art/boss-system/config.json`、`visuals.json`、图片和字体；独立Boss原入口/准备/战斗/胜败、九种龙部件及动画。配置保留原source引用并剔除PlusPack、扫荡及付费推广。 |

这些脚本读取原 bundle，写入本项目资源和工作区证据，不修改原版目录。HUD 字体子集转换使用工作区 `hud-python-deps` 中的 fontTools；具体重建依赖见脚本开头。重新导出会覆盖自制美术，应先保存替换成果。修改 HUD 文本字符范围时同时更新导出字符集与运行时字体路径；修改现金 atlas 时保留3×3排布、透明通道及非打包约定。

Raid资源的原始bundle为 `AI-Workspace/Work/cat-gunner/assets-analysis/data.unity3d`。UI根引用依次为 `level0:595`（入口）、`:1280`（准备）、`:1022`（选枪）、`:152`（任务）、`:1879`（战斗）、`:1268`（结果）；中文取 `resources.assets:2063` 的语言索引3。结果动画源为 `sharedassets0.assets:277`，突袭首领待机为 `:271`；地面来自Sprite457、Material29、Shader225，保持原UV平铺及圆盘裁切。入口/死亡粒子分别取 `level0:39312`、`:55310`。场景原点为 `(-100,0)`，突袭首领为 `(-120,20)`；首领外观按其部件变换和排序绘制，实际命中使用原球形碰撞数据，不能以PNG可见边框替换。首领击杀换层是同步数值操作，死亡视觉不应成为下一层开始的延迟。

独立Boss读取同一原始bundle。UI根引用为 `level0:146`（入口）、`:635`（准备）、`:233`（战斗）、`:1024`（胜利）、`:1260`（失败），中文同样取语言索引3。胜败动画分别为 `sharedassets0.assets:277`、`:276`；龙的待机、行走、死亡分别为 `:267`、`:268`、`:266`。九种外观依次为 BlackDragon、EmeraldDragon、GoldenDragon、GreenDragon、GreyDragon、IceDragon、MechanicalDragon、PurpleDragon、RedDragon，每种保留9个渲染部件及原层级变换。

Boss地面为Sprite810，保留原Transform、`7 × 3.740000009536743`平铺和UV圆盘裁切；阴影来自Sprite351。场景原点 `(-100,0)`，Boss初始世界位置 `(-115,15)`。真实碰撞体是 `level0:64999` 的旋转BoxCollider，对应子Transform `level0:39264`；皮肤翻转不旋转该兄弟碰撞体。不得用贴图包围框代替，导弹瞄准Collider Transform而非碰撞盒中心。死亡动画只改变皮肤内部Transform，不关闭Enemy_Coll；表现不得代替领域层禁伤、结算或退出判定。导出、截图及核对资料放在 `AI-Workspace/Work/v1/qa/boss-20261011`及既有工作区工具目录，不放入运行资源。

Raid升级限制提示为用户定制：`raid_upgrade_notice.py` 单独更新节点 `level0:10149`、其文案和 `raid-upgrade-notice` 字形图集；不重导其他美术。新行内图标引用原攻击力Sprite907与攻速Sprite383，通过 `disabledStrike` 由Cocos叠加红色斜杠，不改原图。`convert_original_raid.py` 也调用该补丁以保留定制；配置 `source.customizations.raidUpgradeNotice` 记录原版文本和资源引用。

角色品质效果在 Default 排序层独立绘制，由每只猫持有模拟状态，不放进左右翻转的 Cat_Bone。同品质换枪保持粒子时钟；换品质、停用角色及销毁清理旧效果。Z 系列的原 Renderer=None 只隐藏 billboard，TrailModule 仍需绘制；shader222忽略材质遗留的 tint，不能把未被原shader使用的灰色材质值再乘进颜色。所有战斗与武器按钮音效共用一个 OriginalSfx 实例，不能在各视图新增独立 AudioSource 绕开原去重规则。

日常换图后可运行以下只读检查，不会覆盖美术：

```powershell
& 'C:\Python311\python.exe' -B 'E:\gunner\AI-Workspace\Work\v1\tools\validate_art.py'
```

静态检查通过后仍需重新构建并看一次实际画面，确认图集更新、尺寸、透明边缘及动画挂点都符合预期。

历史 v10 的七把弓美术与接入见 [bow-redraw-v10](../AI-Workspace/Work/v1/art-design/bow-redraw-v10/DELIVERY.txt) 为准：造型参考冒险岛装备，画风使用原版枪械的圆润卡通线条，内部结构线加粗、外层深棕描边进一步加厚，保持平滑抗锯齿。材质采用底色、硬边亮面和分区阴影，去掉独立反光斑、柔光和渐变，保留结构体积感。雷电按尖端收窄、圆角雷折弓臂重做；按用户要求，C 传说魔翼之弓采用枫叶超级弓造型，B 枫叶超级弓采用迅速之翼造型，A 迅速之翼采用魔翼造型，名称、编号和各自品阶配色保留。D 灰铁/木棕、C 银白、B 浅蓝、A 黄绿，D～A 外轮廓均参考原枪械深棕色。正式画布高 143、可见高 137、四边透明留白 3，可见宽 62～65；弯曲深度接近，高阶装饰保持简洁。高清图 `source-trimmed/` 也单独紧裁至四边 3 像素；`raw-generated/` 保留 imagegen 完整输出。弓材质不追加外轮廓。握点/弦端/UI 投影轮廓/哈希及造型来源 `shapeItemId` 见 manifest.json，非对称弦端的静止弦位按握点高度插值，提示词见 prompts/。原图预览直接平滑缩放高清图，禁止把 143 像素贴图用最近邻放大作为美术预览。v10 将七把弓的弓臂、外轮廓与内部连接线进一步显著加厚，按最终 137 像素主体与原版枪械原生像素对照。局部实心外轮廓约 5～7 像素，含抗锯齿视觉约 6～8 像素；主要内部线约 3～4 像素，局部随转角及结构变化。记录见 qa/final-line-weight-report.json，不能将目标线宽写成每处都精确一致。

历史 v12 的七把弓美术见 [bow-redraw-v12](../AI-Workspace/Work/v1/art-design/bow-redraw-v12/DELIVERY.txt)，取代上述 v10 及 v11 钢铁样稿。钢铁弓 ID59 直接使用用户上传的原图，其余六把使用内置 imagegen 重绘；B 蓝翼 ID5、A 魔翼 ID9 使用用户再次上传并明确确认厚度的两个版本，不能自动替换成后续更粗候选。三份用户定稿原图保存在 `reference/`，与 `raw-generated/` 逐字节核验一致。厚度以整体视觉重量为准，允许结构、握区及品阶之间存在局部差异；实測记录见 v12 的 `qa/`，不要求每条线机械地等于 7～8 像素。

v12 七把主体高 137 像素，画布高 143，四边透明边距均为 3；主体宽 62～65，弯曲深度约 38.40～43.11 像素。沿用既有造型交换、名称、品阶配色和动作，通过新图重新校准握点、弦端、静止弦位与 UI 轮廓。安装入口为工作区 `tools/install_bow_redraw_v12.py`，保留原 UUID、导入过滤设置、战斗缩放、出箭点、拉弦和恢复参数；修改前后快照保存在 v12 包内。原图画廊为 `originals.html`，提示词与最终来源选择位于 `prompts/`。

历史七弓版本 [bow-redraw-v13](../AI-Workspace/Work/v1/art-design/bow-redraw-v13/DELIVERY.txt) 按原版全部65把枪械、13个品阶的双主题色规律重新配色：D中灰＋木棕、C中性灰白＋木棕、B天蓝＋灰褐、A黄绿＋灰白；深棕描边单列为结构色，不算第二主题色。其余品阶两色、描边及原图来源见包内 `qa/original-all-grades-palette-report.txt` 和 `qa/original-all-grades-palette-board.png`。该版本七张均由内置imagegen生成；钢铁与B/A的用户附件作为造型和厚度参考，配色要求优先，PNG不再与原附件逐字节相同。当时打猎采用中灰弓臂＋木棕握区，硬边明暗为主题色的明暗变化；当前打猎弓已由上述统一品阶 v2 的木质反曲造型替代。

v13主体高137、画布高143、四边透明边距3，主体宽62～64像素。造型整体相近，生成重配色不保证每个轮廓像素完全相同；实际形状、线宽局部差异及源图边界复核保存在 `qa/registration-measurements.json`。安装入口为工作区 `tools/install_bow_redraw_v13.py`，保留UUID、导入设置、战斗缩放、弓弦动作与出箭参数，重新校准挂点及UI轮廓；快照、提示词和生成来源均保存在v13包内。原图画廊 `originals.html`，运行截图与录像 `qa/runtime/gallery.html`。
