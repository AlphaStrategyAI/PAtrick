# v2.4 原型验证源码

`test-prototype.cjs`为本轮实际使用的检查脚本副本，包含27项交互检查和52种页面/语言/尺寸组合。当前文件hash与结果见上级目录的`原型验证.json`。

脚本保留本次环境路径：原型位于`/workspace/productIdeas/PAtrick/设计资产/v2`，Playwright位于`/workspace/PAtrick/node_modules/playwright`，Chromium位于`/usr/bin/chromium`。换机器运行前需调整这三处路径；输出写入脚本所在目录。测试仅使用本地HTTP服务和样例状态，不访问真实来源。
