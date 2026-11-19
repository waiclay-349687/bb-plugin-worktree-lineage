/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/host 的 experimental_defineHostEntry、lib/contract.ts 的 hostContract、lib/git-scan.ts 的 scanRepository、lib/model-run.ts 的 runModel
 * [OUTPUT]: 对外提供 host 入口（default export）: 处理 scanLineage（在持有仓库的机器上扫描分支血缘）与 writeBriefing（一次性调用本机的小模型）
 * [POS]: 插件的 host 侧入口（package.json bb.host）; 消费者: bb daemon、server.ts（经 hostContract 调用）; 与 server.ts 的边界: 这里只跑本机命令（只读 git、一问一答的 claude），聚合、缓存、何时生成都在 server
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./lib/contract";
import { scanRepository } from "./lib/git-scan";
import { runModel } from "./lib/model-run";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    // scanRepository 自身兜住所有异常并返回 failed，这里无需再 catch
    scanLineage: (input) => scanRepository(input),
    // runModel 同样兜住所有异常并返回 failed
    writeBriefing: (input) => runModel(input),
  },
});
