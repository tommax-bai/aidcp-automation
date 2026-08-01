/**
 * 判据清单 · cloud 单体自动化段的 41 个导出面，逐条判「本进程有没有去处」（task 3.5，批 A）。
 *
 * ## 它回答的问题
 *
 * `segCAutomation` 在段尾把 41 个句柄赋给共享上下文。搬进本包写 `main()` 时，
 * **最容易犯的错不是漏搬，是顺手全搬**：把只有接口服务段读的对象也在自动化进程里 `new` 一遍，
 * 于是那个对象在本进程里没有任何消费者、却照样占着连接与定时器，而且**没有任何机械手段看得见**
 * —— 它构造成功、日志无异常，只是永远没人读它算出来的东西。
 *
 * 判据是 **「结果有没有去处」，不是「去处在不在本进程」**。这两者不等价，且已经出过反例：
 * 接口进程为了答内容进程的密钥读，构造了四个自己没有消费者的读取器 —— 那是对的。
 * 所以本清单把「本进程内有消费者」与「本进程构造只为答别的进程」拆成两个字段，
 * 后者 MUST 显式声明（{@link AutomationSegCExportDisposition.servesOtherProcess}），
 * 不给「反正别人要用」这种事后解释留口子。
 *
 * ## 这份清单能证明什么、不能证明什么
 *
 * **能**：本文件内部自洽 —— 每条的裁定与它自己登记的消费方证据不矛盾（见同名验收用例的四条不变量）。
 * 具体拦得住三类真错：判 `construct` 却本进程无去处也没声明服务别人；判 `skip` 却本进程明明有消费者；
 * 把「构造只为答别的进程」当默认而不是当声明。
 *
 * **不能**：它证明不了 `consumers` 那几个字段抄得对。证据是 2026-08-01 对
 * `aidcp-cloud@f489e5e` 的 `src/server.ts` 逐条实读得到的，**本包里没有那个文件，也就没有任何东西
 * 会告诉你它过期了**。段落一改、句柄一增一减，这里静静地就不对了。
 *
 * 唯一的机械信号放在**它该在的那一侧**：`aidcp-cloud` 的
 * `test/acceptance/segc-export-face.test.ts` 从 `src/server.ts` 现场解析自动化段的导出面，
 * 与一份钉死的名单比对，改了当场红，并在失败信息里点名要来同步本文件。
 * 那条用例故意留在 cloud —— 它按路径读组装根，派生同步会把这类测试判为「不可派生」而留守，
 * 想搬也搬不过来（也不该搬：本包没有那个源文件）。
 *
 * ## 重新派生的办法
 *
 * ```
 * cd ../aidcp-cloud && npx tsx test/acceptance/helpers/segc-export-face.ts
 * ```
 *
 * 它打印当前自动化段的导出面全集。差异逐条对回本文件，**MUST NOT 直接改名单了事**：
 * 名单变了意味着有人动了自动化段的边界，那条句柄的去处要重判一次。
 */

/** 本进程（自动化进程）里真正会跑到的消费方。 */
export type AutomationSegCConsumer =
  /** 自动化段自身：搬进本包 `main()` 之后就是本进程的运行时。 */
  | 'automation-runtime'
  /** 自动化进程的内部 HTTP 面（cloud 单体里的 `startAutomationInternalApi`）。 */
  | 'automation-internal-api'
  /** 自动化属主的同步读快照源（cloud 单体里的 `createAutomationSyncReadSource`）。 */
  | 'automation-sync-read-source';

/** 其它段的读者。这些段**不在自动化进程里跑**，所以它们的读不构成「本进程有去处」。 */
export type AutomationSegCForeignReader =
  /** 基础段：每个进程都跑，但它对这些句柄的读一律在只有接口进程才触发的闭包里（逐条见 reason）。 */
  | 'api-foundation'
  /** 内容段。 */
  | 'content'
  /** 接口服务段：面板 / 客户端 API 的装配处。 */
  | 'api-serving';

/**
 * 预排批次，对应 `HANDOFF.md` §9.1 的 B…H。
 *
 * **这是排期，不是契约**：真搬的时候按段落横幅走，落在哪一批以实际搬运为准。
 * 批 A 不出现在这里 —— 批 A 只立尺子，不搬业务代码。
 */
export type AutomationSegCBatch = 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export interface AutomationSegCExportDisposition {
  /** cloud 单体自动化段段尾赋给共享上下文的字段名。 */
  handle: string;
  /**
   * 自动化进程要不要构造它。
   *
   * - `construct` —— 要。本进程里有消费者，或本进程构造它就是为了答别的进程。
   * - `skip` —— 不要。本进程里没有去处，构造了也没人读。
   * - `open` —— **还判不了**，且判不了的理由写在 reason 里（一律排到批 H）。
   *   `open` 不是「以后再说」的托词：它明确表示「本进程里没有消费者、去处在接口进程、
   *   而通往接口进程的通道今天不存在」，要么开通道、要么由接口进程自建，两条路都要人拍板。
   */
  verdict: 'construct' | 'skip' | 'open';
  /** 本进程内部的消费方。空数组 = 本进程里没有去处。 */
  automationConsumers: readonly AutomationSegCConsumer[];
  /** 其它段的读者（仅作证据，不构成「本进程有去处」）。 */
  foreignReaders: readonly AutomationSegCForeignReader[];
  /**
   * 本进程构造它**只是为了答别的进程**（接口进程为答内容进程而建读取器的那个形态）。
   *
   * MUST 只在 `automationConsumers` 为空且确有跨进程去处时为 true —— 它是一条要显式声明的例外，
   * 不是「反正别人要用」的默认解释。
   */
  servesOtherProcess: boolean;
  batch: AutomationSegCBatch;
  /** 依据。含消费点位置、守卫、以及跨进程通道今天有没有。 */
  reason: string;
}

/**
 * 41 条，按句柄名字典序。数字与顺序都不是手打的结论 —— 见文件头「重新派生的办法」。
 *
 * 派生时点：2026-08-01，源 `aidcp-cloud@f489e5e`。
 */
export const AUTOMATION_SEGC_EXPORT_DISPOSITION = [
  {
    handle: 'accountPersonaService',
    verdict: 'skip',
    automationConsumers: [],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'D',
    reason:
      '**2026-08-01 批 D 实读改判（原判 construct，错了）。** 与 personaAutoFill 同形：'
      + '它的构造条件在单体里就写着「非自动化模式」——生成器只在 monolith / core 两种模式下建，'
      + '自动化模式下它恒为 undefined，人设端口取的是**接口进程那个 HTTP 客户端**。'
      + '所以本进程里有去处的是那个客户端，不是这个本地服务实例；构造它等于多一个没人读的对象。'
      + '原判的依据（「构造后立刻喂进本段的人设端口表」）描述的是单体那一支，'
      + '而那一支在自动化进程里根本不执行。**这不是能力消失**：人设读写照常，只是走跨进程通道。',
  },
  {
    handle: 'alertStore',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-internal-api'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'B',
    reason:
      '风控告警出口，自动化段内多处写入；同时自动化内部 API 按它注册告警勾销路由，'
      + '接口进程经那条已建成的路由取。缺它时单体是具名 warn + 不注册，本包照办、MUST NOT 静默跳过。',
  },
  {
    handle: 'approvePublishForClient',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '客户端内稿件审批处理器，自动化段自己在边缘会话分支里调它。'
      + '接口服务段**另建一份自己的**（同名赋值，晚于自动化段），故接口进程不依赖本进程这一份。',
  },
  {
    handle: 'automationDispatchCommands',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'G',
    reason:
      '调度启停的执行端。自动化内部 API 读它注册运营指令路由，接口进程经那条通道下发；'
      + '它翻转的状态是本进程内的一个布尔，且真正的效果落在本进程的连接运行时上（启停全部会话）。'
      + '**刻意没有跨重启台账**：给它持久台账会把「重启后运营再点一次启动」判成重复并回放一条陈旧结论。',
  },
  {
    handle: 'automationEdgeResumeAuthority',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'D',
    reason:
      '成对指令接收器之一，本包的组装根已经在建它了（只差运行时依赖的真实供给方）。'
      + '它本身就是自动化进程对外的受理面，接口进程经配对客户端过来。',
  },
  {
    handle: 'automationFacebookScopeAuthority',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'G',
    reason:
      '同上，形态一致；它的运行时依赖来自评论域（批 G），故排在评论调度器那一批一起接。',
  },
  {
    handle: 'automationPublishUiUpdateAuthority',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '同上；它的运行时依赖是界面快照服务（批 F）。**注意与 publishUiUpdateCommand 分开**：'
      + '那一条是同一个接收器在非自动化模式下的别名导出，自动化模式下单体压根不赋值。',
  },
  {
    handle: 'buildTodayUsageForAccount',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '当日用量装配，自动化段自己在界面快照服务的取数口上用它。'
      + '接口服务段也读，但那一侧的去处属批 H 的导出面收口范围。',
  },
  {
    handle: 'captchaAssist',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-sync-read-source'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'D',
    reason:
      '验证码协助，自动化段多处消费；同步读快照源按它算 captcha_availability 这条属主流的可用性，'
      + '而那条流是本进程作为属主对外发布的 —— 缺它这条流就答不出真值。',
  },
  {
    handle: 'commentScheduler',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'G',
    reason: '评论调度器，自动化段内多处消费（含委托任务执行链的准入判断）。本进程内去处充分。',
  },
  {
    handle: 'configMirrorRefresher',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-sync-read-source'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'C',
    reason:
      '配置镜像刷新器；同步读快照源直接持它。它是本进程读配置面的前提，缺了整段配置读退化成陈旧值。',
  },
  {
    handle: 'dispatchActivityForPanel',
    verdict: 'construct',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: true,
    batch: 'G',
    reason:
      '**本清单里唯一一条「本进程没有消费者、但必须构造」**：面板方向的调度活跃三态读。'
      + '本进程是那个布尔的唯一持有者，接口进程只能问过来；通道已建成（运营指令读写两条已接线）。'
      + '与 automationDispatchCommands 里那个同步布尔**刻意分开**：那个给本进程内的接收方用，'
      + '三态对它没有意义；面板方向跨进程，「问不到」是一个必须表达得出来的真实答案，'
      + 'MUST NOT 答成「停着」—— 那是把不知道写成了结论。',
  },
  {
    handle: 'edgeServer',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'D',
    reason:
      '边-云 WebSocket 服务端，自动化段内八处消费（推送、能力查询、暂停判定）。'
      + '它是本进程唯一的对边出口，别的进程既读不到也不该读。',
  },
  {
    handle: 'handlePublishDraftImageRemove',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '草稿删图处理器，自动化段在边缘会话分支里调它。'
      + '与 approvePublishForClient 同形：接口服务段另建一份自己的，故接口进程不依赖本进程这一份。',
  },
  {
    handle: 'interactionCustomerApi',
    verdict: 'open',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '互动客户 API 面：在自动化段由互动存储 + 回复工作流 + 互动下发器装配而成（这三样都在本进程），'
      + '但装配结果**只有接口服务段读**，本进程里一次都不用。'
      + '两条路都成立、都要拍板：① 接口进程经一条新端口向本进程取；'
      + '② 把这层装配整体移到接口进程，本进程只暴露它需要的那几个读写。'
      + '**今天没有任何通道**，所以既不能判 construct（构造了没去处），也不能判 skip（那等于这条能力消失）。',
  },
  {
    handle: 'interactionInternalApi',
    verdict: 'open',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason: '与 interactionCustomerApi 同形同因，一并裁定。',
  },
  {
    handle: 'interactionOffboarding',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'G',
    reason:
      '互动退场服务：自动化段自己在连接断开、定时重试与到期清理三处调它，本进程内去处充分。'
      + '接口服务段那一读属批 H 的导出面收口范围，不影响本条裁定。',
  },
  {
    handle: 'interactionPermissionOverview',
    verdict: 'open',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '面板互动权限总览：在自动化段由面板用户名单与互动授权算出，本进程一次都不读。'
      + '它的两个输入接口进程都拿得到（名单本来就是从同一个环境变量解析的），'
      + '⇒ 倾向由接口进程就地算，但那要先确认互动授权那一半在接口进程里也读得到。未确认前不判。',
  },
  {
    handle: 'interactionSender',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'G',
    reason:
      '互动下发器，只被自动化段消费（入队准入、下发、断连恢复）。'
      + '注意它的缺席分支是**具名抛错**而不是静默短路，搬的时候别改成可选链。',
  },
  {
    handle: 'interactionStore',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'B',
    reason:
      '互动流存储，自动化段内消费面最广的一个（建表、恢复卡住的分类任务、过期清理、回复工作流）。'
      + '接口服务段读它作只读面，属批 H 范围。',
  },
  {
    handle: 'listAccountAutomationCatalog',
    verdict: 'open',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '账号自动化目录读：在自动化段定义，本进程一次都不调，只有接口服务段读。'
      + '它读的是内容排期相关的行 —— 归属要先确认（读的表属谁），确认前不判由谁建。',
  },
  {
    handle: 'notifyPublishRejected',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason: '驳回通知，自动化段自己在审批链与委托执行链两处调它。本进程内去处充分。',
  },
  {
    handle: 'panelUsers',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'E',
    reason:
      '面板用户名单：自动化段用它算互动权限总览，本进程内有去处。'
      + '接口服务段**已经会在缺席时按同一个环境变量就地重解析**（单体下短路、逐字节等价），'
      + '所以接口进程不依赖本进程这一份。',
  },
  {
    handle: 'personaAutoFill',
    verdict: 'skip',
    automationConsumers: [],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '人设自动补全服务：单体里它的构造条件**逐字写着「非自动化模式」**，'
      + '也就是说自动化进程从来就没有它，段内那一句恢复调用在自动化模式下读到的是 undefined。'
      + '本包照此不构造 —— 这不是省事，是照抄既有裁定；改成构造等于悄悄改变了模式行为。',
  },
  {
    handle: 'preflightApprovePublish',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason: '审批前置校验，自动化段在客户端审批处理器与委托执行链两处调它。本进程内去处充分。',
  },
  {
    handle: 'publishDispatchTrigger',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api', 'automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '发布下发触发端口：自动化段自己在审批通过路径上调它，同时自动化内部 API 按它注册触发路由，'
      + '接口进程经那条已建成的路由过来。缺它时单体是具名 warn + 不注册，本包照办。',
  },
  {
    handle: 'publishDispatcher',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-sync-read-source'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '发布下发器；同步读快照源直接持它（publish_in_flight 这条属主流靠它答）。'
      + '**搬的时候盯住它的素材端口**：那是个可选参数，漏传不报错，只会让预留释放 / 标记已用 / 隔离三个写静默消失。',
  },
  {
    handle: 'publishScheduler',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '发布调度器，自动化段内多处消费（忙闲判定、定时触发、委托执行链）。'
      + '基础段与接口服务段的读都在缺席时**具名拒绝**（抛 publish_unready / 返回具名 reason），'
      + '不是静默放行 —— 搬完要保住这一点。',
  },
  {
    handle: 'publishUiUpdateCommand',
    verdict: 'skip',
    automationConsumers: [],
    foreignReaders: ['api-foundation', 'api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '同一个界面更新接收器在**非自动化模式**下的别名导出：单体那一行外面就套着「非自动化模式」的判断，'
      + '自动化进程根本不赋值。自动化侧那一份叫 automationPublishUiUpdateAuthority（另有一条）。'
      + '接口服务段还会另建自己的客户端。⇒ 本包不导出这一条，否则等于凭空多出一条模式行为。',
  },
  {
    handle: 'readLiveContentVersion',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason: '在线稿件版本读，自动化段在客户端审批处理器里调它做乐观锁校验。本进程内去处充分。',
  },
  {
    handle: 'readPublishApproval',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason: '审批读，自动化段内五处消费（界面快照、边缘会话、审批处理器、人审端口）。',
  },
  {
    handle: 'refreshPublishPreview',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'F',
    reason: '预览刷新，自动化段内三处消费（精修回写、审批处理器、委托执行链）。',
  },
  {
    handle: 'resolveController',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'B',
    reason:
      '风控控制器解析，自动化段内十余处消费（评论 / 加群 / 每日上限 / 记账）。'
      + '**它的导出面今天没有任何读者**（接口服务段没解构它，也没有一处读共享上下文的这个字段）'
      + '⇒ 本包只要那个本地函数，不必再导出一遍。'
      + '风控是单写者，这条排在批 B 最前面：后面几乎每一批都要向它要控制器。',
  },
  {
    handle: 'riskCommandService',
    verdict: 'construct',
    automationConsumers: ['automation-internal-api', 'automation-runtime'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'B',
    reason:
      '风控指令服务：自动化内部 API 按它注册风控指令路由（且**缺部署目标时具名不注册**，'
      + '理由是命令无人应用故不受理），自动化段自己也接命令消费者。',
  },
  {
    handle: 'riskRegistry',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-internal-api'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'B',
    reason:
      '风控注册表 —— 账号风控最终状态的唯一写者所在。自动化段内十余处消费，'
      + '自动化内部 API 按它注册只读风控路由供接口进程取。',
  },
  {
    handle: 'rolePromptProvider',
    verdict: 'open',
    automationConsumers: [],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'H',
    reason:
      '角色提示词读取器：在自动化段由预览调度器现有角色表构造，本进程一次都不读。'
      + '倾向是接口进程按角色目录自建（角色表是静态配置），但**要先确认它读的不只是静态目录**'
      + '——若含运行时注册的角色，那就只有本进程答得出，得开一条通道。未确认前不判。',
  },
  {
    handle: 'runtimes',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation'],
    servesOtherProcess: false,
    batch: 'E',
    reason:
      '按连接的多租户运行时注册表 —— 浏览闭环真正跑起来的地方，自动化段内十余处消费。'
      + '它要三样东西：控制器解析（批 B）、调度器工厂、关连接（批 D），所以排在两者之后。',
  },
  {
    handle: 'scheduledPublishReconciler',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '定时发布对账器：自动化段构造并 start，基础段只在关停路径上 stop 它。'
      + '⇒ 那不是「接口进程要用它」，是生命周期钩子，本包的关停路径要接住同一件事。',
  },
  {
    handle: 'server',
    verdict: 'construct',
    automationConsumers: ['automation-runtime', 'automation-sync-read-source'],
    foreignReaders: ['api-serving'],
    servesOtherProcess: false,
    batch: 'D',
    reason:
      '与 edgeServer 是同一个边-云服务端实例的两个导出名。'
      + '同步读快照源经**响亮取用闸**取它（缺了带字段名与来源段抛错），edge_presence 那条属主流靠它答。'
      + '搬的时候保住那道闸：MUST NOT 退回可选链短路。',
  },
  {
    handle: 'triggerPublishDispatchOnApprove',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: [],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '审批通过后触发下发，自动化段自己在审批与人工复核两处调它。'
      + '**它的导出面今天没有读者**：接口服务段另有一份同名的本地实现，不读共享上下文这个字段。'
      + '⇒ 本包只要本地函数，不必再导出一遍。',
  },
  {
    handle: 'uiSnapshot',
    verdict: 'construct',
    automationConsumers: ['automation-runtime'],
    foreignReaders: ['api-foundation', 'content'],
    servesOtherProcess: false,
    batch: 'F',
    reason:
      '界面快照服务：自动化段构造并自用（每日用量推送、握手快照），也是界面更新接收器的唯一依赖。'
      + '基础段与内容段那两处读都是**跨段前向引用**，三等分后必须经响亮取用闸，'
      + 'MUST NOT 写成可选链 —— 那会让「状态变了却没有任何界面收到推送」静默发生。',
  },
] as const satisfies readonly AutomationSegCExportDisposition[];

/** 判据清单的分组统计。**算出来的，不是手打的**（同名验收用例按此对账）。 */
export function summarizeSegCExportDisposition(
  entries: readonly AutomationSegCExportDisposition[] = AUTOMATION_SEGC_EXPORT_DISPOSITION,
): {
  total: number;
  byVerdict: Record<AutomationSegCExportDisposition['verdict'], number>;
  byBatch: Record<AutomationSegCBatch, number>;
  servesOtherProcess: number;
} {
  const byVerdict = { construct: 0, skip: 0, open: 0 };
  const byBatch: Record<AutomationSegCBatch, number> = {
    B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0,
  };
  let servesOtherProcess = 0;
  for (const entry of entries) {
    byVerdict[entry.verdict] += 1;
    byBatch[entry.batch] += 1;
    if (entry.servesOtherProcess) servesOtherProcess += 1;
  }
  return { total: entries.length, byVerdict, byBatch, servesOtherProcess };
}
