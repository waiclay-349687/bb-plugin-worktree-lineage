# bb-plugin-worktree-lineage: 按“代码从哪来”排列的 bb 侧边栏线程列表
TypeScript 5.7 + React 19 + @get-bb/plugin-sdk 0.6.132 + zod 4 + vitest 3（bb ≥ 0.49）

<directory>
lib/: 契约与纯逻辑，关键文件: contract.ts（三端数据契约）、lineage.ts（分支血缘推断，纯函数）、git-scan.ts（host 端读 git）、tree.ts（对话挂到血缘树）、conversations.ts（对话视图的模型）、view.ts（分支树视图的模型）、briefing.ts（全程速览的提要、提示词与输出校验，纯函数）、model-run.ts（host 端调模型：本机网关一次 HTTP（429 / 连不上时给出冷却建议），或一次性的本机 claude）、motion.ts（列表入场/退场状态机与嵌套抵消 FLIP 纯函数）
components/: 侧边栏界面，关键文件: lineage-list.tsx、motion.tsx（存在感列表与全局 FLIP 滑移）、peek.tsx（悬停速览卡）、icons.tsx（自绘图标）；ui/icon.tsx 为 SDK 图标的薄封装
styles.css: 全部视觉（wl- 前缀类）。两个视图各有主角：对话视图一条对话一行、不出现分支；分支树视图分支是主行、对话是次级行。对齐只有一条规则：下一级的图标对齐上一级文字的左缘（一级 = 23px，层数由组件写在 --wl-depth 上）；行尾是固定宽度的槽，所有行的右边线对齐；全列表没有双行（搜索结果除外）。新加 CSS 变量前先 grep，避免重名（--wl-row 是行高）。颜色只用宿主主题变量（--ink / --sidebar / --primary / 语义色），禁止颜色字面量，以跟随任意主题；整个侧边栏光标一律为箭头（含按钮与对话行），唯一的例外是悬停卡片：里面的文字可以选中复制，所以是文字光标；颜色即含义，整行底色三种：黄 = 输入框里有没发出去的草稿，蓝 = 它停下来等你（等你回复或出错，行尾标记区分两者），绿 = 做完了你还没看，规则在 lib/view.ts 的 rowTone / rowColor（底色的 CSS 变量叫 --wl-hue；--wl-row 是行高，撞过一次名）；“等你”在悬停卡片和 session-cockpit 的 Progress 分区里也用同一种蓝；圆角只用 bb 设计系统的三档（由主题 --radius 推出：sm 4px 小按钮 / md 6px 行、菜单、输入框 / lg 8px 卡片），不写别的数值；圆点与圆形标记（999px）不在此限
test/: vitest 用例；git-scan.test.ts 会在系统临时目录建真实 git 仓库；model-run.test.ts 在 127.0.0.1 随机端口起假网关；briefings.test.ts 用假 callModel 与假时钟测网关模型链回退、冷却与过期恢复
host.ts: host 入口，在每台机器上执行 scanLineage（只读 git）与 writeBriefing（按 route 走本机网关 HTTP 或一次性的本机 claude，一次只走一条）
server.ts: 服务端，汇总 bb 项目源 / 环境记录的起点分支，调度 host，15s 缓存；定义速览的四项设置并接线（briefingEnabled 开关、briefingGatewayUrl 网关地址默认 http://127.0.0.1:3425、briefingGatewayModel 逗号分隔的有序网关模型列表默认 "workbuddy/deepseek-v4.1-flash, opencode-zen/deepseek-v4.1-flash-free"、briefingModel 兜底的 claude 模型默认 haiku）
briefings.ts: 服务端的速览调度：thread.idle 时把对话排进队列，一次写一条，结果存 bb.storage.kv（键 briefing:<threadId>）；每条按顺序试网关上的模型链，某个模型失败或输出过不了 parseBriefing 就试下一个，全不行再兜底本机 claude（generateBriefing）；429 的模型按 Retry-After 冷却（缺省 15 分钟、最多 2 小时），网关连不上整体冷却 60 秒，冷却表在内存里按 机器 + 网关 + 模型 记，冷却中的直接跳过；日志写明命中的 via gateway <模型> / via claude <模型> (fallback)、每个失败的模型（warn）与冷却中跳过的模型（附在结果行，不单独 warn）；启动时为最近 14 天活跃的对话补写（最多 40 条）；每天上限 300 次，连续失败 3 次（网关与 claude 都失败才算一次）清空队列
app.tsx: 前端入口，导入 styles.css，注册 experimental_threadList 槽位 "lineage"
</directory>

<config>
package.json: bb 插件清单（bb.server / bb.app / bb.host 三入口）与脚本
tsconfig.json: 严格模式，@/* 指向仓库根
GLOSSARY.md: 用语表（对话视图、分支树视图、派出、起点、已合回、三种行色、速览）；界面和文档里的叫法以它为准，改叫法先改它
</config>

<commands>
typecheck: npx tsc --noEmit -p tsconfig.json
lint: 无（未配置）
test: npx vitest run
build: bb plugin build .
install/reload: bb plugin install "path:$PWD" --yes / bb plugin reload worktree-lineage
启用: bb settings ui set sidebar.threadListProvider worktree-lineage/lineage；回退: bb settings ui reset sidebar.threadListProvider
</commands>

<compatibility>
个人插件；lib/contract.ts 是 host/server/app 三端唯一契约，改字段必须三端同改。
唯一的外部调用方：session-cockpit 插件按插件 id 只读 serverContract.briefing（它自己抄了一份只含所读字段的契约，形状对不上就隐藏那个分区）。改 briefingViewSchema 的字段名或含义时要同步改 `bb-plugin-session-cockpit` 仓库的 `components/cockpit/progress-section.tsx`。
只读 git：插件从不写仓库、不删 worktree。分支起点只用“记录”（bb 环境记录、git reflog），不按提交历史推算；查不到标 unknown。
速览是唯一调用模型的地方，约束：只在一轮对话结束（thread.idle）或启动补写时生成，悬停与读取（briefing RPC）绝不触发；优先按顺序走 briefingGatewayUrl 指向的 OpenAI 兼容网关上的模型链（默认本机 Magpie：workbuddy DeepSeek → 免费 DeepSeek；对话提要会发给网关背后的服务商；付费直连的模型不要放进默认链），连不上 / 45s 超时 / 非 2xx / 无正文 / 过不了 parseBriefing 都试下一级，最后兜底本机 claude，地址留空则只用 claude；调用本机 claude 必须带 --setting-sources "" 与 disableAllHooks（用户的钩子会唤起别的工具）、--no-session-persistence、--tools ""；存盘的速览按“对话大纲的指纹”（outlineKey = 条数 + 最后一条的标识）判断是否落后，任何新消息都算，不只是新要求；不用 updatedAt（打开对话也会改它）；改提示词或输出结构要加 BRIEFING_VERSION。
依赖的 SDK 接口均为 experimental_*，bb 升级后需回归验证。
</compatibility>
