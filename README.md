# Worktree 血缘（bb 插件）

替换 bb 侧边栏的线程列表：按“代码从哪来”排列。

顶上有两个视图，各有主角：

**对话（默认）**
- 只讲对话：项目下面直接列对话，一条一行（provider 图标、标题、右侧的派出数量和状态或时间），按最近的真实活动排序（只是点开看一眼不算）。
- 不出现分支和 worktree。想知道一条对话在哪个分支，看悬停卡片，或切到分支树。
- 被派出的对话缩进一格排在派它的对话下面，用一条细拐线连着；点派出数量可以整组收起。

**分支树**
- 分支是主行：分支图标、等宽的分支名，右侧小字标明“主检出、领先几个提交、已合回、无 worktree”。从它切出去的分支缩进一格。
- 对话是挂在分支下面的次级行，小一号、灰一档。
- 没有对话的 worktree 和已合回的分支收在项目末尾的“已合回 N · 空闲 worktree N”里。没有 git 的项目照常列出对话。

对齐只有一条规则：下一级的图标对齐上一级文字的左缘。右侧的时间、数量、分支标记都贴同一条右边线。

**两个视图共用**
- 运行中的对话：行的外缘有一圈很细的流光描边（做法参考 Hermes desktop）。
- 悬停时行尾原地换成快捷操作：重新生成标题、归档、更多；右键是 bb 的完整线程菜单。
- 颜色即含义，整行的底色有三种：黄 = 输入框里有没发出去的草稿（行尾带铅笔）；蓝 = 它停下来等你，包括等你回复和出错（行尾的标记区分这两种）；绿 = 做完了，你还没看。同时有几种时按“出错 > 等你回复 > 草稿 > 完成未读”取一种；运行中是流光描边，不占底色。
- 悬停预览卡：鼠标在一条对话上停约半秒，旁边浮出一张“全程速览”——一句话说明这条对话在做什么、按时间归并出的几个阶段（已完成 / 进行中 / 已放弃，各带一句结论）、现在停在哪、等你做什么决定、下一步，以及进展（轮数、派出的对话、PR、改动行数）。在对话之间移动时是同一张卡片连续变形：位置和高度一起过渡，旧内容淡出的同时新内容淡入；经过分组标题、空隙时卡片留在原地等你落到下一条对话上；别处的滚动（比如正在输出的聊天区）不会把它关掉。鼠标可以移到卡片上：卡片不消失，里面的文字能选中、能复制；Esc 或移开鼠标收起。
  - 速览由小模型在后台写，按顺序试本机 Magpie 网关（默认 `http://127.0.0.1:3425`）上的模型链，默认 `workbuddy/deepseek-v4.1-flash` → `opencode-zen/deepseek-v4.1-flash-free`（免费但额度少）；某个模型超时、出错或写得不合格就试下一个，都不行再兜底到本机的 Claude（默认 haiku）。模型链在设置里用逗号分隔填写，付费直连的模型不在默认链里：每轮对话结束后，把整条对话每一轮的要求和答复开头（bb 的对话大纲，几千字）交给它，结果存盘。悬停只读存盘的结果，从不触发模型调用。
  - 网关调用是一次纯 HTTP 请求（45s 超时，不启动进程），实测 2–6 秒；注意对话提要会发给网关背后的模型服务商。返回 429 的模型按 `Retry-After` 冷却（缺省 15 分钟、最多 25 分钟），网关连不上整体冷却 1 分钟，冷却期内直接跳过、不刷日志。网关地址留空即只用 Claude。
  - 回退时是一次性的 `claude -p`：不加载用户的设置与钩子、不保存会话、不带任何工具。走 Claude 订阅额度，实测每条 $0.0002–0.002。
  - 速览还没写出来、或写完之后又有了新要求时，卡片用不花额度的摘要补上（你问 / 答复，取自对话大纲）。
  - 开关与模型：`bb plugin config worktree-lineage set briefingEnabled false`、`bb plugin config worktree-lineage set briefingModel <名字>`。保护：一次只写一条、每天最多 300 次、连续失败 3 次就停。
- Settle（软收起）：对话视图悬停行尾可点 Settle，把已做完但暂时不想触发 bb 归档（不删托管 worktree 与环境）的对话收进项目底部的「Settled N」架子；只要该对话重新运行、出现草稿、等你回复或有新活动，会自动唤醒回主列表，也可随时点 Unsettle 移回。Settle 只记在本机浏览器的本地存储里。
- 待办快跳：有黄 / 蓝 / 绿底色对话时，顶栏显示待办数量徽标，点击，或按 `]` / `[`（焦点在输入框里时不触发；打开对话后 bb 会把焦点放进输入框，这时用 `Alt/Option + ]` / `[`，任何地方都能用）按侧边栏里的显示顺序循环跳转到下一条 / 上一条需要你处理的对话。
- 快速筛选：按 `/`（或点放大镜）输入，候选分三组——标题或分支、消息里提到、已归档；后两组来自 bb 官方搜索。方向键选择，回车打开，Esc 退出。
- 项目底部：没有对话的 worktree（含 Claude Code、ORCA、手动建的）和已合回分支收成页脚数字，展开后可直接在里面开新对话，或一键复制安全的 `git -C <主检出> worktree remove <路径>`（已合回附带 `git branch -d`）清理命令；只对 bb 之外的 worktree 提供（bb 托管的 worktree 由 bb 归档时自己清理），里面还有对话在跑或等你时不提供，命令绝不带 `--force` / `-D`（插件本身只读 git，绝不自动删目录）。
- 颜色全部取自 bb 主题变量，浅色、深色和自定义配色都跟随；整个侧边栏光标保持箭头；触屏下操作按钮常显且点击区域加大。

## 分支起点怎么来的

只用记录，不按提交历史推算，可信度从高到低：

1. bb 建 worktree 时记录的起点（环境的选择器输入 / mergeBaseBranch）
2. git 分支创建记录 `branch: Created from <分支>`
3. 创建记录只有提交号时，反查当时哪个分支指向它；`Created from HEAD` 时查 HEAD 的 checkout 记录
4. 都查不到：标“来源未知”

## 开发

```sh
npm install
npx tsc --noEmit -p tsconfig.json
npx vitest run
bb plugin build .
bb plugin install "path:$PWD" --yes      # 首次
bb plugin reload worktree-lineage        # 之后
bb settings ui set sidebar.threadListProvider worktree-lineage/lineage   # 启用
bb settings ui reset sidebar.threadListProvider                          # 回退到 bb 自带列表
```

插件只读 git，从不修改仓库或删除 worktree。除了写速览时调用模型网关或本机的 claude，不联网。

## 同系列 BB 插件

- [bb-plugin-worktree-lineage](https://github.com/waiclay-349687/bb-plugin-worktree-lineage)（本插件）：左侧线程列表，按对话 / 分支树双视图展示，带 Settle 软收起、待办快跳、悬停全程速览与丝滑动效
- [bb-plugin-session-cockpit](https://github.com/waiclay-349687/bb-plugin-session-cockpit)：右上角会话驾驶舱，按 Progress / Usage / Workspace 分组展示阶段进度、上下文明细、缓存与本地服务（与本插件共享速览数据）
- [bb-plugin-usage-rings](https://github.com/waiclay-349687/bb-plugin-usage-rings)：左下角侧边栏额度圆环，统一展示各家 Agent 计划用量与配速（含 Antigravity）

## License

MIT, see [LICENSE](LICENSE).
