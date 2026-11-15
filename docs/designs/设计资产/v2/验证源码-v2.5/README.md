# v2.5 验证源码

两组本地 Playwright 检查：统计 28 项 / 12 组合；任务与采集回归 27 项 / 52 组合。统计数据和业务动作均为本地模拟。

需要 Node.js、Playwright 和 Chromium。默认从父目录读取原型，将报告与截图写入 `results/`。可用 `PATRICK_PLAYWRIGHT` 指定已有 Playwright 模块路径、`PATRICK_BROWSER` 指定 Chromium 路径；`PATRICK_ASSET_DIR` 和 `PATRICK_TEST_OUTPUT` 可覆盖输入、输出目录。

```sh
node test-statistics.cjs
node test-regression.cjs
```

统计检查覆盖七项导航顺序、六指标、周期与存量区别、主人答复去重、任务完成独立计数、语言与布局、任务跳转和离线快照。回归检查覆盖原有任务续办和来源生命周期。报告中的 SHA-256 必须与本次原型文件一致。

Figma 的图层、导航和字体检查另见 `../Figma-v2.5复核.json`；截图不作为动效播放证据。
