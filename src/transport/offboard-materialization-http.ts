/**
 * 离场台账**物化端口**的跨进程传输。
 *
 * 为什么必须有它：这个端口写的全是 automation 属主表（离场台账 / 收权 / 审计），而调用方
 * （客户身份与环境归属）住在接口进程里。单体时代它是同进程直写；拆开之后接口进程**不该持有
 * automation 库的连接**，端口在接口进程侧一直没有实现 —— 于是「客户删环境」这条路上的同步物化
 * **每一次都抛**，被调用点的 try/catch 收成「已受理、等对账」。
 *
 * **这条降级路径本身是设计好的**（对账循环会把它捡回去物化），所以它不报错、不告警，
 * 只是每一次删环境都慢一拍、且只要有一次对账没跑到就一直停在「已受理」。
 * 端口接上之后，请求内就地物化重新成为主路径，对账循环退回它本来的角色：兜底。
 *
 * 失败语义原样穿过传输层，**MUST NOT 在这一层降级**：kernel 端口写明
 * 「解析不到绑定 MUST 回 `binding_missing`、绝不返回成功」——
 * 把跨进程调用失败折成 `binding_missing` 会让调用方把「问不到」当成「确实没绑定」，
 * 那正是本仓红线里的静默假成功。传输层只搬结果，抛就让它抛。
 */
import type {
  MaterializeEnvironmentOffboardInput,
  MaterializeEnvironmentOffboardOutcome,
  OffboardMaterializationOperations,
} from 'aidcp-kernel/kernel/offboard-materialization-types.js';
import type { InternalCallSink, InternalRouteSink } from './internal-http.js';

export const OFFBOARD_MATERIALIZATION_ROUTES = {
  materializeEnvironmentOffboard: 'offboard-materialization/materialize-environment-offboard',
} as const satisfies Record<keyof OffboardMaterializationOperations, string>;

/** 在属主进程里把物化操作挂上。 */
export function registerOffboardMaterializationRoutes(
  server: InternalRouteSink,
  local: OffboardMaterializationOperations,
): void {
  server.register(
    OFFBOARD_MATERIALIZATION_ROUTES.materializeEnvironmentOffboard,
    (args) => local.materializeEnvironmentOffboard(args as MaterializeEnvironmentOffboardInput),
  );
}

/**
 * 端口的 HTTP 实现（跑在调用方进程里）。
 *
 * **逐方法显式转调**：绝不用对象展开去「继承」实现 —— 展开拿不到类实例原型上的方法，
 * 那种错编译得过、要真跑起来才现形。
 */
export class OffboardMaterializationHttpClient implements OffboardMaterializationOperations {
  constructor(private readonly http: InternalCallSink) {}

  materializeEnvironmentOffboard(
    input: MaterializeEnvironmentOffboardInput,
  ): Promise<MaterializeEnvironmentOffboardOutcome> {
    return this.http.call<MaterializeEnvironmentOffboardOutcome>(
      OFFBOARD_MATERIALIZATION_ROUTES.materializeEnvironmentOffboard,
      { ...input },
    );
  }
}
