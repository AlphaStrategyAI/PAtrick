# v2.6 原型验证

本目录保存独立的本地模拟扩展与检查。账户、消息、文件修改和回执均为样例；没有真实飞书发送、Obsidian写入或后端实现。

- `integrations-extension.js`：六类设置中的Obsidian接入、飞书交互，以及知识/标准编辑状态。
- `sync-extension.py`：将扩展重新嵌入当前`交互原型.html`；公共布局、样式和图标仍在HTML与`icons/`中维护。
- `test-integrations.cjs`：连接、配对、往返测试、启停、配置失效、编辑收录/评测/采用/写回、双语和移动端。
- `test-regression.cjs`：原有决定、任务、采集和六类设置的回归。
- `test-statistics.cjs`：统计口径、周期、去重、导航和移动端回归。

运行前准备Playwright及Chromium，通过环境变量指定工具路径；不依赖任何现有PAtrick应用代码。

```bash
export PATRICK_PLAYWRIGHT=/absolute/path/to/playwright
export PATRICK_BROWSER=/absolute/path/to/chromium
export PATRICK_TEST_OUTPUT=/tmp/patrick-integrations
node test-integrations.cjs
export PATRICK_TEST_OUTPUT=/tmp/patrick-regression
node test-regression.cjs
export PATRICK_TEST_OUTPUT=/tmp/patrick-statistics
node test-statistics.cjs
```

最终结果见上级`原型验证.json`及本目录`results/`。Figma复核见上级`Figma-界面核对.json`；原型跳转读回不等于实际原型播放录屏，也不等于真实服务联通。
