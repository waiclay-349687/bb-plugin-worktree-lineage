# bb-plugin-worktree-lineage: 按“代码从哪来”排列的 bb 侧边栏线程列表
TypeScript 5.7 + React 19 + @get-bb/plugin-sdk 0.6.132 + zod 4 + vitest 3（bb ≥ 0.49）

<directory>
lib/: 契约与纯逻辑，关键文件: contract.ts（三端数据契约）、lineage.ts（分支血缘推断，纯函数）、git-scan.ts（host 端读 git）、tree.ts（对话挂到血缘树）、conversations.ts（对话视图的模型）、view.ts（分支树视图的模型 + 安全清理命令生成）、settle.ts（本地 Settle 软收起判定与智能唤醒、待办按屏幕行序循环跳转）、row-menu.ts（行操作菜单：搁置可见规则、并进 bb 线程菜单的插件项、注册的图标名）、i18n.ts（界面语言：auto / en / zh 解析、en 与 zh 两本同构词典、设置项英文文案、按语言的相对时间）、briefing.ts（全程速览的提要、提示词与输出校验，纯函数）、model-run.ts（host 端调模型：本机网关一次 HTTP（429 最多冷却 25 分钟 / 连不上冷却 60 秒），或一次性的本机 claude）、motion.ts（列表入场/退场状态机与嵌套抵消 FLIP 纯函数）
components/: 侧边栏界面与插件设置页，关键文件: lineage-list.tsx、settings-section.tsx（设置页的“状态与快捷操作”面板：语言切换、速览开关与运行状态、清冷却、本机搁置数与全部取消搁置）、i18n.tsx（LanguageProvider / useT：按设置值或 BB 界面语言解析语言，镜像到 localStorage，报告给服务端）、motion.tsx（存在感列表与全局 FLIP 滑移）、peek.tsx（悬停速览卡）、icons.tsx（自绘图标）；ui/icon.tsx 为 SDK 图标的薄封装
styles.css: 全部视觉（wl- 前缀类）。两个视图各有主角：对话视图一条对话一行、不出现分支；分支树视图分支是主行、对话是次级行。对齐只有一条规则：下一级的图标对齐上一级文字的左缘（一级 = 23px，层数由组件写在 --wl-depth 上）；行尾是固定宽度的槽，所有行的右边线对齐；全列表没有双行（搜索结果除外）。新加 CSS 变量前先 grep，避免重名（--wl-row 是行高）。颜色只用宿主主题变量（--ink / --sidebar / --primary / 语义色），禁止颜色字面量，以跟随任意主题；整个侧边栏光标一律为箭头（含按钮与对话行），唯一的例外是悬停卡片：里面的文字可以选中复制，所以是文字光标；颜色即含义，整行底色三种：黄 = 输入框里有没发出去的草稿，蓝 = 它停下来等你（等你回复或出错，行尾标记区分两者），绿 = 做完了你还没看，规则在 lib/view.ts 的 rowTone / rowColor（底色的 CSS 变量叫 --wl-hue；--wl-row 是行高，撞过一次名）；“等你”在悬停卡片和 session-cockpit 的 Progress 分区里也用同一种蓝；圆角只用 bb 设计系统的三档（由主题 --radius 推出：sm 4px 小按钮 / md 6px 行、菜单、输入框 / lg 8px 卡片），不写别的数值；圆点与圆形标记（999px）不在此限
docs/screenshots/: README 用的演示截图（conversation-view.png、branch-tree-view.png），只含演示数据；重拍时在临时浏览器里把真实项目名、标题、分支、路径全部换成演示数据，并逐张看图确认
test/: vitest 用例（row-menu.test.ts 覆盖搁置可见规则与菜单项组装；settings.test.ts 覆盖冷却清单、搁置记录解析与清理、设置页 RPC 契约）；git-scan.test.ts 会在系统临时目录建真实 git 仓库；model-run.test.ts 在 127.0.0.1 随机端口起假网关；briefings.test.ts 用假 callModel 与假时钟测网关模型链回退、冷却与过期恢复
host.ts: host 入口，在每台机器上执行 scanLineage（只读 git）与 writeBriefing（按 route 走本机网关 HTTP 或一次性的本机 claude，一次只走一条）
server.ts: 服务端，汇总 bb 项目源 / 环境记录的起点分支，调度 host，15s 缓存；定义五项设置并接线（language 界面语言默认 auto；briefingEnabled 开关、briefingGatewayUrl 网关地址默认 http://127.0.0.1:3425、briefingGatewayModel 逗号分隔的有序网关模型列表默认 "workbuddy/deepseek-v4.1-flash, opencode-zen/deepseek-v4.1-flash-free"、briefingModel 兜底的 claude 模型默认 haiku）
briefings.ts: 服务端的速览调度：thread.idle 时把对话排进队列，一次写一条，结果存 bb.storage.kv（键 briefing:<threadId>）；每条按顺序试网关上的模型链，某个模型失败或输出过不了 parseBriefing 就试下一个，全不行再兜底本机 claude（generateBriefing）；429 的模型按 Retry-After 冷却（缺省 15 分钟、最多 25 分钟），网关连不上整体冷却 60 秒，冷却表在内存里按 机器 + 网关 + 模型 记，冷却中的直接跳过；日志写明命中的 via gateway <模型> / via claude <模型> (fallback)、每个失败的模型（warn）与冷却中跳过的模型（附在结果行，不单独 warn）；启动时为最近 14 天活跃的对话补写（最多 40 条）；每天上限 300 次，连续失败 3 次（网关与 claude 都失败才算一次）清空队列
app.tsx: 前端入口，导入 styles.css，注册 experimental_threadList 槽位 "lineage"（标题按同步读出的界面语言）与 settingsSection "overview"（不交宿主渲染标题，面板自己按当前语言画）
</directory>

<config>
package.json: bb 插件清单（bb.server / bb.app / bb.host 三入口）与脚本
tsconfig.json: 严格模式，@/* 指向仓库根
README.md / README.zh-CN.md: 英文主页与简体中文版，结构一一对应，改一份要同步另一份；配置表与 server.ts 的 settings.define 保持一致
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
界面语言零混用：所有界面文案只从 lib/i18n.ts 的词典取（components 里不许再写字面量文案；bb 给的英文操作名也要按 key 换成词典里的叫法）；英文词典不含汉字、中文词典只允许专有名词与代码（Git、BB、HEAD、分支名、路径、命令、按键名），由 test/i18n.test.ts 机械校验。auto 跟随 BB 界面的 <html lang>，为空才看浏览器语言（与 usage-rings、session-cockpit 一致，英文 BB 里 auto 就是英文）；bb 渲染的设置页不能随语言切换，设置项文案固定英文。速览按语言写：存盘的速览记 language（缺省按 zh），语言不一致的既不显示也算落后，设置改语言时补写，auto 下前端报告的语言变了且稳定 1 分钟后补写（30 分钟内最多一次）。
设置面板：改设置一律经 updateSettings RPC 写进 bb.settings（与声明式设置、CLI 同一份）；useSettings 不会实时推送，所以面板切换语言时先 applyLanguageLocally（写镜像 + 派发事件）让同一页面立即重画。本机搁置记录的键、解析与“列表加载完才清理”（settledToPrune）都在 lib/settle.ts，设置页清空后派发 SETTLED_CHANGED_EVENT 让列表重读。
行操作菜单：插件的搁置 / 取消搁置与“在此新建”只经 inline 并进 bb 的线程菜单——对话行外层的 ThreadActionsContextMenu（桌面右键、手机长按）与桌面悬停的“更多”（ThreadActionsMenu）传同一份 inline（lineage-list 的 threadInline），不另加 ⋯ 按钮；分支行没有 bb 的线程菜单，保留原来的 + 与 >_（触屏常显）；插件项的图标名在 app.tsx 注册（宿主菜单只认图标名）；搁置的可见规则只在 lib/row-menu 的 settleMode 一处。宿主菜单里 bb 自己的项跟随 bb 的语言，插件改不了。
只能上下滚动：.wl-root 宽度等于宿主宽度，overflow-x: clip + touch-action: pan-y；顶栏放不下时分段控件的文字截成省略号，其余按钮不缩；新加的东西不许撑出 .wl-root（手机 390 宽下实测 scrollWidth <= clientWidth）。
依赖的 SDK 接口均为 experimental_*，bb 升级后需回归验证。
</compatibility>
