/**
 * 离场**清理授权**（签发 / 烧票）端口的跨进程传输。
 *
 * 为什么必须有它：这两笔事务碰的表全是 automation 属主（离场记录 + 离场审计），一张 api 表都没有，
 * 而调用点在接口进程的客户鉴权路由上。拆开之后接口进程不该持有 automation 库的连接，
 * 端口在接口进程侧一直没有实现 —— 表现是**客户端拿不到清理票**：
 * 签发那一步直接抛，路由把它变成 500（不是一个具名业务拒绝）。
 *
 * 两条 MUST 原样穿过传输层、**MUST NOT 在这一层降级**：
 *   1. 签发返回 `false` 是**属主给出的业务拒绝**（不归属 / 状态不符 / 行不存在）。
 *      跨进程调用失败 MUST 抛，MUST NOT 折成 `false` —— 折了，调用方就会把「问不到」
 *      当成「属主拒绝了」，而这两件事在客户端上是两种完全不同的处置。
 *   2. 烧票的五档失败判定顺序（`not_found` → `scope_mismatch` → `already_used` → `expired`
 *      → `not_pending`）是属主的判定，传输层原样搬回，**绝不重排、绝不新增第六档**。
 *
 * `now` 由调用方给定（kernel 端口不变量 4），故它是入参的一部分、绝不由属主侧自取当前时间 ——
 * 传输层原样转发，不做任何补齐。
 */
import type {
  ConsumeOffboardCleanupGrantInput,
  ConsumeOffboardCleanupGrantOutcome,
  IssueOffboardCleanupGrantInput,
  OffboardCleanupGrantOperations,
} from 'aidcp-kernel/kernel/offboard-cleanup-grant-types.js';
import type { InternalCallSink, InternalRouteSink } from './internal-http.js';

export const OFFBOARD_CLEANUP_GRANT_ROUTES = {
  issueCleanupGrant: 'offboard-cleanup-grant/issue',
  consumeCleanupGrant: 'offboard-cleanup-grant/consume',
} as const satisfies Record<keyof OffboardCleanupGrantOperations, string>;

/** 在属主进程里把两个操作挂上。端口是闭集合，**一条不少地开**。 */
export function registerOffboardCleanupGrantRoutes(
  server: InternalRouteSink,
  local: OffboardCleanupGrantOperations,
): void {
  server.register(OFFBOARD_CLEANUP_GRANT_ROUTES.issueCleanupGrant, (args) =>
    local.issueCleanupGrant(args as IssueOffboardCleanupGrantInput),
  );
  server.register(OFFBOARD_CLEANUP_GRANT_ROUTES.consumeCleanupGrant, (args) =>
    local.consumeCleanupGrant(args as ConsumeOffboardCleanupGrantInput),
  );
}

/**
 * 端口的 HTTP 实现（跑在调用方进程里）。
 *
 * **逐方法显式转调**：绝不用对象展开去「继承」实现 —— 展开拿不到类实例原型上的方法，
 * 那种错编译得过、要真跑起来才现形。
 */
export class OffboardCleanupGrantHttpClient implements OffboardCleanupGrantOperations {
  constructor(private readonly http: InternalCallSink) {}

  issueCleanupGrant(input: IssueOffboardCleanupGrantInput): Promise<boolean> {
    return this.http.call<boolean>(OFFBOARD_CLEANUP_GRANT_ROUTES.issueCleanupGrant, {
      ...input,
    });
  }

  consumeCleanupGrant(
    input: ConsumeOffboardCleanupGrantInput,
  ): Promise<ConsumeOffboardCleanupGrantOutcome> {
    return this.http.call<ConsumeOffboardCleanupGrantOutcome>(
      OFFBOARD_CLEANUP_GRANT_ROUTES.consumeCleanupGrant,
      { ...input },
    );
  }
}
