# components/
> L2 | 父级: ../CLAUDE.md

## 成员清单
lineage-list.tsx: experimental_threadList 槽位组件。两个视图，各有主角（默认“对话”，记住上次的选择）：
  - 对话视图：ConversationItem。项目下面直接列对话，一条一行（provider 图标 + 标题 + 右侧两个固定槽：派出数量 / 状态或时间），不出现分支、worktree；被派出的对话缩进一格排在派它的对话下面，用细拐线连着，点派出数量整组收起（默认展开）；支持本地 Settle 软收起（悬停行尾 Settle / Unsettle 按钮；项目底部 SettledFoot「Settled N」架子，不触发 bb 归档也不删工作区，有新活动自动唤醒；项目计数只数主列表里的对话）；不显示空闲 worktree，不按“已合回”折叠
  - 分支树视图：BranchItem。分支是主行（图标 + 等宽分支名 + 右侧小字标记：主检出 / +领先提交数 / 已合回 / 无 worktree / bb 之外；悬停时标记原地换成“复制安全清理命令”“在此新建”和折叠按钮；清理命令只给 bb 之外（bb 没登记成环境）、没有对话在跑 / 等你 / 出错的空闲或已合回非主 worktree（bb 托管的 worktree 归 bb 管，绕过它删会留下悬空环境），形如 git -C <主检出> worktree remove <路径>，已合回再接 git branch -d，绝不带 --force / -D），它上面的对话是次级行（小一号、灰一档，按最近活动排；被派出的带一个“派自”小箭头，派出过对话的带“高亮它们”的数量槽），从它切出去的分支再缩进一格；项目页脚 ProjectFoot 收着“已合回 N · 空闲 worktree N”；没有 git 的项目照常列出对话、不画树
  - 顶栏待办徽标 .wl-attn：数出“需要你”的对话（黄 / 蓝 / 绿，Settled 里的不算），颜色取其中最需要你的一种；点击或按 ] / [（焦点不在输入框时）、Alt/Option + ] / [（任何地方，按 event.code）按屏幕上实际渲染的行序循环跳转（lib/settle 的 orderByVisual + nextAttentionId）
  共用的行 ThreadCell：全列表单行 28px（触屏 38px），只有搜索结果带第二行；对齐规则见 ../styles.css 的“树形列表”
  动效（逻辑在 motion.tsx + ../lib/motion.ts，样式在 ../styles.css）：Collapse 做带高度动画的展开 / 收起（首次展开才挂载、收起结束卸载、展开稳定后 data-settled 放开 overflow）；MotionRow + usePresenceList 做归档退场（淡出轻移 + 0fr 高度收起）与全新对话入场（0fr → 1fr 高度撑开）；useFlipContainer 做侧边栏级跨分区 FLIP 滑移（同区重排、置顶 / 取消置顶飞跃、嵌套父子位移抵消与打断续接）；状态变化闪亮提示；运行中流光描边；视图切换滑块
  预览卡的出现与移动由列表控制：停约半秒才出；卡片开着时移到别的行不关闭、直接滑过去换内容；离开一行但还在列表里（经过分组标题、空隙）等 0.9 秒才收，离开整个列表或离开卡片 0.3 秒就收；关闭时做 120ms 淡出退场；鼠标移到卡片上时卡片留着（可选字、复制），此时按键和卡片里的点击都不收起它，Esc 照常收起；刚收起 0.7 秒内再停到一行上不用等。只有列表自己被滚动才收起卡片（正在输出的对话会不停滚动聊天区，那不算）
  行的颜色三种（lib/view.ts 的 rowTone / rowColor）：输入框里有没发出去内容的对话（useSidebarThreadDraft）整行变黄并在行尾画 bb 的铅笔；等你回复、出错整行变蓝；完成未读整行变绿
  快速筛选：按 “/” 或点放大镜，顶栏变成输入框，候选分三组：标题或分支（本地即时匹配，lib/search.ts）→ 消息里提到（bb 官方搜索 sdk.threads.search，输入停顿 260ms 后请求）→ 已归档（同上）；同一条对话只出现在最靠前的一组；方向键跨组选择、回车打开、Esc 退出
  共用：对话行 = provider 图标 + 标题 + 状态；悬停时行尾原地换成快捷操作（在此 worktree 新建、bb 的 regenerateTitle / archive、更多菜单），排在文档流里所以不会盖住折叠按钮；项目页脚收纳已合回与空闲 worktree；45s 轮询且仅在页面可见时
peek.tsx: 悬停预览卡 Peek（380px 宽）。内容一次取回（briefing RPC：存盘的速览 + 是否落后 + 兜底摘要）。有速览时：一句话概括 + 竖排的阶段轨道（已完成 / 进行中 / 已放弃，各带一句结论）+ 现在 / 等你 / 下一步；速览落后时阶段保留，后三行换成最新一轮的原话（你问 / 答复）并注明；没有速览时只显示原话。进展行（轮数、派出的对话里不空闲的、PR、改动行数）和底部（分支与起点、派自谁）来自 bb 已有数据。卡片自己从不触发模型调用。
  共享元素过渡：Peek 是取数层，新对话的内容取回之前继续画旧的（不会先缩成只剩标题）；PeekCard 是同一张卡片，位置和高度一起做 CSS 过渡，换人时把上一条画出来的样子留在一层残影里淡出、新内容同时淡入。卡片可以进入：pointer-events 开着、文字可选中复制、用文字光标。渲染到 document.body，因为侧边栏有自己的层叠上下文
motion.tsx: 动效基础层。usePresenceList 同步合并进入/退场状态并挂兜底定时器；MotionRow 负责双 rAF 新行高度撑开与归档高度收起；useFlipContainer 基于滚动无关坐标与 WAAPI 驱动重排与跨区置顶滑移
icons.tsx: 自绘的 16 格线性图标 Glyph（宿主图标表不含完整 lucide，缺名会回退成闪电，所以不依赖它）
ui/icon.tsx: experimental_Icon 的别名导出，只用于渲染 bb 线程操作自带的图标名（豁免 L3：零适配逻辑）

## 边界
本模块负责: 渲染与交互
本模块不负责: 树形结构（lib/tree.ts）、节点画成什么（lib/view.ts）、颜色与尺寸（../styles.css）
上游: @get-bb/plugin-sdk/app、server.ts 的 lineage / briefing RPC、lib/tree.ts、lib/view.ts、lib/briefing.ts
下游: app.tsx

[PROTOCOL]: 变更时更新此文件,然后检查父级 CLAUDE.md
