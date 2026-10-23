# 独立 BOSS 模式

本模块依据原版 `Boss_manager`、`Boss`、`Cat`、`Bullet` 的代码分支和 Unity 序列化资源实现入口、准备页、战斗、胜败及退出流程。`BattleMode.Boss` 是独立玩法，使用 `boss` 存档块、`boss` 广告位和 `boss-system` 美术目录。主线第五波 Boss 与 Raid（突袭）首领仍由各自模块管理。

保留当前项目的原猫角色和武器系统；Boss 使用原版九种龙的部件、头像、待机、行走、死亡及受击表现。按本项目范围移除 PlusPack、扫荡、付费推广和联网排名。

## 开放与操作

- 正式环境历史达到第 6 关显示锁定入口，第 10 关解锁，内部历史值分别为 50、90。主引导进行中入口暂隐；转生保留历史最高关卡。
- 测试环境默认立即开放。打开 BOSS 准备页可查看本次等级、最大生命和本关钻石奖励（首关 300 钻，每提高一关增加 30 钻）；直接使用当前装备的 1–3 把枪，无单独选枪或入场次数。
- 每次挑战免费，可无限次进入。点击开始后加载 2 秒，再开始完整 60 秒战斗。失败或主动退出不扣资源、不推进 Boss 等级。
- 倒计时减到或越过零时先让出一帧，下一次计时检查才判失败；此前已经发生的致死命中仍可判胜。暂停、切后台和广告展示不消耗战斗时间。
- 胜败界面等待玩家操作，不自动重开。退出立即停战并关闭 Boss 地图碰撞，1.5 秒后重开原主线位置，Loading 再保留 0.2 秒。切换保留全局在途弹丸及特效的剩余生命周期。

## 进度、生命与奖励

内部 `stage` 从 0 开始，界面显示 `Lv.(stage + 1)`。Boss 是单个会死亡的目标，击杀后本局结束；不会像 Raid 一样立刻补满下一层生命。九种外观按 `stage % 9` 循环。

第一关生命为 50,000，每级在前一级数值上乘 5 并保留两位有效数字。原资源的 1,000 项生命表由独立夹具核验；表外继续原递推，没有设计上的最终关。实现利用整数系数的循环跳过重复计算，高关预览不会按等级创建巨大缓存。伤害扣除继续保留原 `InfVal` 的有效数字规则。

胜利立即将 **本关钻石奖励和下一 Boss 等级一起保存**（首关 300 钻，之后每关增加首关金额的 10%，即 30 钻），结果页仍显示刚挑战的等级。Boss 不掉金币、不推进主线历史或普通挑战进度，也不计入 Raid 任务。同一死亡事件、旧回合回调及重复广告回调不能重复结算。

广告默认关闭。若同时打开 `CONTENT_CONFIG.ads.enabled` 与 `CONTENT_CONFIG.ads.placements.boss`，胜利后可观看广告追加本关广告奖励，**首关追加 600 钻，总计 900 钻**；之后每关广告额外奖励增加 60 钻，成功后自动退出。基础及广告奖励统一读取 `EconomyConfig.ts` 的 `boss`，首关均为原版2倍，`stageGrowthPercent: 10` 控制每关增加首关金额的10%，不复利。普通奖励与广告追加都使用刚完成的 Boss 关数，不读取主线或挑战关数；旧余额和已领奖记录不追补。取消或失败回到胜利页，可重试；退出、刷新或切后台会使未完成的请求失效。正式包尚无真实广告 SDK，配置打开后使用不可用提供者，不提供测试领奖按钮。

## 战斗属性与碰撞

Boss 模式隐藏并禁止购买三项普通金币升级；金币攻击力和金币攻速不进入战斗计算。转生攻击强化、转生攻速强化、全部持有皮肤的攻击/攻速加成和装备位星级保留。尚未实现的 Fish/Relic/Buff 成长保持中性。皮肤在整数截断及星级前应用，攻速分母为“转生攻速百分比 - 100 + 皮肤额外攻速”，再限制到 100–10000；详见 [皮肤公式](皮肤说明.md#各模式数值与原版精度)。

伤害计算必须跳过整个金币倍率操作，包括金币等级 0 的精度提升，再应用转生、原整数截断及星级。装备先压紧为活动角色，星级按紧凑的 `actorIndex` 读取；这一点与 Raid 的固定准备槽规则不同。例如原武器 22 的基础值为 `800`、三位有效数字，转生攻击 Lv.5 在 Boss 得到 `1010`，普通金币 Lv.0 分支得到 `1016`。

Boss 攻速不受主线关卡扣减。中性其他倍率下，转生攻速 Lv.0–20 保持 100%，Lv.21 为 105%；原冷却按 float32 的“基础间隔 ÷ 百分比 × 100”顺序运算，再限制为 0.05–2 秒。已发射弹丸继续使用发射时的属性。

场景原点为 `(-100, 0)`，Boss 初始地面位置为 `(-115, 15)`。漫游范围半径 60，速度 15，到点阈值 0.5，停留 1–3 秒；选择路径时避开主猫附近半径 4，最多重试 10 次。画面更新写入速度，固定物理步消费该速度。地图地面为原版半径 76.8 的圆盘显示，不额外添加圆形边界墙。

命中使用原旋转盒的偏移、尺寸和高度，不能以龙图片边框或世界轴对齐包围盒替代。索敌、可见性与导弹瞄准使用 Collider Transform；其 Y 约为 `-0.04`，不是约 `6.08` 的碰撞盒中心。导弹冻结发射时目标位置，爆炸和伤害数字使用实际三维命中点。`LASER` 和 `PIERCE` 在 Boss 保留普通穿透规则，不能套用 Raid 的首击停止特例。致死后立即禁伤，死亡动画与剩余弹丸反馈不能再次发奖。

## 存档和调试

仍使用环境隔离的 v3 key：`forest-gunner:economy:v3:test` 和 `forest-gunner:economy:v3:production`。新增可选块 `boss: { stage }` 只保存已提交的下一 Boss 等级；转生不清除此块。缺少或损坏该块只重置 Boss 进度，保留其他有效钱包、装备与关卡。刷新回主线，不恢复半局、结果页或广告 token。

测试包游戏运行页控制台提供以下接口；`stage` 为零基索引。配置会写测试存档，应先保存需保留的测试状态。

```js
__forestGunner.content.state('boss')
__forestGunner.boss.state()
__forestGunner.boss.configure({ stage: 0 }) // 仅主线、Boss 空闲时可配置
__forestGunner.boss.open()
__forestGunner.boss.close() // 关闭准备页；离开战斗使用 exit()
__forestGunner.boss.start()
__forestGunner.progression.stepFrames(120) // 默认每帧 1/60 秒，推进正常入口更新
__forestGunner.boss.exit()
```

`boss.state()` 返回阶段、显示关卡、生命文本、血量比例、剩余时间、结果动画时间、钱包和广告资格。仅开启广告并且已胜利时可调用 `boss.beginAd()` 获取 token，再用 `boss.completeAd(token, 'success' | 'cancel' | 'failure')` 验证领域结算；该方式不等于验证广告面板触摸或真实 SDK。完整 Boss 调试命令只在测试环境提供，正式环境的领域配置方法也拒绝测试修改。

## 代码与原版依据

| 项目文件 | 责任与原版依据 |
| --- | --- |
| `assets/scripts/session/BossSystem.ts`、`BattleSession.ts` | `Boss_manager` 的进入、退出、计时、胜败和广告事务；v3 进度与钱包原子保存 |
| `assets/scripts/session/ContentConfig.ts`、`ContentUnlockManager.ts` | 原 `Contents_Unlock_manager.Reload` 的显示/开放条件：下一待解锁项目提前出现 |
| `assets/scripts/core/BossBalance.ts`、`BossCombat.ts`、`BossCollision.ts`、`BossMap.ts` | 原生命表、`Boss.WanderRoutine/MoveToPoint`、路径避猫、BoxCollider 几何与独立地图 |
| `assets/scripts/core/CombatWorld.ts` | `Cat.FindBossTarget`、原射击与 `Bullet` 命中分支、`Enemy.Damaged/Die` 的禁伤和死亡顺序 |
| `assets/scripts/view/BossHud.ts`、`BossView.ts`、`BattlefieldView.ts` | 原 UI 节点、按钮、字体、九种龙部件、动画与战场接入 |
| `assets/resources/art/boss-system/config.json`、`visuals.json` | 原 Unity 对象引用、资源路径、布局和动画数据；详见 [美术维护](../ART-GUIDE.md) |
| `tests/fixtures/boss-health-original.json` | 从 `data.unity3d` 的 `level0:124699 Boss_manager.Health_Balance` 独立提取的 1,000 项生命数据 |

原代码参考位于相邻目录 `CatGunner-Original/Decompiled/native/Assembly-CSharp`，重点为 `Boss_manager__t7456.c`、`Boss__t7451.c`、`_WanderRoutine_d__19__t7450.c`、`_MoveToPoint_d__20__t7449.c`、`Cat__t7445.c`、`Bullet__t7528.c`、`Gamemanager__t7191.c`、`Enemy__t7511.c`。它们是 ARM64 IL2CPP 反编译参考，需结合资源与调用顺序判断；运行和回归测试不读取这些外部文件。

## 验证状态

以下记录属于2026-10-11版本，保留当时150/450钻的结算证据；当前首关基础300钻、广告后总计900钻，之后每关增加首关金额的10%，以本文“进度、生命与奖励”为准。

2026-10-11 最终 `npm run check`：**770 项通过、0 失败、0 跳过**，完整工程类型检查通过，见 [最终日志](../../AI-Workspace/Work/v1/qa/boss-20261011/check-final.log)。最终 [Web `test` 构建](../../AI-Workspace/Work/v1/logs/web-20261011-223922-796.stdout.log)与 [微信 `production` 构建](../../AI-Workspace/Work/v1/logs/wechat-20261011-224007-140.stdout.log)均成功，构建后运行源码未再修改。微信本轮未真机运行。

Web 实际检查了三种竖屏的准备、战斗、失败、胜利及九种龙外观；武器 64 实际击杀获得 150 钻，金币和主线历史不变，退出返回原 stage 0 / wave 2。刷新恢复 Main、Boss stage 1 和钻石 2,000,150；转生回主线时保留 Boss stage 1。后台推进 600 帧不减少剩余时间，恢复后继续；武器/Boss 弹窗互斥、普通挑战、Raid 连续击破并进入第 5 层和转生回归通过，浏览器错误为 0。操作记录、快照和截图见 [最终验证记录](../../AI-Workspace/Work/v1/qa/boss-20261011/验证记录.md)。

专项测试覆盖 6/10 关门槛、会话/属性/广告回归、全部原生命表、旋转盒与三维导弹、七种武器、死亡与超时、漫游、多帧率三猫追击、原 UI 资源和真实 Bootstrap 生命周期。倒计时保留原始末帧值：过零负数显示 `0s`，恰好零显示 `1s`，失败页延续最后计数。多指与顶部44/底部24安全区由真实 `BossHud` 的 Cocos 替身测试验证；内置浏览器不支持本轮多指 CDP 输入，不记为手机实测。维护入口见 [测试说明](../tests/README.md#独立-boss-回归)。

首轮 **750 项通过、0 失败、0 跳过**及首轮 Web `test` 构建保留为历史记录：[首轮检查](../../AI-Workspace/Work/v1/qa/boss-20261011/check-initial.log)、[首轮构建](../../AI-Workspace/Work/v1/logs/web-20261011-222735-334.stdout.log)，不替代上述最终结果。

截图、对照资料和备份统一存放于 [Boss 验收目录](../../AI-Workspace/Work/v1/qa/boss-20261011)；运行代码、资源与回归夹具均在 `Project` 内。当前原版模拟器停留在未解锁的 Stage 3-5，只有 [锁定状态截图](../../AI-Workspace/Work/v1/qa/boss-20261011/original-locked-stage3-5.jpg)，缺少同状态的原版准备、战斗及胜败运行图。因此目前的代码、数据和资源验证**不能宣称逐像素一致**，也不能替代微信开发者工具或手机真机验收。
