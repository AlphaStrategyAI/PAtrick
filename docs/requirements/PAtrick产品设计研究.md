> 设计采纳说明（2026-11-14）：研究事实与来源保留；当前产品采用对话式判断工作台、冰蓝深墨、英文默认与完整中英切换。旧版只读网页分工已由[产品设计v2](PAtrick产品设计.md)的认证Web咨询/决定合同替代。

# PAtrick 产品设计研究

研究日期：2026-11-14（Asia/Shanghai）。用于制定[产品设计](PAtrick产品设计.md)的原则，随后才组合功能、流程和界面。依据为公开官方资料，不包含付费产品实机对照测试；产品描述不等于可靠性证明。

## 1. 研究范围与问题

覆盖11款产品：ChatGPT、Claude、Gemini、Manus、Lindy、Reclaim、Motion、Limitless、Notion AI、Granola、Raycast；再以Google PAIR、Microsoft HAX与Apple无障碍指引校验设计。

每款产品回答四个问题：怎样交代任务？何时打断本人？怎样查证或纠正？怎样让重复工作少费心？不按功能数量排名，也不把营销中的“自主”“了解你”当作已验证能力。

## 2. 产品模式与取舍

| 产品 / 官方资料 | 实读的产品模式 | PAtrick采用什么 | 不照搬什么 |
|---|---|---|---|
| **ChatGPT**：[浏览器工作](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)、[Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)、[Memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) | 先说目标，再选择工具；项目收拢资料和指令；可查看、纠正个人上下文；访问与关键动作分别控制 | 围绕工作对象聚合成果；判断旁可展开采用的个人标准和来源 | 记忆摘要不能代替已核实事实和经评测的个人标准；云端续作不代表本地设备任务也可离线运行 |
| **Claude**：[统一对话](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)、[Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)、[Memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 对话承接委托和纠偏，成果独立呈现；选区可局部修改；上下文有作用范围和退出方式 | 任务上下文与产物相邻，纠正到具体判断；结果有固定去处 | 审批模式不是能力成熟度；自动更新指令不等于判断质量提升 |
| **Gemini**：[Skills](https://support.google.com/gemini/answer/17094296?hl=en)、[Schedules](https://support.google.com/gemini/answer/16316416?hl=en)、[Memory](https://support.google.com/gemini/answer/16598469?hl=en) | 指令和资料可沉淀为可预览、组合的方法；计划有摘要、暂停和结果入口；删除与停止引用不同 | 保存重复方法时展示输入、结果、作用范围；定期工作保留可读回执和资料时间 | 不做专家头像市场；技能不授予执行权；送达时不把预生成内容冒充最新资料 |
| **Manus**：[Scheduled Tasks](https://www.manus.im/blog/manus-schedules)、[Task Lifecycle](https://open.manus.im/docs/v2/task-lifecycle) | 长期任务可延续项目上下文；每次运行有独立结果；运行、等待、停止、错误分开 | 一项持续委托关联多次工作与成果；暂停后仍保留已有产物 | 模型停止不等于任务完成；持续上下文不应成为无限聊天记录 |
| **Lindy**：[Watch and Learn](https://www.lindy.ai/docs/teammate/watch-and-learn)、[Routines](https://www.lindy.ai/docs/teammate/routines)、[Usage](https://www.lindy.ai/docs/account-billing/usage) | 示范包含决策理由；纠正后保存方法，再单独设置触发与交付位置；先试样例再激活；异常用量可暂停 | 自然纠正提炼标准候选；“怎么判断”与“何时自动做”分开；资源不足有明确选项 | 一次示范不能直接生成永久标准或长期授权 |
| **Reclaim**：[Focus Time Agent](https://help.reclaim.ai/en/articles/17125004-focus-time-agent-overview-protect-deep-work) | 改规则先预览影响；手动移动只锁定该次，删除只跳过该次 | “本次例外”“标准修订”“委托变更”三个作用范围写清楚；变更先比较 | 用户改过的内容不能被Agent悄悄改回；不能从单次例外推断永久偏好 |
| **Motion**：[Auto-scheduling](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/how-auto-scheduling-works-behind-the-scenes) | 按明确约束安排任务；无法满足时显示冲突；期限风险可见 | 阻塞卡解释哪个约束冲突、影响什么、推荐调整哪一项 | 不无限显示“处理中”，也不为了看起来成功而放宽预算和范围 |
| **Limitless**：[检索与纠正](https://help.limitless.ai/en/articles/10546658-interacting-with-the-pendant-search-ask-ai-summaries)、[删除录音](https://help.limitless.ai/en/articles/11391400-how-do-i-delete-a-pendant-recording) | 可检索原始记录、纠正说话人；局部与全局纠正分开；从有用问答建立持续关注 | 结论能返回原证据；纠正注明范围；撤回显示实际清理状态 | 帮助页不证明当前服务可用；停止使用与清除全部副本不能混为一谈 |
| **Notion AI**：[Enterprise Search](https://www.notion.com/help/enterprise-search) | 检索可指定来源范围，回答附来源链接 | 答案先给结论和资料范围，证据按需展开 | 有引用不等于内容已核实；不把搜索置信度作为执行许可 |
| **Granola**：[使用指南](https://www.granola.ai/blog/get-the-best-from-granola) | 人只记关键判断，AI补机械细节；人工记录与AI补充有区分 | 系统自动补案例情境，本人只补“哪里错、什么是例外” | 不让用户每天为所有任务打分；AI补充不能伪装成本人原话 |
| **Raycast**：[Quick AI](https://manual.raycast.com/ai/quick-ai) | 轻入口先答，需要深入再展开完整上下文 | Cursor/Codex内先给简短答复和下一步，复杂工作再跳详情 | 不强迫用户为了问一个问题进入另一套聊天工作台 |

资料时效备注：本次访问的一些官方页面包含ChatGPT agent转向Work、Claude入口合并、Gemini个人Gems向Skills迁移的提示。这里只提炼页面能支持的交互机制，不依赖旧名称、当前套餐、销售状态或推测的未来功能。Limitless仅作为记忆交互案例，不推荐为本项目接入项。

## 3. 人与AI交互的通用校验

| 指引 | 可支持的结论 | PAtrick的具体落点 |
|---|---|---|
| [Microsoft HAX：Human-AI Guidelines](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/)、[高效纠正](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-correction/)、[撤销自动动作](https://www.microsoft.com/en-us/haxtoolkit/pattern/g9-c-undo-automated-actions/) | 首次使用、运行、出错和长期使用都要支持用户控制；纠正的成本可能抵消自动化收益 | 显示完成条件；局部纠正；区分停止后续与回退已发生动作，不承诺万能撤销 |
| [Google PAIR：Mental Models](https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/)、[Feedback + Control](https://pair.withgoogle.com/chapter/feedback-controls/) | 解释能力与边界，渐进介绍；反馈必须说明影响和生效时间 | 从一类工作起步；显示“已收到/候选/当前生效”；不把用户沉默当认可 |
| [Apple：Reduced Motion](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria) | 尊重减少动态效果偏好，避免不必要移动 | 动效只解释状态/位置变化；提供淡入或即时替代，不做循环演示“思考中” |

## 4. 形成的原则基线

这些原则是研究与PAtrick需求的综合设计结论，不是竞品已经证明的能力。

| 原则 | 具体设计决定 | 反例 |
|---|---|---|
| **D1 先告诉我需要做什么** | 今日按待决定、推进中、成果排序；无事时明确告诉用户无需介入 | 用聊天历史、调用次数或健康图表占满首页 |
| **D2 一次介入解决一个取舍** | 问题卡含推荐、代价、影响对象；回答后自动续办 | 每一步都确认，或只问“是否继续” |
| **D3 每项工作有结果和去处** | 展示目标、当前阶段、下一步与成果链接；断线可找回 | 模型停止就标完成；产物埋在消息中 |
| **D4 依据近在手边** | 建议旁展开标准、证据、日期、相反意见与未知项 | 展示长思维链或不可验证的“信心98%” |
| **D5 纠正先留案例，验证后改标准** | 本次例外只留案例；重复分歧或有价值的方法才形成候选；成果旁说明采用了哪次纠正 | 每次纠正都变规则；让用户手工填写长评测表 |
| **D6 在既有委托内逐步少操心** | 能力证据减少重复确认；权限扩大单独比较和确认；局部异常局部暂停 | 全局“完全自主”开关；用不断扩大权限冒充能力进步 |
| **D7 正常安静，异常有交代** | 正常自动推进；阻塞说原因、已有成果、下一步和影响范围 | 逐步推送执行日志；过期状态继续显示绿色实时 |
| **D8 视觉与动效帮助理解** | 克制颜色、稳定位置、短转换、键盘与减少动态效果支持 | 庆祝动画、脉冲光效、假进度条抢夺注意力 |

## 5. 尚需验证的假设

- “今日待决定优先”能否让本人30秒内找到最重要的取舍？用原型任务测试，不把它写成已测结论。
- “本次意见/标准修订/委托变更”是否能被快速区分？让用户处理一次例外和一次永久改进，观察误选。
- 飞书回答、Obsidian编辑、网页查看的分工能否接受？首版优先复用可信入口，记录往返次数；有明确摩擦后再做已认证网页内联操作。
- 判断与委托的改进能否抵消维护成本？按真实结果、重大改写和本人分钟数衡量；样本不足不宣称已经提高判断能力。
- 用户能否说清最近哪次纠正被后续工作采用、是否减少返工？成长反馈应关联具体成果，不只增加一个标准数量指标。
