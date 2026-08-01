// aidcp:test-owner=derived
/**
 * 文本模型出口的行为闸（task 2.5 岔口 A · A-1）。
 *
 * 三条纪律各自对着一个**不会报错、只会悄悄错**的后果，所以每条都要有会真触发它的用例：
 *
 * 1. `apiKey` 不显式传 → 客户端去读 dashscope 那个环境变量，**连构造非 dashscope 厂商时也照读**。
 *    没有编译错误、没有运行时异常，只是密钥来源悄悄变了。
 * 2. 复刻四层回落 → 属主侧改了默认模型名而这边没跟上时，某个角色悄悄用另一个模型。
 * 3. 密钥读失败被吞成「库里没配」→ 属主侧那条读路由不可达这件事永远没人知道，
 *    链路一直走 env 回退。
 *
 * **本文件不测模型客户端本身**（那是共享包的事），只测「本仓怎么构造它」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODEL_CONFIG_DEFAULTS } from 'aidcp-kernel/kernel/model-config-defaults.js';
import { TEXT_PROVIDER_META } from 'aidcp-kernel/kernel/text-provider-registry.js';
import type { ProviderSecretReader } from 'aidcp-kernel/kernel/provider-secret-port.js';
import type {
  RoleModelSelectionSnapshot,
  RoleModelSelectionSource,
} from 'aidcp-kernel/kernel/role-model-selection-port.js';
import type { QwenClientOptions } from 'aidcp-transport/llm/qwen.js';

import { createAutomationModelExit } from '../../src/automation-model-exit.js';
import { InternalHttpClient } from '../../src/transport/internal-http.js';

/** 本文件一次网络都不发：密钥读与模型取源都注入替身，`apiHttp` 只是个不会被用到的占位。 */
const UNUSED_HTTP = new InternalHttpClient('http://127.0.0.1:1');
const SILENT = { log: () => undefined, warn: () => undefined };

// 凭据字段名从 kernel 注册表取，**不写死**：写死一个 'ark_api_key' 之类的猜测，
// 用例照样全绿（替身按 key 查表、查不到就返回 null，看着像「库里没配」），
// 而真跑起来会去问一个属主侧根本不认的字段。这一条写这份用例时就已经中过一次。
const FIELD = {
  dashscope: TEXT_PROVIDER_META.dashscope.credentialField,
  volcengine: TEXT_PROVIDER_META.volcengine.credentialField,
} as const;

function secretsReturning(
  map: Record<string, string | null>,
  failOn: readonly string[] = [],
): ProviderSecretReader {
  return {
    getSecretForRuntime: async (provider, field) => {
      const key = `${provider}/${field}`;
      if (failOn.includes(key)) throw new Error(`route_unreachable:${key}`);
      return map[key] ?? null;
    },
  };
}

function sourceReturning(snapshot: RoleModelSelectionSnapshot): RoleModelSelectionSource {
  return { fetchRoleModelSelections: async () => snapshot };
}

const FAILING_SOURCE: RoleModelSelectionSource = {
  fetchRoleModelSelections: async () => {
    throw new Error('owner_unreachable');
  },
};

/** 收集构造实参，用来断「本仓传了什么给模型客户端」。 */
function capturing(): {
  options: QwenClientOptions[];
  create: (options: QwenClientOptions) => never;
} {
  const options: QwenClientOptions[] = [];
  return {
    options,
    create: ((clientOptions: QwenClientOptions) => {
      options.push(clientOptions);
      return {} as never;
    }) as (options: QwenClientOptions) => never,
  };
}

test('apiKey 必须显式传，且各厂商各取各的 key——绝不跨厂商、绝不落到 dashscope 那个 env', async () => {
  const captured = capturing();
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: SILENT,
    secrets: secretsReturning({
      [`dashscope/${FIELD.dashscope}`]: 'db-dashscope',
      [`volcengine/${FIELD.volcengine}`]: 'db-volcengine',
    }),
    roleModelSource: sourceReturning({
      fallback: { provider: 'dashscope', model: 'qwen-plus' },
      byRole: {},
    }),
    createClient: captured.create,
    // 故意给一个与库内值不同的 env：库内优先，这个值不该出现在任何厂商上。
    env: { DASHSCOPE_API_KEY: 'env-dashscope' },
  });
  exit.stop();

  const options = captured.options[0]!;
  assert.ok(
    Object.prototype.hasOwnProperty.call(options, 'apiKey'),
    'apiKey MUST 出现在构造实参里。省掉它没有编译错误，只会让客户端去读 dashscope 的环境变量——'
      + '连构造非 dashscope 厂商的出口时也照读',
  );
  assert.equal(options.apiKey, 'db-dashscope', '库内优先于 env');
  assert.deepEqual(options.providerRuntime?.dashscope?.apiKey, 'db-dashscope');
  assert.deepEqual(options.providerRuntime?.volcengine?.apiKey, 'db-volcengine');
  assert.deepEqual(
    exit.secretRead,
    { hits: 2, failures: [], providersWithKey: ['dashscope', 'volcengine'] },
    '自证只报计数与厂商名，MUST NOT 含密钥值',
  );
});

test('库内没配时回落 env，且回落是**按厂商各自的 env**，不是都去读 dashscope 那一个', async () => {
  const captured = capturing();
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: SILENT,
    secrets: secretsReturning({}),
    roleModelSource: sourceReturning({
      fallback: { provider: 'dashscope', model: 'qwen-plus' },
      byRole: {},
    }),
    createClient: captured.create,
    env: { DASHSCOPE_API_KEY: 'env-dashscope', ARK_API_KEY: 'env-ark' },
  });
  exit.stop();

  const runtime = captured.options[0]!.providerRuntime!;
  assert.equal(runtime.dashscope!.apiKey, 'env-dashscope');
  assert.equal(
    runtime.volcengine!.apiKey,
    'env-ark',
    '火山的 key MUST 来自它自己的 env，拿到 dashscope 那个值就是跨厂商兜底',
  );
  assert.deepEqual(exit.secretRead.failures, [], '「库里没配」不是读失败');
  assert.equal(exit.secretRead.hits, 0);
});

test('哪个厂商都没配时 apiKey 仍是显式空串（空串会让客户端那条 ?? 短路，env 读根本不发生）', async () => {
  const captured = capturing();
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: SILENT,
    secrets: secretsReturning({}),
    roleModelSource: sourceReturning({
      fallback: { provider: 'dashscope', model: 'qwen-plus' },
      byRole: {},
    }),
    createClient: captured.create,
    env: {},
  });
  exit.stop();
  assert.equal(captured.options[0]!.apiKey, '');
  assert.deepEqual(exit.secretRead.providersWithKey, []);
});

test('密钥读失败与「库里没配」分得开：失败要记名、要 warn，且不拒绝启动', async () => {
  const warnings: string[] = [];
  const captured = capturing();
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: { log: () => undefined, warn: (message: string) => warnings.push(message) },
    secrets: secretsReturning(
      { [`volcengine/${FIELD.volcengine}`]: 'db-volcengine' },
      [`dashscope/${FIELD.dashscope}`],
    ),
    roleModelSource: sourceReturning({
      fallback: { provider: 'dashscope', model: 'qwen-plus' },
      byRole: {},
    }),
    createClient: captured.create,
    env: { DASHSCOPE_API_KEY: 'env-dashscope' },
  });
  exit.stop();

  assert.deepEqual(
    exit.secretRead.failures,
    [`dashscope/${FIELD.dashscope}`],
    '读失败 MUST 记名。吞成 null 会让「属主侧那条 route 不可达」长期伪装成「库里本来就没配」',
  );
  assert.equal(exit.secretRead.hits, 1, '读失败不该被算成命中');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /不代表.*库里没配/, 'warn 必须点明这不是「没配」');
  assert.equal(
    captured.options[0]!.providerRuntime!.dashscope!.apiKey,
    'env-dashscope',
    '读失败照旧回落 env——不拒绝启动，但不许静默',
  );
});

test('角色 → 厂商/模型/温度/思考一律查镜像，MUST NOT 在本仓复刻四层回落', async () => {
  const captured = capturing();
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: SILENT,
    secrets: secretsReturning({}),
    roleModelSource: sourceReturning({
      fallback: { provider: 'dashscope', model: 'global-model' },
      byRole: {
        planner: {
          provider: 'volcengine',
          model: 'role-model',
          temperature: 0.7,
          thinkingMode: 'on',
        },
      },
    }),
    createClient: captured.create,
    env: {},
  });
  const options = captured.options[0]!;

  assert.equal(options.getProvider!('planner'), 'volcengine');
  assert.equal(options.getModel!('planner'), 'role-model');
  assert.equal(options.getTemperature!('planner'), 0.7);
  assert.equal(options.getThinking!('planner'), 'on');

  // 未登记角色 / 不带角色 → 全局那一层。**这是这条口的正常语义，不是降级**：
  // 单体里那种角色本来就穿过前两层落到全局。
  assert.equal(options.getModel!('unregistered'), 'global-model');
  assert.equal(options.getModel!(), 'global-model');
  assert.equal(options.getTemperature!('unregistered'), undefined, '未配温度 MUST 是 undefined——'
    + '给个数字等于替属主侧编一个它没说过的值');
  assert.equal(options.getThinking!('unregistered'), undefined);
  assert.equal(exit.roleModelLoaded(), true);
  exit.stop();
});

test('模型取源不可达时用保守默认、如实自证，且默认与属主侧同源（不是本仓另写的字面量）', async () => {
  const captured = capturing();
  const logs: string[] = [];
  const exit = await createAutomationModelExit({
    apiHttp: UNUSED_HTTP,
    logger: { log: (message: string) => logs.push(message), warn: () => undefined },
    secrets: secretsReturning({}),
    roleModelSource: FAILING_SOURCE,
    createClient: captured.create,
    env: {},
  });
  const options = captured.options[0]!;
  assert.equal(exit.roleModelLoaded(), false);
  assert.equal(options.getModel!(), MODEL_CONFIG_DEFAULTS.textModel);
  assert.equal(options.getProvider!(), MODEL_CONFIG_DEFAULTS.textProvider);
  assert.ok(
    logs.some((line) => line.includes('保守默认（取源未成功）')),
    '拿到的是真值还是保守默认，启动日志 MUST 说得出来',
  );
  exit.stop();
});
