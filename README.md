# 舞台多机位点播内核

一个真实可运行的舞台多机位（multi-cam）点播播放器：多个自制机位按**共同的表演时间线**组织，
切换视角时呈现的是**同一表演时刻**，音频始终走指定主轨。它不是把几个 `<video>` 同时后台
播放再切 CSS 可见性，而是一条真实的多路播放链：

```
HTTP 取字节 → IVF 解封装/建帧索引 → 定位关键帧依赖链 → WebCodecs VideoDecoder → Canvas 呈现
                                                              ↑
                                          主音频 <audio> currentTime 作为唯一表演时钟
```

## 怎样启动界面

需要 Node 18+（开发环境为 Node 22）。素材已随仓库生成在 `public/media/`，直接：

```bash
npm run serve
# 打开 http://localhost:5173/
```

页面即图形播放器：左侧是舞台 Canvas、播放/暂停/拖动条和机位按钮，右侧实时显示
**请求视角 / 正在呈现视角 / 内核状态 / 时钟时刻 / 帧真实时刻 / 同步偏差 / 黑屏累计 /
解码器占用**，以及每次切换的实测延迟与依赖链长度。所有按钮都调用内核真实实现，
结果区数据来自真实解码与测量，没有任何固定占位数据。

重新生成测试素材（用 ffmpeg.wasm，无需系统 ffmpeg）：

```bash
npm run media
```

## 内核如何对应需求

- **共同时间关系、同一表演时刻**：`public/src/kernel/timeline.js` 让每个片段声明自己在共享
  时间线上的 `start/end`，而媒体自身从 pts 0 开始。映射公式是
  `表演时刻 = segment.start + 帧序号 / fps`。因此**分片/帧序号绝不跨机位比较**——两台机器
  序号相同也可能对应完全不同的时刻（单测 `test/timeline.test.js` 专门锁定这一点）。
- **切换先算目标源位置、再取解码依赖**：`switcher-kernel.js#requestView` 先用时间线定位目标
  片段与帧，再由 `route.js#decodeFrameAt` 回退到最近关键帧、把整段依赖链喂给 `VideoDecoder`，
  丢弃目标帧之前的输出，保证不会把旧缓存首帧（旧关键帧）直接显示出来。
- **生效后核对真实帧时间**：提交前用 `VideoFrame.timestamp` 反算真实表演时刻并与目标核对，
  偏差超过一帧半即判定失败，而不是信任 chunk 顺序。
- **新机位未就绪时保留当前画面并显示等待**：状态机进入 `waiting`，画面保持当前帧并弹出等待
  浮层；只有目标帧核对通过后才提交（`presenting`）。
- **某时段无资料即明确不可选**：时间线返回空时进入 `gap`，对应机位按钮禁用并给出原因
  （如「27.0s 无素材，下一段 30.0s 开始」）。播放器会**关闭旧帧并清空 Canvas 画石板**，
  不会重复上一帧掩盖缺口；素材恢复后自动重新取帧呈现。
- **有预算的切换内核**：`route-pool.js` 用 LRU 把同时存在的 `VideoDecoder` 限制在 3 个，
  第 4 个机位接入会淘汰最久未用者，被淘汰机位再次使用必须重建关键帧链。页面显示实时占用数。
- **音频保持指定主轨**：`master.wav` 是唯一主时钟，视频帧按 `audio.currentTime` 拉取，
  切换机位不影响音频，异帧率机位因此对齐到同一表演时刻。

## 测试素材的差异化设计

`tools/generate-media.mjs` 产出 4 个机位，刻意制造不同起点、帧率与短缺段（VP8/IVF，GOP=2s）：

| 机位 | 帧率 | 覆盖区间（表演秒） | 特点 |
|---|---|---|---|
| cam-wide 全景 | 30 | 0–16 / 16–32 / 32–40 | 全程，三段拼接 |
| cam-left 左侧 | 25 | 4–20 / 20–40 | 起点晚 4s |
| cam-drum 鼓点 | 24 | 8–24 / 24–36 | 起点晚、结束早 |
| cam-closeup 特写 | 15 | 10–24 / 30–36 | 24–30s 有缺口、36s 后无素材 |

每帧烧录机位号、片段号与帧号（仅作画面辨识，内核不依赖它对时），并用不同色相区分机位，
便于 E2E 用像素颜色验证「确实切到了目标镜头」。

## 测量结果（headless Chromium 实测）

`npm run test:e2e` 会输出 `SWITCH METRICS`。一次代表性结果：

- 30/25/24/15fps 四机位互切，切换延迟约 **14–26ms**；
- 同步偏差分别为 0 / -20 / -33.3 / -33.3ms，均不超过各自一帧周期（负值表示所选帧不晚于
  请求时刻、领先一个帧周期以内，属正常）；
- 接入第 4 机位时发生 1 次解码器淘汰；
- 正常机位互切保持旧帧，黑屏累计为 0；穿越 24–30s 缺口时黑屏约 6s（缺口石板），恢复后自动续播。

## 测试

```bash
npm run test:unit   # 时间线映射、IVF 索引（Node，无需浏览器）
npm run test:e2e    # Playwright：真实 WebCodecs 解码、切换、缺口、预算、像素、持续播放
npm test            # 两者都跑
```

E2E 断言页面中**不存在任何 `<video>` 元素**且使用了 `VideoDecoder`，从机制上排除了
「多 video 后台播放 + 切可见性」的假实现。

### 无 root 环境下的浏览器依赖

本容器无系统 ffmpeg、也无权 apt 安装。媒体生成用 ffmpeg.wasm；Playwright 的 Chromium 缺少
系统库时，运行下面命令把 bookworm 的 arm64 依赖解包到用户目录（不需要 root），
`playwright.config.js` 会自动通过 `LD_LIBRARY_PATH` 加载：

```bash
npm run browser:deps
npx playwright install chromium
```

## 目录结构

```
public/
  index.html               图形播放器界面
  src/
    app.js                 界面与内核接线（按钮、状态、结果区）
    kernel/timeline.js     共享时间线：表演时刻 ↔ 片段/帧映射、缺口判定
    kernel/route.js        单机位：IVF 解码、关键帧依赖链、请求串行化
    kernel/route-pool.js   解码器预算 LRU
    kernel/switcher-kernel.js  切换状态机与指标测量
    player/stage-player.js 音频时钟、rAF 取帧、Canvas 绘制、缺口石板
    demux/ivf-demuxer.js   IVF 解封装与关键帧索引
  media/                   生成的机位片段、主音频、manifest.json
tools/                     素材生成、静态服务器、浏览器依赖引导
test/                      Node 单测与 Playwright E2E
```
