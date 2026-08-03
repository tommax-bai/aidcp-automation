import { pathToFileURL } from 'node:url';
import pg from 'pg';

import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { parseDeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import {
  isSyncReadFactPayload,
  type SyncReadPayloadByStream,
} from 'aidcp-kernel/kernel/sync-read-facts.js';
import type {
  SyncReadApplyResult,
  SyncReadConsumerCheckpoint,
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';
import {
  parseSyncReadSnapshotEnvelope,
  SYNC_READ_CHANGED_TOPIC,
  SYNC_READ_STREAM_DEFINITIONS,
} from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import { FacebookScopeCommandReceiver } from './comment-agent/facebook-scope-command-receiver.js';
import type { FacebookScopeCommandReceiverDeps } from './comment-agent/facebook-scope-command-receiver.js';
import { EdgeResumeCommandReceiver } from './comm/edge-resume-command-receiver.js';
import type { EdgeResumeCommandReceiverDeps } from './comm/edge-resume-command-receiver.js';
import { PublishUiUpdateCommandReceiver } from './comm/publish-ui-update-command-receiver.js';
import type { PublishUiUpdateCommandReceiverDeps } from './comm/publish-ui-update-command-receiver.js';
import { AutomationOffboardAdmissionReconciler } from './interactions/offboard-admission-reconciler.js';
import { PgClientEnvAutomationRead } from './interactions/client-env-automation-read.js';
import { PgOffboardMaterializationOps } from './interactions/offboard-write-adapter.js';
import {
  AccountOwnershipHttpClient,
  AccountRosterHttpClient,
  AccountRuntimeHttpClient,
} from './transport/api-account-authority-http.js';
import {
  AccountPersonaHttpClient,
  AutomationConfigCommandsHttpClient,
  CommentApprovalPolicyHttpClient,
  ScheduleFeedbackHttpClient,
  EnvironmentHandshakeHttpClient,
  FirstPostProgressHttpClient,
  NotificationContactsHttpClient,
  OffboardAdmissionLedgerHttpClient,
  StructuredNotificationHttpClient,
} from './transport/api-aux-authority-http.js';
import {
  AutomationPublishLogHttpClient,
  EdgePublishCommandHttpClient,
  InteractionApiWritesHttpClient,
  InteractionAuthHttpClient,
  ReplyConfigResolverHttpClient,
} from './transport/api-publish-interaction-http.js';
// 本仓第一次有 content 方向的出边：概念池与精选库召回的属主都在内容进程，automation 独立起进程后
// 这两条只能经 HTTP 过去。服务端一侧在 content 仓，路由名两端共这一份定义。
import {
  ConceptPoolAuthorityHttpClient,
  CuratedSelectionAuthorityHttpClient,
} from './transport/content-authority-http.js';
import { PgAccountProjectionStore } from './transport/account-projection-store.js';
import { createAutomationSyncReadConsumerCheckpointStore } from './transport/automation-sync-read-checkpoint-store.js';
import { PgAutomationSyncReadGenerationStore } from './transport/automation-sync-read-generation-store.js';
import { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';
import {
  AutomationSyncReadSnapshotSource,
  type AutomationRuntimeSyncReadStream,
  type AutomationSyncReadRuntimeSources,
} from './transport/automation-sync-read-source.js';
import { OutboxConsumer } from './transport/event-outbox.js';
import { InternalHttpClient, InternalHttpServer } from './transport/internal-http.js';
import {
  registerEdgeResumeCommandRoutes,
  registerFacebookScopeCommandRoutes,
  registerPublishUiUpdateCommandRoutes,
} from './transport/paired-command-http.js';
import {
  createSyncReadChangedHttpRelay,
  SyncReadChangedOutbox,
} from './transport/sync-read-changed-outbox.js';
import { SyncReadChangedHttpClient } from './transport/sync-read-changed-http.js';
import {
  registerSyncReadSnapshotRoute,
  SyncReadSnapshotHttpClient,
} from './transport/sync-read-snapshot-http.js';

export const AUTOMATION_API_CLIENT_GROUPS = [
  'accountRoster',
  'accountOwnership',
  'accountRuntime',
  'automationPublishLog',
  'edgePublish',
  'interactionAuth',
  'interactionApiWrites',
  'replyConfig',
  'accountPersona',
  'environmentHandshake',
  'commentApprovalPolicy',
  'scheduleFeedback',
  'notificationContacts',
  'firstPostProgress',
  'automationConfigCommands',
  'offboardAdmissionLedger',
  'structuredNotification',
] as const;

/**
 * content 方向的客户端组。**刻意与 api 那 16 组分开列**，不是洁癖：
 * 上面那份是 `API_DIRECT_PORT_INVENTORY` 的对账面（派生 census 逐条比它），
 * 而这两条走的是另一个属主、另一套失败语义（返回裸值、失败抛具名 `ContentPortError`）。
 * 混进同一份清单会让那份对账当场对不上，且把两种失败约定搅成一种。
 */
export const AUTOMATION_CONTENT_CLIENT_GROUPS = [
  'conceptPool',
  'curatedSelection',
] as const;

export const AUTOMATION_COMMAND_RECEIVER_GROUPS = [
  'edgeResume',
  'facebookScope',
  'publishUiUpdate',
] as const;

export const AUTOMATION_ROOT_SURFACE = {
  apiClientGroups: 17,
  apiClientMethodSlots: 54,
  commandReceiverGroups: 3,
  commandReceiverMethodSlots: 4,
  totalGroups: 20,
  totalMethodSlots: 58,
} as const;

export type AutomationRootBlockerCategory =
  | '4b-mirror'
  | 'operator-command'
  | 'content-owner'
  | 'composition-root';

export interface AutomationRootReadinessBlocker {
  id: string;
  category: AutomationRootBlockerCategory;
  owner: 'api' | 'automation' | 'content' | 'shared-kernel';
  closingChange: 'split-cloud-api-composition-root-4b' | 'future';
}

/**
 * This is the automation-derived root ledger, not the Cloud monolith ledger.
 * It includes only dependencies that prevent this package from supplying the
 * complete production automation process — a narrowed subset of the monolith
 * ledger in `aidcp-cloud/boundaries/composition-root-independent-blockers.json`
 * (which is AST-derived and therefore self-extinguishing; this one is not).
 *
 * MUST stay in sync with `boundaries/composition-root-independent-blockers.json`
 * in this package. That file is a projection of this constant, written by
 * `test/acceptance/helpers/composition-root-4a-census.ts --refresh-ledger` and
 * pinned by `test/acceptance/automation-root-readiness-ledger.test.ts`. Editing
 * either one alone turns that test red — before this anchor existed the JSON had
 * silently drifted to a stale 20-entry snapshot that no code read.
 *
 * The 4b mirror entries (persona binding / environment gate / config freshness /
 * account identity / the four B5 config streams) are deliberately absent: they
 * are served here by the sync-read mirrors, so they no longer block this root.
 */
export const AUTOMATION_ROOT_READINESS_BLOCKERS =
  [
    // ═══ 2026-08-03：委托任务那两条一起撤（第九、第十条真靠接线消掉的） ═══
    //
    // 撤的是 `feishu-operator-natural-language-delegate` 与
    // `feishu-operator-delegated-card-actions`。**它们必须一起撤**：两条指向同一个 7+1 端口，
    // 注入那一个端口就同时点亮自由文本入口与卡片上那几个按钮，分开撤只会留下一条假的欠账。
    //
    // 判据仍是本常量文件头那一句（只列「阻止本包交付完整生产进程」的依赖），**两端都查过**：
    //
    //   · 本包这一半（automation `main()` 的 1i 段）：自己建委托任务存储（属主池）、建服务、
    //     建幂等台账、把接收方挂上 `registerDelegatedTaskRoutes`（7 方法）**与**
    //     `registerDelegatedTaskTextCommandRoutes`（自由文本）两条路由。
    //     结构断言在 `test/acceptance/automation-main.test.ts`，逐条变异实测都能红。
    //   · 对面那一半（`aidcp-api` 的手写入口）：两个客户端合成 7+1、`delegate` 真调它、
    //     `startIngress` 收到 `delegatedTasks`。**是去对面 `main()` 里读出来的**——
    //     客户端只吃基址与令牌，路由不在对面照样编译得过、两仓测试各自全绿，
    //     只有真跑两个进程才 404，而那个 404 会被读成「对面版本落后」。
    //
    // **两个目标校验钩子是这条撤条的实质内容，不是附赠品**：它们是「目标存不存在 /
    // 是不是待审 / 是不是这个账号的」三问的唯一执行点。省掉它们也能让路由通、也能让卡片发出来，
    // 但那是本 change 的红线形态（先假成功、等真去执行时才爆）。两个钩子都接了：
    // 候选稿那半走 api 属主 publishLog 的 `loadForDispatch`（本根早已有客户端，零新增），
    // 精选那半走**受鉴权**的 `CuratedTargetAuthorityHttpClient`——走裸那条会让跨进程后的
    // 缺表错误只剩一个普通传输错误，于是「精选库暂时不可用」被如实报成「目标不存在」。
    //
    // **另一件同批补上的前置**：委托解析按昵称选号，而账号显示名与别名候选此前
    // **没有任何跨进程读**（只活在 api 的账号存储里）。缺了不是「差一点」——每一条
    // 「给<昵称>…」都会回「可用昵称：无可用昵称」，响亮，但这条能力对运营等于不可用。
    // 本轮补了 4a 花名册组的第二个方法（账号目录），单体那份候选清单也同批改指它，
    // 两处共用同一份翻译（`src/delegated-task/account-candidates.ts`）。
    //
    // **探针这次自熄**：api 手写入口里那句 `automation_operator_command_unavailable:delegate`
    // 整句消失了（改成真调客户端），形态同调度启停那条 —— 不必先裁定「探针分不出
    // 『没有通道』与『没配置通道』」。剩下的 `:publish` / `:comment` 两句属另一条已撤的条目
    // （1.7b：api 模式下这两条能力真正的失败走委托通道），它们所在的闭包在 api 模式下不可达。
    //
    // **仍然诚实地记下没做到的**：飞书 `/delegate` 那条链**一次都没真跑过**（要真发一条飞书
    // 消息才触发），已按 5.5 登记 backlog 簇 60。交付的是「两端都真接上且结构上钉住」，
    // 不声称「运营发一条消息就能跑通」。
    //
    // 本文件是 Cloud 普查的**永久手写分叉、拿不到任何机械信号**，所以理由写在原地；
    // 对面把那两个客户端撤了，本仓这边没有任何东西会告诉你。
    // `feishu-operator-publish-comment` retired by adjudication (user, 2026-07-30; change
    // split-cloud-automation-production-runtime task 1.7b). Its two probes on the Cloud side aimed
    // at the `mode === 'api'` arms of the command face's publish:/comment: closures, and those
    // closures are unreachable: CommandRouter calls them only when `actions.delegate` is falsy,
    // while `CommandFaceDeps.delegate` is `NonNullable<...>` and the composition root always injects
    // a function (a missing service throws from inside it, it is never absent); the panel action
    // surface has no publish/comment at all. In api mode both capabilities fail through the delegate
    // channel, already tracked by `feishu-operator-natural-language-delegate` — so keeping this entry
    // double-counted one gap. The kernel contracts stay (see their docblocks); only the ledger entry
    // is gone. **This file is a permanent hand-written fork of the Cloud census and receives no
    // mechanical signal from it, so the reason is restated here on purpose — do not assume the Cloud
    // side's comment will reach you.** If those closures ever become reachable, re-adjudicate.
    // ═══ 2026-08-04：`feishu-operator-dispatch-start-stop` 撤条（第六条真靠接线消掉的） ═══
    //
    // 判据仍是本常量文件头那一句（只列「阻止本包交付完整生产进程」的依赖），且**两端都查过**：
    //   · 本包这一半：`main()` 自己注册那条路由，真翻转时真启停各连接、`changed` 是观测值、
    //     在线数取实测（automation `2f5f6a9`，结构断言在 `test/acceptance/automation-main.test.ts`）；
    //   · 对面那一半：`aidcp-api` 的手写入口本轮建了那个客户端并把读写两条一起接上
    //     （api `3159e10`），此前它对这条通道一律 `throw automation_operator_command_unavailable:dispatch`。
    //     **是去对面 `main()` 里读出来的，不是「客户端建得出来就算」**——客户端只吃基址与令牌，
    //     路由不在对面照样编译得过、两仓测试各自全绿，只有真跑两个进程才 404。
    //
    // **一件必须一起知道的事**：接口进程**按设计不起面板监听**
    // （`aidcp-api/src/server.ts` 的 `API_SYNC_READ_PUBLIC_SURFACE_LEDGER`：那些 DTO 面仍归
    // cloud-panel），所以三进程形态下运营还点不到那个按钮。但那是**面板整体还没搬**，
    // 对每一个面板面都成立，不是调度启停这条通道特有的欠账，也不阻止本包交付完整生产进程。
    // 飞书那一侧本来就没有 dispatch 动作（task 1.4），故无第二个缺口。
    //
    // 本文件是 Cloud 普查的**永久手写分叉、拿不到任何机械信号**，所以理由写在原地；
    // 对面把那个客户端撤了，本仓这边没有任何东西会告诉你。
    // 0.3f：`content-draft-refinement-authority` 在此**刻意缺席**。cloud 单体里草稿精修的
    // 工作器坐在 segC 的 `seamMode !== 'automation' && …` 守卫内 —— automation 进程按守卫跳过，
    // api / content 进程根本不跑 segC，因此没有任何独立起根会执行它，本包也不需要它才能交付
    // 完整生产进程。它在 cloud 单体台账里仍然在（segA 的 store 构造与 segD 的读取都还在），
    // 只是那条 segC 证据行消失了；两份台账的差就是这个「谁的欠账」之差，不是漏记。
    // ═══ 2026-08-04：一次撤五条（change split-cloud-automation-production-runtime 第 4 段起手） ═══
    //
    // 判据就是本常量文件头那一句：**只列「阻止本包交付完整生产进程」的依赖**。判例是 4b 那组
    // ——它们「served here by the sync-read mirrors, so they no longer block this root」。
    // 下面六条现在同样 served，逐条的证据是**两端都查过**，不是「接了个客户端就算」：
    //
    //   · `content-concept-write-authority`      —— main() 喂 `conceptStore`，content 进程注册 concept-pool 路由；
    //   · `content-curated-write-authority`      —— main() 喂 `curatedStore`，content 注册 curated-write 路由；
    //   · `content-facebook-publish-media-authority` —— main() 以 `media: {state:'wired'}` 喂下发器，content 注册该组路由；
    //   · `content-token-usage-authority`        —— 属主早已有 `recordUsage`，content 注册路由，
    //                                               automation 侧本轮补了合并缓冲并挂上模型出口的 onCall；
    //   · `content-reply-generation-authority`   —— content 本轮把属主实例也建了并注册路由，互动能力喂的是它的客户端；
    // 五条全属「真靠接线消掉」，不是记错属主、也不是重复计数。
    //
    // ⚠️ **本轮差点多撤一条，记下来免得下次再判错**：起初把 `content-generic-llm-authority`
    //    也算进来了，理由是「本包的文本模型客户端取自共享包 `aidcp-transport/llm/qwen.js`、
    //    不再碰 content」。**那是判错了**：这条锚的不是模型客户端，是**内容生成链**
    //    （`PublishGenerationHttpClient`），而本根至今没有构造它、也有一条断言明令禁止伪装
    //    （`test/transport/publish-generation-http.test.ts`）。
    //    是**编译器**当场点名的（那条断言按字面量比 id，撤条后联合类型里没有它了）——
    //    也就是说，这条判错**并不是靠读文档发现的**。⇒ 撤条前先 grep 一遍 id 的**全部引用**，
    //    别只看名字像什么。
    //
    // ⚠️ **两件必须一起知道的事**：
    //   ① **cloud 那把尺不会跟着降**（它是 AST 派生、问的是「自动化段还碰不碰 content 符号」，
    //      单体里那些调用点仍在）。两把尺**合法分叉**，MUST NOT 为了「凑齐」去手改 cloud 那份。
    //   ② **本文件是 Cloud 普查的永久手写分叉、拿不到任何机械信号**，所以理由写在原地。
    //      这六条的「服务端真的注册了」这一半，**只有 content 仓那条只许下降的清单闸看着**
    //      （`aidcp-content/test/acceptance/content-authority-routes.test.ts`）——
    //      本仓这边没有任何东西会告诉你对面把路由撤了。要复核就去读那份清单。
    //
    // **当时没跟着撤的那一条（文字卡转写）已于同日撤掉**，理由见下面那段。

    // `content-role-factories` retired 2026-07-31 as RESOLVED — **not** mis-attributed, and not
    // double-counted. It was the first entry here removed because wiring actually closed it:
    // task 0.7 re-adjudicated the four content role classes (plus their base and the curated gate)
    // to automation — all six files now live in this package's `src/` — and task 2.4b moved the
    // two-hop narrowing anchor from the content-owned store class to the kernel curated write port,
    // which was that table's last content-owned symbol. What remains is composition-root work, and
    // every composition root is hand-written per repo.
    //
    // **This file is a permanent hand-written fork of the Cloud census and gets no mechanical signal
    // from it, so the reason is restated here on purpose.** On the Cloud side the retirement is
    // anchored by a runnable check (`contentOwnedSymbolsInRoleFactoryTable`); **nothing here will
    // tell you if that goes red** — this ledger has no source anchor at all.

    // ═══ 2026-08-03：`content-generic-llm-authority` 撤条（第十一条真靠接线消掉的）═══
    //
    // **content-owner 这一类到此归零。** 它锚的不是模型客户端、是**内容生成链**
    //（见上面 08-04 那段「差点多撤一条」的更正），判据因此是「本根真把它构造出来并喂进了消费点，
    // 且对面真的在服务那条路由」。两端都查过：
    //
    //   · 对面那一半：内容进程的手写入口**无条件注册**
    //     `registerPublishGenerationRoutes(httpServer, publishOrchestrator)` —— 去它的 `main()` 里读的。
    //   · 本包这一半（`main()` 的 15b / 15c 两段）：建 `PublishGenerationHttpClient`
    //     （超时取 180s 硬顶，**必须 > 分段 long-poll 的 150s 预算**，否则每段 poll 都被提前切断
    //     ⇒ 每次跨进程生成在默认 15s 确定性失败），喂给 `PublishScheduler`；
    //     scheduler 再喂给**委托任务执行器**，那是它在本进程里唯一可达的消费方。
    //
    // ⚠️ **「建好零消费方」在这条上差点发生，记下来**：只加客户端 + 建 scheduler 的那一版
    //    被 typecheck 当场以「声明了没人读」拦下 —— 因为本进程当时没有任何东西能触发发帖。
    //    另外两个候选都不可用：**排期 tick（`ContentScheduler`）属 api**、本仓没有这个类
    //    （而 api 的手写入口也没建它 ⇒ 三进程下今天没有任何进程在跑排期发帖，那是另一笔账）；
    //    手动发布那条运营指令路由**刻意不接**（1.7b 裁定）。⇒ 委托执行器是唯一的路，先建它。
    //
    // **同批补上的现网缺口**：此前委托任务在本进程里「能建、能确认、永远不跑」，
    // 且**连单体那句具名警告都没有**。现在缺席具名（发帖触发器缺席 / 按配置禁用各一句），
    // 泵起在业务入口放行之后（构造期起等于让未放行的进程去认领任务，而认领带租约）。
    //
    // **授权决定写经 api 属主那条口**（本进程没有、也不该有授权表连接），路由接口进程已注册，
    // 令牌用授权专用那把 —— 本批前一手刚修过一处拿错令牌的接线错，别再退回去。
    //
    // 本文件是 Cloud 普查的**永久手写分叉、拿不到任何机械信号**，所以理由写在原地。

    // ═══ 2026-08-04：`content-textcard-transcription-authority` 撤条（第七条真靠接线消掉的）═══
    //
    // 它是 08-04 那批**唯一没跟着撤的一条**，理由是「对面没有在服务它」——
    // 本包这一半早就齐了（`main()` 建 `TextCardTranscriptionAuthorityHttpClient`，
    // 连「旗标开没开」的本地取值闭包都配了，并按 `{state:'wired'}` 喂给角色工厂），
    // 缺的是 content 进程从没构造转写器实例。**那一半今天补上了**（content `e924e2a`）：
    // 属主实例已建（判形档另起一个 sensor、视觉模型另起一档，逐条照单体），路由**无条件注册**，
    // content 那条只许下降的清单闸里它已从 pending 移出。
    //
    // **为什么「无条件注册」这一点对撤条是必要的**：旗标关时属主答「未启用」并回显自己那侧的
    // 取值供客户端对账 —— 那是答案。若把注册挂在旗标上，关旗标时客户端拿到的是跨进程 404、
    // 被译成「对面不支持这个方法」，那仍然是「拿得到客户端、拿不到能力」。
    // content 侧已为此配了顶层语句断言（清单闸只数调用次数，塞进 `if` 它照过 —— 实测过）。
    //
    // 复核方式同上面那六条：**本仓没有任何机械信号**，要复核就去读 content 那份清单闸。
    // `content-publish-rejection-evidence-authority` retired as MIS-ATTRIBUTED, not resolved
    // (change split-cloud-automation-production-runtime, task 2.9). Every link of its premise was
    // checked and each one is wrong: the predicate `hasUserRejectionEvidence` lives in
    // `kernel/publish-pipeline-types.ts` (kernel-owned, on the kernel roster) and is a two-line pure
    // field read — **and it is already IN this package via the pinned aidcp-kernel dependency**;
    // the data comes from the **api**-owned publishLog 4a port whose client this very root already
    // constructs (`new AutomationPublishLogHttpClient(...)`); and the field's only writer is
    // api-owned. Nothing in the chain touches content. The `content` label came from the import
    // specifier the binding's author happened to read: `src/publish-agent/types.ts` is a six-line
    // `export * from '../kernel/...'` left over from the git mv that moved the type closure into
    // kernel — a move that PREDATES the binding.
    //
    // **This file is a permanent hand-written fork of the Cloud census and gets no mechanical signal
    // from it, so the reason is restated here on purpose.** Also worth knowing: on the Cloud side the
    // `owner` field is hardcoded on the binding and copied through by the sweep without consulting
    // module-ownership.json — a wrong owner label survives every `--refresh-ledger`, so this class of
    // error can only ever be caught by reading.
    //
    // **What was NOT retired**: if anyone ever STUBS that predicate instead of importing it from
    // kernel, a rejected draft reads as "not rejected" and the delegated executor turns it into
    // `failed` instead of `cancelled`. That is a different failure needing its own entry.
    {
      id: 'automation-production-runtime-composition-unwired',
      category: 'composition-root',
      owner: 'automation',
      closingChange: 'future',
    },
  ] as const satisfies readonly AutomationRootReadinessBlocker[];

export interface AutomationRootConfig {
  executionTarget: DeploymentTarget;
  apiBaseUrl: string;
  apiInternalToken: string;
  automationInternalToken: string;
  /** 内容进程的内部 HTTP 基址。缺了就没有概念池、没有创作素材、没有搜索词样本——故必填、不给默认。 */
  contentBaseUrl: string;
  contentInternalToken: string;
  automationPort: number;
  offboardWorkerId: string;
  /**
   * 发布授权那一族的**独立令牌**（`AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN`）。
   *
   * **它与 `apiInternalToken` 是两个 env、没有互相回落**：接口进程给授权权威与授权决定写这两组路由
   * 挂的就是这一个，单体两侧也一直用它。拿通用的 api 令牌去调那两组 ⇒ 每一次调用都被判未授权，
   * 而这件事**编译得过、两仓测试各自全绿**，只有真把两个进程一起跑起来才现形
   * （现形方式还是「授权读不出来」这种最容易被读成业务原因的形态）。
   */
  publishApprovalInternalToken: string;
}

export interface AutomationRuntimeHandles {
  edgeResume: EdgeResumeCommandReceiverDeps;
  facebookScope: FacebookScopeCommandReceiverDeps;
  publishUiUpdate: PublishUiUpdateCommandReceiverDeps;
  syncReadSources: AutomationSyncReadRuntimeSources;
}

export interface AutomationApiClients {
  accountRoster: AccountRosterHttpClient;
  accountOwnership: AccountOwnershipHttpClient;
  accountRuntime: AccountRuntimeHttpClient;
  automationPublishLog: AutomationPublishLogHttpClient;
  edgePublish: EdgePublishCommandHttpClient;
  interactionAuth: InteractionAuthHttpClient;
  interactionApiWrites: InteractionApiWritesHttpClient;
  replyConfig: ReplyConfigResolverHttpClient;
  accountPersona: AccountPersonaHttpClient;
  environmentHandshake: EnvironmentHandshakeHttpClient;
  commentApprovalPolicy: CommentApprovalPolicyHttpClient;
  scheduleFeedback: ScheduleFeedbackHttpClient;
  notificationContacts: NotificationContactsHttpClient;
  firstPostProgress: FirstPostProgressHttpClient;
  automationConfigCommands: AutomationConfigCommandsHttpClient;
  offboardAdmissionLedger: OffboardAdmissionLedgerHttpClient;
  structuredNotification: StructuredNotificationHttpClient;
}

export interface AutomationContentClients {
  conceptPool: ConceptPoolAuthorityHttpClient;
  curatedSelection: CuratedSelectionAuthorityHttpClient;
}

export const AUTOMATION_SYNC_READ_CONSUMER_STREAMS = [
  'account_persona',
  'client_environment_automation',
  'automation_account_projection',
  'content_schedule',
  'hot_lead_config',
  'facebook_comment_config',
  'facebook_group_join_automation_config',
  // 批 E-2 步骤 2：Facebook 运营基线。**不补这一条，本进程就永远拿不到基线** ——
  // 而拿不到基线在下游就是 FB 账号永远不开始浏览。
  'facebook_operation_policy',
] as const;

export type AutomationSyncReadConsumerStream =
  (typeof AUTOMATION_SYNC_READ_CONSUMER_STREAMS)[number];

export const AUTOMATION_SYNC_READ_OWNER_STREAMS = [
  'session_config_global',
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const;

export type AutomationSyncReadOwnerStream =
  (typeof AUTOMATION_SYNC_READ_OWNER_STREAMS)[number];

export const AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER =
  'api-sync-read-changed-relay';

const AUTOMATION_SYNC_READ_REFRESH_MS = 30_000;

type AutomationConsumerMirror =
  | AutomationSyncReadMirrors['persona']
  | AutomationSyncReadMirrors['environment']
  | AutomationSyncReadMirrors['accounts']
  | AutomationSyncReadMirrors['contentSchedule']
  | AutomationSyncReadMirrors['hotLead']
  | AutomationSyncReadMirrors['facebookComment']
  | AutomationSyncReadMirrors['facebookGroupJoin']
  | AutomationSyncReadMirrors['facebookOperationPolicy'];

interface AutomationCheckpointStorePort {
  load(stream: SyncReadStream): Promise<
    | { outcome: 'loaded'; checkpoint: SyncReadConsumerCheckpoint }
    | { outcome: 'not_found'; checkpoint: null }
    | {
        outcome: 'unknown';
        checkpoint: null;
        reason: 'checkpoint_invalid';
        message: string;
      }
  >;
  save(input: unknown): Promise<
    | { outcome: 'stored'; checkpoint: SyncReadConsumerCheckpoint }
    | {
        outcome: 'rejected';
        reason:
          | 'checkpoint_invalid'
          | 'old_cursor'
          | 'historical_checkpoint'
          | 'same_cursor_payload_drift';
        currentCursor: string | null;
        message: string;
      }
  >;
}

interface AutomationAccountProjectionPort {
  init(): Promise<void>;
  applyOwnerSnapshot(
    input: unknown,
    observedAt?: number,
  ): Promise<SyncReadApplyResult>;
  stop(): void;
}

interface AutomationOwnerSnapshotSourcePort {
  snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt?: number,
  ): Promise<SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]>>;
  publishChanged(
    stream: AutomationRuntimeSyncReadStream,
    observedAt?: number,
  ): Promise<SyncReadSnapshotEnvelope>;
}

export interface AutomationSyncReadSignalRelayPort {
  start(): void;
  stop(): void;
  stats(): {
    running: boolean;
    topics: string[];
    lastError: string | null;
    blocked: ReadonlyArray<{
      topic: string;
      eventId: number;
      attempts: number;
      lastError: string;
    }>;
  };
}

export interface AutomationRootSyncReadOverrides {
  mirrors?: AutomationSyncReadMirrors;
  checkpointStore?: AutomationCheckpointStorePort;
  accountProjectionStore?: AutomationAccountProjectionPort;
  ownerSnapshotSource?: AutomationOwnerSnapshotSourcePort;
  signalRelay?: AutomationSyncReadSignalRelayPort;
  fetchOwnerSnapshot?: (
    stream: AutomationSyncReadConsumerStream,
  ) => Promise<SyncReadSnapshotEnvelope>;
  clock?: () => number;
  setTimer?: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Pick<Console, 'warn'>;
}

export interface AutomationSyncReadReadinessBlocker {
  stream: AutomationSyncReadConsumerStream | AutomationSyncReadOwnerStream;
  role: 'consumer' | 'owner-publisher';
  state: 'uninitialized' | 'stale' | 'invalid' | 'recovering';
  message: string | null;
}

export type AutomationSyncReadReadiness =
  | {
      state: 'ready';
      checkedAt: number;
      blockers: readonly [];
    }
  | {
      state: 'not_ready';
      checkedAt: number;
      blockers: readonly AutomationSyncReadReadinessBlocker[];
    };

export interface AutomationRootSyncReadHandles {
  mirrors: AutomationSyncReadMirrors;
  ownerSnapshotSource: AutomationOwnerSnapshotSourcePort;
  accountProjectionStore: AutomationAccountProjectionPort;
  signalRelay: AutomationSyncReadSignalRelayPort;
  refresh(): Promise<void>;
  publishChanged(
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<SyncReadSnapshotEnvelope>;
  readiness(now?: number): AutomationSyncReadReadiness;
}

export interface AutomationCompositionRoot {
  ownerPool: pg.Pool;
  apiClients: AutomationApiClients;
  contentClients: AutomationContentClients;
  structuredDeliver: StructuredNotificationHttpClient;
  commandReceivers: {
    edgeResume: EdgeResumeCommandReceiver;
    facebookScope: FacebookScopeCommandReceiver;
    publishUiUpdate: PublishUiUpdateCommandReceiver;
  };
  offboardReconciler: AutomationOffboardAdmissionReconciler;
  syncRead: AutomationRootSyncReadHandles;
  internalServer: InternalHttpServer;
  listen(port?: number): Promise<number>;
  start(port?: number): Promise<number>;
  close(): Promise<void>;
}

export class AutomationRootNotReadyError extends Error {
  readonly code = 'automation_independent_root_not_ready';

  constructor(readonly blockers: readonly AutomationRootReadinessBlocker[]) {
    super(
      `automation independent root remains blocked: ${blockers
        .map((blocker) => blocker.id)
        .join(', ')}`,
    );
    this.name = 'AutomationRootNotReadyError';
  }
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name:
    | 'AIDCP_API_URL'
    | 'AIDCP_API_INTERNAL_TOKEN'
    | 'AIDCP_AUTOMATION_INTERNAL_TOKEN'
    | 'AIDCP_CONTENT_URL'
    | 'AIDCP_CONTENT_INTERNAL_TOKEN'
    | 'AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN',
): string {
  const value = env[name]?.trim();
  if (!value || /\s/.test(value)) {
    throw new Error(`${name} is required and must not contain whitespace`);
  }
  return value;
}

function optionalPort(env: NodeJS.ProcessEnv): number {
  const raw = env.AIDCP_AUTOMATION_PORT?.trim();
  if (!raw) return 8093;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('AIDCP_AUTOMATION_PORT must be an integer from 1 to 65535');
  }
  return value;
}

export function readAutomationRootConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomationRootConfig {
  if (env.AIDCP_SERVICE !== 'automation') {
    throw new Error('aidcp-automation requires AIDCP_SERVICE=automation');
  }
  const executionTarget = parseDeploymentTarget(env.AIDCP_DEPLOY_ENV);
  if (!executionTarget) {
    throw new Error('AIDCP_DEPLOY_ENV must be dev or ol');
  }
  return {
    executionTarget,
    apiBaseUrl: requiredEnv(env, 'AIDCP_API_URL'),
    apiInternalToken: requiredEnv(env, 'AIDCP_API_INTERNAL_TOKEN'),
    automationInternalToken: requiredEnv(env, 'AIDCP_AUTOMATION_INTERNAL_TOKEN'),
    // content 出边与 api 出边同档必填：没配 = 概念池读不到、精选素材问不到。
    // 让它可缺省的代价很具体——客户端建不出来，调用点要么写成 `?.` 吞成一个空数组，
    // 要么第一次用到才炸；前者会把「这条缝断了」画成「库里没素材」，正是本 change 要消掉的那类假成功。
    contentBaseUrl: requiredEnv(env, 'AIDCP_CONTENT_URL'),
    contentInternalToken: requiredEnv(env, 'AIDCP_CONTENT_INTERNAL_TOKEN'),
    automationPort: optionalPort(env),
    offboardWorkerId: `offboard-reconcile-${executionTarget}`,
    // 与上面那两个令牌同档必填、**且不许拿 apiInternalToken 顶替**（两侧是同一个 env 才对得上）。
    publishApprovalInternalToken: requiredEnv(env, 'AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN'),
  };
}

export function createAutomationApiClients(
  config: Pick<AutomationRootConfig, 'apiBaseUrl' | 'apiInternalToken' | 'executionTarget'>,
): AutomationApiClients {
  const http = new InternalHttpClient(config.apiBaseUrl);
  const args = [http, config.apiInternalToken, config.executionTarget] as const;
  return {
    accountRoster: new AccountRosterHttpClient(...args),
    accountOwnership: new AccountOwnershipHttpClient(...args),
    accountRuntime: new AccountRuntimeHttpClient(...args),
    automationPublishLog: new AutomationPublishLogHttpClient(...args),
    edgePublish: new EdgePublishCommandHttpClient(...args),
    interactionAuth: new InteractionAuthHttpClient(...args),
    interactionApiWrites: new InteractionApiWritesHttpClient(...args),
    replyConfig: new ReplyConfigResolverHttpClient(...args),
    accountPersona: new AccountPersonaHttpClient(...args),
    environmentHandshake: new EnvironmentHandshakeHttpClient(...args),
    commentApprovalPolicy: new CommentApprovalPolicyHttpClient(...args),
    // 批 H：排期名额回程（自动化侧只报告事实，小时格账本归排期器自己）。
    scheduleFeedback: new ScheduleFeedbackHttpClient(...args),
    notificationContacts: new NotificationContactsHttpClient(...args),
    firstPostProgress: new FirstPostProgressHttpClient(...args),
    automationConfigCommands: new AutomationConfigCommandsHttpClient(...args),
    offboardAdmissionLedger: new OffboardAdmissionLedgerHttpClient(...args),
    structuredNotification: new StructuredNotificationHttpClient(...args),
  };
}

/**
 * content 方向的客户端组，形态照抄上面那个 api 组：一条基址一个内部令牌 + 本进程的部署 target，
 * 三样一次绑好交给每个客户端。**target 由这里注入、不由业务调用方给**——DEV/OL 长期共库，
 * 让调用方挑 target 等于把「在哪台机器上真读」变成一个请求体字段。
 */
export function createAutomationContentClients(
  config: Pick<
    AutomationRootConfig,
    'contentBaseUrl' | 'contentInternalToken' | 'executionTarget'
  >,
): AutomationContentClients {
  const http = new InternalHttpClient(config.contentBaseUrl);
  const args = [http, config.contentInternalToken, config.executionTarget] as const;
  return {
    conceptPool: new ConceptPoolAuthorityHttpClient(...args),
    curatedSelection: new CuratedSelectionAuthorityHttpClient(...args),
  };
}

export function createAutomationCompositionRoot(options: {
  config: AutomationRootConfig;
  runtime: AutomationRuntimeHandles;
  ownerPool?: pg.Pool;
  syncRead?: AutomationRootSyncReadOverrides;
}): AutomationCompositionRoot {
  const ownsPool = !options.ownerPool;
  const ownerPool = options.ownerPool ?? new pg.Pool(resolveOwnerPgConfig('automation'));
  const apiClients = createAutomationApiClients(options.config);
  const contentClients = createAutomationContentClients(options.config);
  const clock = options.syncRead?.clock ?? Date.now;
  const logger = options.syncRead?.logger ?? console;
  const setTimer =
    options.syncRead?.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.syncRead?.clearTimer ??
    ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const mirrors =
    options.syncRead?.mirrors ??
    new AutomationSyncReadMirrors(options.config.executionTarget, clock);
  const checkpointStore =
    options.syncRead?.checkpointStore ??
    createAutomationSyncReadConsumerCheckpointStore(
      ownerPool,
      options.config.executionTarget,
    );
  const accountProjectionStore =
    options.syncRead?.accountProjectionStore ??
    new PgAccountProjectionStore({
      pool: ownerPool,
      source: {
        listAccountIdentities: async () => {
          throw new Error(
            'independent_automation_legacy_account_projection_refresh_disabled',
          );
        },
      },
      executionTarget: options.config.executionTarget,
      logger: {
        log: () => undefined,
        warn: (message) => logger.warn(message),
        error: (message) => logger.warn(message),
      },
    });
  const ownerSnapshotSource =
    options.syncRead?.ownerSnapshotSource ??
    new AutomationSyncReadSnapshotSource(
      options.config.executionTarget,
      options.runtime.syncReadSources,
      new PgAutomationSyncReadGenerationStore(
        options.config.executionTarget,
        ownerPool,
      ),
      new SyncReadChangedOutbox(
        options.config.executionTarget,
        ownerPool,
        logger,
      ),
    );
  const syncReadApiHttp = new InternalHttpClient(options.config.apiBaseUrl);
  const snapshotClient = new SyncReadSnapshotHttpClient(
    syncReadApiHttp,
    {
      executionTarget: options.config.executionTarget,
      bearerToken: options.config.apiInternalToken,
    },
  );
  const fetchOwnerSnapshot =
    options.syncRead?.fetchOwnerSnapshot ??
    ((stream: AutomationSyncReadConsumerStream) =>
      snapshotClient.fetch(
        stream,
        (value): value is SyncReadPayloadByStream[typeof stream] =>
          isSyncReadFactPayload(stream, value),
      ));
  const signalRelay =
    options.syncRead?.signalRelay ??
    new OutboxConsumer({
      consumer: AUTOMATION_SYNC_READ_SIGNAL_RELAY_CONSUMER,
      executionTarget: options.config.executionTarget,
      pool: ownerPool,
      handlers: new Map([
        [
          SYNC_READ_CHANGED_TOPIC,
          createSyncReadChangedHttpRelay({
            executionTarget: options.config.executionTarget,
            delivery: new SyncReadChangedHttpClient(syncReadApiHttp, {
              executionTarget: options.config.executionTarget,
              bearerToken: options.config.apiInternalToken,
            }),
          }),
        ],
      ]),
      logger: {
        log: () => undefined,
        warn: (message) => logger.warn(message),
      },
      setTimer,
      clearTimer,
      now: clock,
    });
  const commandReceivers = {
    edgeResume: new EdgeResumeCommandReceiver(options.runtime.edgeResume),
    facebookScope: new FacebookScopeCommandReceiver(options.runtime.facebookScope),
    publishUiUpdate: new PublishUiUpdateCommandReceiver(options.runtime.publishUiUpdate),
  };
  const internalServer = new InternalHttpServer();
  registerEdgeResumeCommandRoutes(
    internalServer,
    commandReceivers.edgeResume,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerFacebookScopeCommandRoutes(
    internalServer,
    commandReceivers.facebookScope,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerPublishUiUpdateCommandRoutes(
    internalServer,
    commandReceivers.publishUiUpdate,
    options.config.automationInternalToken,
    options.config.executionTarget,
  );
  registerSyncReadSnapshotRoute(
    internalServer,
    {
      snapshotFor: ({ stream, executionTarget }) => {
        if (executionTarget !== options.config.executionTarget) {
          throw new Error('automation_sync_read_snapshot_target_mismatch');
        }
        return ownerSnapshotSource.snapshot(stream, clock());
      },
    },
    {
      owner: 'automation',
      executionTarget: options.config.executionTarget,
      bearerToken: options.config.automationInternalToken,
      streams: AUTOMATION_SYNC_READ_OWNER_STREAMS,
    },
  );

  const offboardReconciler = new AutomationOffboardAdmissionReconciler({
    automationRead: new PgClientEnvAutomationRead({ pool: ownerPool }),
    materializationOps: new PgOffboardMaterializationOps({ pool: ownerPool }),
    admissionLedger: apiClients.offboardAdmissionLedger,
    workerId: options.config.offboardWorkerId,
  });

  const ownerReadiness = new Map<
    AutomationSyncReadOwnerStream,
    {
      state: 'uninitialized' | 'ready' | 'invalid';
      message: string | null;
    }
  >(
    AUTOMATION_SYNC_READ_OWNER_STREAMS.map((stream) => [
      stream,
      { state: 'uninitialized', message: null },
    ]),
  );
  let checkpointsRestored = false;
  let projectionInitialized = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshRunning: Promise<void> = Promise.resolve();
  let syncReadStarted = false;
  let closed = false;

  const setOwnerReadiness = (
    stream: AutomationSyncReadOwnerStream,
    state: 'ready' | 'invalid',
    message: string | null,
  ): void => {
    ownerReadiness.set(stream, { state, message });
  };

  const publishChanged = async (
    stream: AutomationRuntimeSyncReadStream,
  ): Promise<SyncReadSnapshotEnvelope> => {
    try {
      const envelope = validateSnapshotEnvelope(
        options.config.executionTarget,
        stream,
        await ownerSnapshotSource.publishChanged(stream, clock()),
      );
      setOwnerReadiness(stream, 'ready', null);
      return envelope;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOwnerReadiness(stream, 'invalid', message);
      throw error;
    }
  };

  const ensureProjectionInitialized = async (): Promise<void> => {
    if (projectionInitialized) return;
    try {
      await accountProjectionStore.init();
      projectionInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consumerMirror(mirrors, 'automation_account_projection').beginRecovery(
        message,
      );
      logger.warn(
        `[automation-sync-read] B4 projection init failed; readiness remains blocked: ${message}`,
      );
    }
  };

  const restoreCheckpoints = async (): Promise<void> => {
    if (checkpointsRestored) return;
    await Promise.all(
      AUTOMATION_SYNC_READ_CONSUMER_STREAMS.map(async (stream) => {
        const mirror = consumerMirror(mirrors, stream);
        try {
          const loaded = await checkpointStore.load(stream);
          if (loaded.outcome === 'loaded') {
            mirror.restoreCheckpoint(loaded.checkpoint);
          } else if (loaded.outcome === 'unknown') {
            mirror.beginRecovery(loaded.message);
          }
        } catch (error) {
          mirror.beginRecovery(
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
    checkpointsRestored = true;
  };

  const refreshOwnerStream = async (
    stream: AutomationSyncReadOwnerStream,
  ): Promise<void> => {
    try {
      if (stream === 'session_config_global') {
        validateSnapshotEnvelope(
          options.config.executionTarget,
          stream,
          await ownerSnapshotSource.snapshot(stream, clock()),
        );
        setOwnerReadiness(stream, 'ready', null);
        return;
      }
      await publishChanged(stream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOwnerReadiness(stream, 'invalid', message);
      logger.warn(
        `[automation-sync-read] owner observation failed stream=${stream}: ${message}`,
      );
    }
  };

  const refreshConsumerStream = async (
    stream: AutomationSyncReadConsumerStream,
  ): Promise<void> => {
    const mirror = consumerMirror(mirrors, stream);
    try {
      if (stream === 'automation_account_projection') {
        await ensureProjectionInitialized();
        if (!projectionInitialized) {
          throw new Error('automation_account_projection_not_initialized');
        }
      }
      const envelope = validateSnapshotEnvelope(
        options.config.executionTarget,
        stream,
        await fetchOwnerSnapshot(stream),
      );
      if (stream === 'automation_account_projection') {
        const projected = await accountProjectionStore.applyOwnerSnapshot(
          envelope,
          clock(),
        );
        assertSyncReadApplied(stream, projected);
      }
      const applied = mirrors.apply(envelope, 'owner_fetch');
      assertSyncReadApplied(stream, applied);
      if (mirror.view(clock()).state !== 'ready') {
        throw new Error(`sync_read_owner_fetch_did_not_make_ready:${stream}`);
      }
      if (stream !== 'automation_account_projection') {
        const stored = await checkpointStore.save(mirror.checkpoint(clock()));
        if (stored.outcome === 'rejected') {
          throw new Error(
            `sync_read_checkpoint_rejected:${stream}:${stored.reason}:${stored.message}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.beginRecovery(message);
      logger.warn(
        `[automation-sync-read] consumer refresh failed stream=${stream}: ${message}`,
      );
    }
  };

  const refreshCycle = async (): Promise<void> => {
    await Promise.all([ensureProjectionInitialized(), restoreCheckpoints()]);
    await Promise.all([
      ...AUTOMATION_SYNC_READ_OWNER_STREAMS.map(refreshOwnerStream),
      ...AUTOMATION_SYNC_READ_CONSUMER_STREAMS.map(refreshConsumerStream),
    ]);
  };

  const refresh = (): Promise<void> => {
    const next = refreshRunning.then(refreshCycle, refreshCycle);
    refreshRunning = next.catch(() => undefined);
    return next;
  };

  const scheduleRefresh = (): void => {
    if (!syncReadStarted || closed || refreshTimer !== null) return;
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      void refresh().finally(scheduleRefresh);
    }, AUTOMATION_SYNC_READ_REFRESH_MS);
  };

  const readiness = (now = clock()): AutomationSyncReadReadiness => {
    const mirrorReadiness = mirrors.readiness(now);
    const consumerBlockers: AutomationSyncReadReadinessBlocker[] =
      mirrorReadiness.state === 'not_ready'
        ? mirrorReadiness.blockers.map((blocker) => ({
            stream: blocker.stream as AutomationSyncReadConsumerStream,
            role: 'consumer',
            state: blocker.state,
            message: blocker.lastError,
          }))
        : [];
    const ownerBlockers = AUTOMATION_SYNC_READ_OWNER_STREAMS.flatMap(
      (stream): AutomationSyncReadReadinessBlocker[] => {
        const state = ownerReadiness.get(stream)!;
        return state.state === 'ready'
          ? []
          : [
              {
                stream,
                role: 'owner-publisher',
                state: state.state,
                message: state.message,
              },
            ];
      },
    );
    const blockers = [...consumerBlockers, ...ownerBlockers];
    return blockers.length === 0
      ? { state: 'ready', checkedAt: now, blockers: [] }
      : { state: 'not_ready', checkedAt: now, blockers };
  };

  const syncRead: AutomationRootSyncReadHandles = {
    mirrors,
    ownerSnapshotSource,
    accountProjectionStore,
    signalRelay,
    refresh,
    publishChanged,
    readiness,
  };

  return {
    ownerPool,
    apiClients,
    contentClients,
    structuredDeliver: apiClients.structuredNotification,
    commandReceivers,
    offboardReconciler,
    syncRead,
    internalServer,
    listen: (port = options.config.automationPort) => internalServer.listen(port),
    async start(port = options.config.automationPort) {
      const listeningPort =
        internalServer.address()?.port ?? await internalServer.listen(port);
      await refresh();
      signalRelay.start();
      syncReadStarted = true;
      scheduleRefresh();
      return listeningPort;
    },
    async close() {
      closed = true;
      syncReadStarted = false;
      signalRelay.stop();
      if (refreshTimer !== null) {
        clearTimer(refreshTimer);
        refreshTimer = null;
      }
      accountProjectionStore.stop();
      await refreshRunning;
      try {
        await internalServer.close();
      } finally {
        if (ownsPool) await ownerPool.end();
      }
    },
  };
}

function consumerMirror(
  mirrors: AutomationSyncReadMirrors,
  stream: AutomationSyncReadConsumerStream,
): AutomationConsumerMirror {
  switch (stream) {
    case 'account_persona':
      return mirrors.persona;
    case 'client_environment_automation':
      return mirrors.environment;
    case 'automation_account_projection':
      return mirrors.accounts;
    case 'content_schedule':
      return mirrors.contentSchedule;
    case 'hot_lead_config':
      return mirrors.hotLead;
    case 'facebook_comment_config':
      return mirrors.facebookComment;
    case 'facebook_group_join_automation_config':
      return mirrors.facebookGroupJoin;
    case 'facebook_operation_policy':
      return mirrors.facebookOperationPolicy;
  }
}

function assertSyncReadApplied(
  stream: SyncReadStream,
  result: SyncReadApplyResult,
): asserts result is Exclude<SyncReadApplyResult, { outcome: 'rejected' }> {
  if (result.outcome === 'rejected') {
    throw new Error(
      `sync_read_apply_rejected:${stream}:${result.reason}:${result.message}`,
    );
  }
}

function validateSnapshotEnvelope<S extends SyncReadStream>(
  executionTarget: DeploymentTarget,
  stream: S,
  input: unknown,
): SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]> {
  return parseSyncReadSnapshotEnvelope(input, {
    executionTarget,
    stream,
    factScope: SYNC_READ_STREAM_DEFINITIONS[stream].factScope,
    validateValue: (value): value is SyncReadPayloadByStream[S] =>
      isSyncReadFactPayload(stream, value),
  });
}

/**
 * The executable entry is deliberately fail-closed until the derived ledger is
 * empty. The bounded 4a/4b composition factory above remains loadable and
 * directly testable without pretending the future production runtime is wired.
 */
export async function runAutomationEntry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  readAutomationRootConfig(env);
  throw new AutomationRootNotReadyError(AUTOMATION_ROOT_READINESS_BLOCKERS);
}

export function isDirectExecution(metaUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && pathToFileURL(argv1).href === metaUrl;
}
