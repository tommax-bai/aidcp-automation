/**
 * 自动化进程的文本模型调用出口（task 2.5 岔口 A · A-1/A-2 的可构造那一半）。
 *
 * ## 为什么这条只能走共享包
 *
 * `src/llm/*` 在归属表里是 **content**，派生器不会把它拷进本仓的 `src/`。
 * 而模型出口是自动化进程自己要用的东西（角色调度器每次决策都要调），所以本仓**只能经包取**。
 * 这是本仓第一条 `aidcp-transport` 依赖，也是它被**显式放行**的唯一形态：
 * `aidcp-transport/llm/*` 不是传输原语，本仓不对它做任何 `instanceof`
 * （其余 `aidcp-transport/transport/*` 一律禁止，见 `test/acceptance/transport-single-copy.test.ts`——
 * 本仓是传输目录的属主，取第二份会让基于类型的错误判别静默恒 false）。
 *
 * **`import` 走 `aidcp-transport/llm/qwen.js`，不是任何桶文件**：那个桶 `export * from './vision.js'`，
 * 在模块图里就是一条边，取它等于把整条内容视觉栈拖进本进程。
 *
 * ## 三条必须照做的纪律（每一条都对着一个真会静默发生的后果）
 *
 * 1. **`apiKey` MUST 显式传，哪怕是空串。** 模型客户端的构造是
 *    `options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? ''` —— 不传时不报错也不抛，
 *    而且**构造非 dashscope 厂商的出口时也会去读 dashscope 那个环境变量**。
 *    传一个显式空串会让那条 `??` 短路（空串不是 nullish），env 读根本不会发生。
 * 2. **MUST NOT 复刻四层回落逻辑。** 角色 → 厂商/模型/温度/思考的解析在**属主侧**已经算完，
 *    本进程只查本地镜像。复刻是两侧悄悄不一致的唯一来源，而不一致的现形方式不是报错，
 *    是「某个角色悄悄用了另一个模型」。
 * 3. **密钥读失败与「库里本来就没配」MUST 分得开。** 两者都会走 env 回退，但含义完全相反：
 *    前者说明属主侧那条读路由不可达（接线错误），后者是正常配置。裸 `catch(() => null)`
 *    会把前者长期伪装成后者、零信号——这正是本 change 的 A-3 修掉的那个活缺口。
 *    读失败**不拒绝启动**（属主域抖一下就停掉整个自动化进程是过度反应），但绝不许静默。
 *
 * ## 明文纪律
 *
 * 取回的密钥只用于构造出口客户端：MUST NOT 日志化、MUST NOT 回传、MUST NOT 落盘。
 * 本模块的返回值**刻意不含任何密钥**，自证只报「命中几项 / 读失败哪几项」。
 */
import { MODEL_CONFIG_DEFAULTS } from 'aidcp-kernel/kernel/model-config-defaults.js';
import type { ProviderSecretReader } from 'aidcp-kernel/kernel/provider-secret-port.js';
import type {
  RoleModelSelectionReader,
  RoleModelSelectionSource,
} from 'aidcp-kernel/kernel/role-model-selection-port.js';
import {
  resolveProviderBaseUrl,
  resolveProviderEnvKey,
  TEXT_PROVIDERS,
  type TextProviderId,
} from 'aidcp-transport/llm/providers.js';
import {
  QwenClient,
  type ChatLlmClient,
  type QwenClientOptions,
} from 'aidcp-transport/llm/qwen.js';

import type { InternalHttpClient } from './transport/internal-http.js';
import { ProviderSecretHttpClient } from './transport/provider-secret-http.js';
import {
  PollingRoleModelSelectionMirror,
  RoleModelSelectionHttpClient,
} from './transport/role-model-selection-http.js';

/** 单次模型调用的时长天花板。与仓内既有口径同源，别在这里另立一个数。 */
const DEFAULT_LLM_TIMEOUT_MS = 180_000;

export interface AutomationModelExitOptions {
  /**
   * 指向接口进程的内部 HTTP 客户端。**组装根已经有一个，传进来复用**——
   * 再 new 一个不会报错，只是多一份连接与一处会漂的基址。
   */
  apiHttp: InternalHttpClient;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn'>;
  /** 单次调用超时；缺省 {@link DEFAULT_LLM_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 角色模型镜像的刷新周期，透传给镜像（它自己有缺省）。 */
  roleModelRefreshMs?: number;
  onStart?: QwenClientOptions['onStart'];
  /**
   * 每次调用后的可观测钩子。**用量记账就挂在这里**（合并缓冲的家是自动化进程自己的
   * `main()`，见 task 2.4d-用量），本模块只留缝、不实现缓冲。
   */
  onCall?: QwenClientOptions['onCall'];
  /** 覆盖密钥读口（测试用）；缺省按 `apiHttp` 建属主侧窄读口。 */
  secrets?: ProviderSecretReader;
  /** 覆盖角色模型取源（测试用）；缺省按 `apiHttp` 建属主侧取源。 */
  roleModelSource?: RoleModelSelectionSource;
  /** 覆盖模型客户端构造（测试用）；缺省 `new QwenClient(...)`。 */
  createClient?: (options: QwenClientOptions) => ChatLlmClient;
}

export interface AutomationModelExitSecretReadReport {
  /** 从属主库里真取到值的项数。 */
  hits: number;
  /**
   * 读**失败**的项（`<厂商>/<字段>`）。**与「库里没配」是两件事**：
   * 非空意味着属主侧那条读路由不可达，本次这些项走的是 env 回退。
   */
  failures: readonly string[];
  /** 最终拿到非空密钥的厂商（**只报厂商名，绝不含密钥值**）。 */
  providersWithKey: readonly string[];
}

export interface AutomationModelExit {
  /** 交给角色调度器的那一口。 */
  client: ChatLlmClient;
  /** 角色模型解析的同步读口（调度器若要单独用它，取这一份，别再建第二个镜像）。 */
  roleModelSelection: RoleModelSelectionReader;
  /** 角色模型镜像是否拿到过真值；false = 正在用保守默认。 */
  roleModelLoaded(): boolean;
  secretRead: AutomationModelExitSecretReadReport;
  /** 停掉镜像的轮询。关停路径 MUST 调它。 */
  stop(): void;
}

/**
 * 构造文本模型出口。**启动期调一次**（每个厂商读一次密钥、镜像首刷一次）。
 *
 * 不会因为读不到密钥或取不到模型配置而抛：那两种情况都有明确的回落语义
 * （env 回退 / 保守默认），且都会留下一行说明本次到底是哪种。
 * 真正会抛的只有调用方传错了东西这类构造期错误。
 */
export async function createAutomationModelExit(
  options: AutomationModelExitOptions,
): Promise<AutomationModelExit> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const secrets = options.secrets ?? new ProviderSecretHttpClient(options.apiHttp);
  const roleModelSource =
    options.roleModelSource ?? new RoleModelSelectionHttpClient(options.apiHttp);

  const failures: string[] = [];
  let hits = 0;
  const readOwnerSecret = async (provider: string, field: string): Promise<string | null> => {
    try {
      const value = await secrets.getSecretForRuntime(provider, field);
      if (value) hits += 1;
      return value;
    } catch (error) {
      failures.push(`${provider}/${field}`);
      logger.warn(
        `[aidcp-automation] 厂商密钥读失败（${provider}/${field}）⇒ 本次回落 env；`
          + `这**不代表**库里没配：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };

  // 每厂商一份 {baseUrl, apiKey}：库内优先、env 回退。
  // **绝不跨厂商兜底**——选中的厂商缺密钥就是缺，客户端会诚实抛错。
  const providerRuntime: Record<string, { baseUrl: string; apiKey: string }> = {};
  const providersWithKey: string[] = [];
  for (const id of Object.keys(TEXT_PROVIDERS) as TextProviderId[]) {
    const remoteKey = await readOwnerSecret(id, TEXT_PROVIDERS[id].credentialField);
    const apiKey = remoteKey ?? resolveProviderEnvKey(id, env) ?? '';
    providerRuntime[id] = { baseUrl: resolveProviderBaseUrl(id, env), apiKey };
    if (apiKey) providersWithKey.push(id);
  }

  logger.log(
    `[aidcp-automation] 库内厂商密钥读：命中 ${hits} 项`
      + (failures.length === 0
        ? '，无读失败'
        : `，读失败 ${failures.length} 项（${failures.join(' ')}）`
          + ' ⇒ 这些项本次走的是 env 回退，不是「库里没配」，请查属主侧那两条 route 是否可达'),
  );

  const roleModelSelection = new PollingRoleModelSelectionMirror({
    source: roleModelSource,
    // 保守默认与属主侧配置存储同源（同一个 kernel 常量），绝不各写一份字面量。
    fallback: {
      provider: MODEL_CONFIG_DEFAULTS.textProvider,
      model: MODEL_CONFIG_DEFAULTS.textModel,
    },
    intervalMs: options.roleModelRefreshMs,
    logger,
  });
  // start() 内含一次立即刷新：启动期就喂上真值，而不是等第一个轮询周期。
  // 取不到不拒绝启动（保留保守默认 + warn），但下面这行自证会如实说明拿到的是哪一种。
  await roleModelSelection.start();
  logger.log(
    `[aidcp-automation] 角色模型镜像已就绪：${
      roleModelSelection.loaded() ? '真值' : '保守默认（取源未成功）'
    }`,
  );

  const create = options.createClient ?? ((clientOptions) => new QwenClient(clientOptions));
  const client = create({
    // 纪律 1：**显式传**，哪怕是空串。省掉这一行不会报错，只会让客户端去读 dashscope 那个
    // 环境变量——连构造非 dashscope 厂商的出口时也照读。
    apiKey: providerRuntime[MODEL_CONFIG_DEFAULTS.textProvider]?.apiKey ?? '',
    timeoutMs: options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    providerRuntime,
    // 纪律 2：四层回落在属主侧算完，这里只查镜像。
    getProvider: (role) => roleModelSelection.forRole(role).provider,
    getModel: (role) => roleModelSelection.forRole(role).model,
    getTemperature: (role) => roleModelSelection.forRole(role).temperature,
    getThinking: (role) => roleModelSelection.forRole(role).thinkingMode,
    onStart: options.onStart,
    onCall: options.onCall,
  });

  return {
    client,
    roleModelSelection,
    roleModelLoaded: () => roleModelSelection.loaded(),
    secretRead: { hits, failures, providersWithKey },
    stop: () => roleModelSelection.stop(),
  };
}
