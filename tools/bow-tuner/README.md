# 弓箭动作调试页

预览复用 `build/web-mobile` 中的游戏角色、皮肤、弓弦与动作代码。

在 Project 目录执行：

```powershell
# 首次使用或修改游戏 TypeScript 后，先构建 Web 包
.\tools\build.ps1 -Platform web -Environment test
node tools/bow-tuner/server.cjs 7474
```

打开 http://127.0.0.1:7474/ 。修改本目录的 HTML/CSS/JS 后只需刷新。

- 拖动橙色圆心、青色拉弦起点、灰色半径手柄；重合时拖圆心外围的十字线。
- 也可用右侧滑块或数值框精确调整。位置采用角色未镜像的身体坐标，X 向右、Y 向上；切换朝向会镜像显示。
- 持弓半径系数乘以当前弓的原始握距；拉弦距离系数乘以当前弓的原始拉距。画面下方显示换算后的距离。
- 后拉方向 0° 表示沿瞄准轴向后；手腕角度只调整拉弦手自身朝向。
- 用进度条和开始、半拉、拉满、松弦、回位检查动作；可切换四种弓、25 个皮肤、朝向、瞄准角度和行走状态。
- 参数自动保存到此端口的浏览器存储。复制参数后发送完整 JSON；也可下载或导入 JSON。

参数版本为 `forest-gunner.bow-pose.v1`，`bowPose` 对应 `CatView.setBowPoseTuning()`；`preview` 仅记录查看方式。调参只作用于预览中的角色实例，游戏默认值不会被网页写回。iframe 的游戏存档使用内存存储，普通游戏页面的存档不受影响。
