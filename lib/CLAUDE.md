# lib/
> L2 | 父级: ../CLAUDE.md

## 成员清单
contract.ts: 三端数据契约，zod schema，hostContract.scanLineage / writeBriefing（输入带 route: modelRouteSchema = gateway{baseUrl, model} | claude{model}；failed 输出可带 cooldown{scope: model | gateway, ms}）与 serverContract.lineage / briefing（briefing 的输出 briefingViewSchema = 存盘的速览 + 是否落后 + 兜底摘要，界面一次取回）；ParentSource 四级可信度 recorded > reflog > reflog-commit > unknown
lineage.ts: 纯函数，解析 worktree porcelain / reflog 文件，resolveLineage 按记录定父分支并破环，selectRelevant 取 worktree 分支 + 祖先闭包
git-scan.ts: host 端 I/O，execFile 只读 git（worktree list、for-each-ref、读 reflog 文件、is-ancestor、rev-list --count），异常收敛为 failed，从不抛出
tree.ts: 纯函数，buildLineageTree 按 worktree 路径挂对话、跨 worktree 父子记 dispatchedBy、剪枝幽灵分支；collectFolded 摘出已合回 / 空闲外部 worktree；isCollapsedByDefault、branchLabel
conversations.ts: 纯函数展示模型（对话视图）。buildConversations 把一个项目里的对话按“谁派的”嵌套（上级不在本项目里的当顶层，成环的当顶层），顶层按一家人里最近的活动排序，下级按派出先后（新的在上，顺序稳定）；activityOf 给出一条对话最近一次真正的活动时间（空闲时用 latestAttentionAt，不用 updatedAt：点开看一眼也会改它）；countDescendants。完全不看分支
view.ts: 纯函数展示模型（分支树视图），buildProjectView 把血缘树变成 card / fork 两种节点：无对话且只有一个后继的分支并入后继路径（压缩），无对话但分出多条线的画成分叉点，已合回与空闲 worktree 收进页脚；pathLabels、toneOf / rollupTone（状态色调）、relativeTime；rowTone（一行对话的颜色，先后：出错 > 等你回复 > 有草稿 > 运行中 > 已完成未读）、rowColor（整行底色三种：draft 黄、waiting 蓝（含等你回复与出错）、done 绿；运行中与空闲不上色）；worktreeCleanupCommand（生成不带 --force / -D 的安全清理命令）
settle.ts: 纯函数本地 Settle 软收起与待办快跳逻辑。isThreadSettled / isConversationSettled / splitSettledConversations 管理对话视图的 Settled 架子与智能唤醒（不触碰 bb 归档与磁盘环境）；needsUserAttention 判定“需要你”的对话，orderByVisual 按屏幕上实际渲染的行序重排（收起分组里的接在后面），nextAttentionId 循环跳转
search.ts: 纯函数，matchThreads（空格分词、全部命中、按最近活动排序）、plainSnippet（把 markdown 压成一两句纯文字）、meaningfulItems（大纲里算数的消息：去掉空白与只有一个斜杠命令的用户消息，摘要、提要、是否落后都只看这些）、buildRecap（用 bb 的对话大纲拼出“你问 / 答复”的兜底摘要，过滤 bb 自动转达的消息，不花 token；速览缺失或落后时用它）
briefing.ts: 纯函数，“全程速览”（交给模型写的那一份）的输入与输出。toTurns / countAsks 把 bb 的对话大纲切成“一轮要求 + 结论”（过滤 bb 自动转达的消息），outlineKey / freshness 判断存盘的速览是否落后于当前大纲（服务端决定要不要重写、卡片决定“现在 / 等你”还能不能信，同一个函数），buildDigest 拼出喂给模型的全程提要（超过 14000 字时截短较早几轮的答复，要求与最近 6 轮保持完整），BRIEFING_SYSTEM_PROMPT，parseBriefing 校验并收紧模型输出（结构不对返回 null）；storedBriefingSchema 多出 version / outlineKey / askCount / generatedAt
model-run.ts: host 端 I/O，runModel 按 route 分派：gateway 走 runGateway（fetch 一次 OpenAI 兼容 /v1/chat/completions，reasoning_effort low，45s 超时，取 choices[0].message.content 并去掉 <think> 块；连不上 / 超时 / 非 2xx / 无正文都返回 failed；429 附模型级冷却 = Retry-After（秒数或 HTTP 日期，parseRetryAfter；缺省 15 分钟、最多 2 小时，rateLimitCooldownMs），连不上附网关级 60 秒冷却），claude 用 spawn 一次性调用本机 `claude -p`（不加载设置与钩子、不保存会话、不带工具、空临时目录、120s 超时）；返回 ok / failed，从不抛出；记住冷却、按模型链回退由 briefings.ts 决定
motion.ts: 纯函数动效状态机与 FLIP 计算。reconcilePresence / finishEntering / finishExiting 管理列表条目的 entering / present / exiting 阶段并区分“归档消失”与“跨区迁移”；computeFlipDeltas 做祖先位移抵消（避免分区与子行双倍位移）；flipDuration 按位移距离缩放 190–280ms；parseTranslateOffset 解析打断中的 transform 偏移
utils.ts: cn 类名合并、路径显示

## 边界
本模块负责: 数据形状、分支血缘推断、树形结构、展示模型
本模块不负责: React 渲染、bb SDK 调用（server.ts / briefings.ts / components）、速览何时生成（briefings.ts）
上游: git CLI（经 git-scan.ts）、OpenAI 兼容模型网关与本机 claude CLI（经 model-run.ts）、bb 环境记录（经 server.ts 传入 recordedBases）
下游: host.ts、server.ts、briefings.ts、components/lineage-list.tsx、components/peek.tsx

[PROTOCOL]: 变更时更新此文件,然后检查父级 CLAUDE.md
