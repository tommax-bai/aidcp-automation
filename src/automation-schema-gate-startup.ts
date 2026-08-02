/**
 * 自动化进程的启动期 schema 契约门（task 3.5d，批 H 第 2 片）。
 *
 * ## 这个文件存在的理由：本仓此前一个调用点都没有
 *
 * `src/schema/schema-gate.ts` 是从单体派生过来的**完整实现**，两个测试文件在用它，
 * 而 `src/` 下**零调用点** —— 也就是说，自动化进程今天即使真启动起来，也是在
 * **完全没有校验过 schema** 的前提下去连库、建存储、放行业务的。这正是本 change
 * 反复点名的那个形态：**东西建好了、没人用，而它不在场时什么都不表现。**
 *
 * ## 形态照内容进程办，MUST NOT 照接口进程办
 *
 * - 内容进程（`aidcp-content/src/server.ts`）把门放在 `main()` 里、**建池之前**，
 *   裸 `await`、无 try/catch ⇒ 失败即 `process.exit(1)` ⇒ systemd 的重启语义成立；
 * - 接口进程**根本没有这道门**，改用逐存储的 schemaEnsurer，且跑在建池**之后**；
 *   更坏的是它的组装根在 try/catch 之外被裸 await ⇒ 关停路径不可达 ⇒ 已建的池永不
 *   `end()`，而入口只设 `exitCode`、不调 `exit` ⇒ **进程很可能压根不退出**，
 *   systemd 看到的是 `active (running)` 的僵尸：既不服务，也不重启。
 *
 * ## 为什么不像内容进程那样显式传路径
 *
 * 内容进程是从 `aidcp-transport` 这个**包**里 import 的门，那份实现「往上两级」的默认基准
 * 指向包目录，那里没有 `migrations/`，所以它 MUST 显式传本仓路径。
 * 本仓不一样：`src/schema/` 是**本仓自己的源码**，默认基准 `src/schema/../..` 正好是仓根，
 * 而仓根下确有 `migrations/`（57 条）与 `boundaries/table-ownership.json`。
 * ⇒ 这里显式传路径反而是多写一份手抄的路径常量。
 *
 * ## 只判 automation 一个属主
 *
 * 判据是「**本进程真正打开了哪些属主库连接**」，不是「跑的是哪个服务模式」。
 * 本仓全仓只有两处建池，两处都是 `resolveOwnerPgConfig('automation')`
 * （组装根的属主池 + 风控写者锁那条 max:1 的专用连接）⇒ 集合恒等于 `['automation']`。
 * 传入集合之外的属主**不读账本、不判定、不出现在结论里**：本进程既然不连 api / content 的库，
 * 就没有立场声称它们的 schema 对或不对 —— 那种「校验通过但其实什么都没校验到」的假绿，
 * 正是这道门存在的意义的反面。
 */
import {
  runSchemaContractGate,
  type LedgerQueryable,
  type SchemaGateResult,
} from './schema/schema-gate.js';
import type { SchemaGateMode } from './schema/schema-contract.js';
import type { MigrationOwnerScopes } from './schema/migration-owners.js';
import type { PgOwner } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';

/**
 * 本进程打开的属主库集合。**唯一定义处**——门的取值、回执的自检都从这里取。
 *
 * 别在第二处手写一遍 `['automation']`：本 change 已经因为「同一份名单被手抄第二遍」
 * 挨过多次（拼错也照样编译过、少写一项测试全绿）。
 */
export const AUTOMATION_PG_OWNERS = ['automation'] as const satisfies readonly PgOwner[];

/** 只有本模块能造回执的凭据；`unique symbol` 不导出 ⇒ 外部无法拼一个字面量出来。 */
declare const AUTOMATION_SCHEMA_GATE_RECEIPT: unique symbol;

/**
 * 门跑过了的**回执**。
 *
 * ## 它为什么是一张凭证、而不是一个布尔
 *
 * 这道门唯一的失效形态不是「判错了」，是「**没人调它**」——而「没调」在行为上什么都不表现：
 * 进程照常起来、日志照常打、测试照常绿，只有某天 schema 落后时才会以最难查的形态爆出来
 * （门本该拦住的那一次，它不在场）。
 *
 * 所以把它做成**不可伪造**的回执，并让启动外壳 {@link AutomationServiceOptions.schemaGate}
 * 必填持有它：`main()` 想启动就必须先真的调过一次门，且必须在**调外壳之前**调 ——
 * 而外壳之前，池和那十几个工厂都还没造。这条顺序因此变成**编译期可见**的，
 * 不再依赖「记得要做」。
 *
 * **外壳不重跑门、也重跑不了**（门只该在进程一生里跑一次、在任何存储 init 之前）。
 * 它对这张回执只做两件事：核一下判的属主集合就是本进程连的那些，以及把结论打进启动日志。
 */
export interface AutomationSchemaGateReceipt {
  readonly [AUTOMATION_SCHEMA_GATE_RECEIPT]: true;
  /** 实际判定过的属主。恒为 {@link AUTOMATION_PG_OWNERS}。 */
  readonly owners: readonly PgOwner[];
  readonly mode: SchemaGateMode;
  /** 逐属主结论文本里最严重的那条（全通过时即唯一那条）。 */
  readonly conclusion: string;
  /** warn 模式下可能为 false —— enforce 模式下 false 根本走不到这里（门自己抛）。 */
  readonly pass: boolean;
}

/**
 * `main()` 的**第一句**，建池之前。
 *
 * **MUST NOT 包 try/catch**（`schema-gate.ts` 文件头明写）：吞掉它就等于恢复
 * 「schema 落后照样启动」的静默假成功，而这道门是 fail-closed 的全部价值所在。
 * enforce 模式下门自己抛，异常一路冒到 `main()` 外，进程以非 0 退出、systemd 重启 —— 这是设计。
 *
 * 参数只为测试注入而存在（账本桩 / 判据加载器 / 模式）；生产上一律不传，
 * 让门自己按 `AIDCP_SCHEMA_GATE` 与属主连接配置去判。
 */
export async function runAutomationStartupSchemaGate(options?: {
  client?: LedgerQueryable;
  clients?: Partial<Record<PgOwner, LedgerQueryable>>;
  mode?: SchemaGateMode;
  loadScopes?: () => Promise<MigrationOwnerScopes>;
}): Promise<AutomationSchemaGateReceipt> {
  const result: SchemaGateResult = await runSchemaContractGate({
    ...options,
    owners: AUTOMATION_PG_OWNERS,
    // 日志前缀：不传的话打出来的是 `[aidcp-cloud]`（这份实现的事实源在单体）。
    // 这条日志是门拒绝启动时 journal 里唯一的线索，打成别的服务名会把排查直接引偏。
    serviceLabel: 'aidcp-automation',
  });
  // 先按**去掉品牌位的完整形状**构造，再只把品牌位强转上去。
  // 直接对字面量写 `as AutomationSchemaGateReceipt` 是不行的：整体强转会连「四个字段写全没有」
  // 一起静音（本 change 已实测过一次——一个整体强转掩掉了手抄契约漏的四个字段）。
  const receipt: Omit<AutomationSchemaGateReceipt, typeof AUTOMATION_SCHEMA_GATE_RECEIPT> = {
    owners: result.owners.map((entry) => entry.owner),
    mode: result.mode,
    conclusion: result.conclusion,
    pass: result.pass,
  };
  return receipt as AutomationSchemaGateReceipt;
}
