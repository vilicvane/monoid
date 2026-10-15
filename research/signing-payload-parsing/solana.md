# Solana 签名解析与事务结果模拟

调研日期：2026-10-14。主覆盖 legacy / v0 交易、原始消息签名和 SIWS。本文是方案研究，未接入钱包、未提交交易、未调用付费模拟服务；文中的验收案例均是待实施测试。SDK 和 RPC 的支持范围必须按实际选用版本及端点复核。

## 结论

建议以“原始 message 字节保真 + 本地结构解码 + RPC 执行模拟 + 账户变化解释”作为 Solana 方案。模拟结果应直接回答 SOL / token 减少多少、收到什么、谁获得授权、哪个账户被创建或关闭，以及执行是否失败；指令名和日志用于补充解释。未知程序可以模拟，但模拟成功不能证明其所有未来行为或安全性。

本地解码优先评估 `@solana/kit` 配合官方生成的 program clients；已存在 legacy web3.js 依赖时可隔离使用旧 decoder。程序专有语义由固定版本的 Codama / Anchor IDL 或手写 schema 补足。单笔模拟先用标准 `simulateTransaction`，相互依赖的多笔请求需要可共享状态的模拟服务，不能把独立模拟结果拼成“批量执行结果”。

## 1. 签名实际覆盖什么

legacy / v0 的 Ed25519 签名覆盖序列化 **Message 的精确字节**，不是整个含 signatures 的 Transaction，也不是应用预先计算的 SHA-256 / Keccak 摘要。legacy message 包含 header、静态公钥、recent blockhash、compiled instructions；v0 增加版本前缀与 ALT 引用。每个签名对应静态公钥列表前 `numRequiredSignatures` 个账户中的同一位置；第一个账户是 fee payer。[交易结构](https://solana.com/docs/core/transactions/transaction-structure)

工程建议：保存输入原始 transaction、切出的 message 字节以及其本地指纹，所有解释都绑定同一份 message。不要先 decode、重新编译账户顺序，再把新 message 当作原签名请求。已有部分签名必须按原字节验证；新增签名放回正确槽位。模拟中替换 blockhash 产生的是另一个执行假设，不能悄悄变成实际待签字节。

本次只读核对本机 `C:\Projects\monoid-javacard\src\main\java\monoid\Signer.java` 的 `signEDDSAMessage` 和 `LibED25519.java`：当前源码通过 `ByteSource + offset + length` 对完整消息做纯 Ed25519，返回 64 字节签名；消息源在两遍读取期间必须不变。这与 Solana message 签名所需原语相容，但不等于已经验证 APK 到卡片的长度上限、实际安装固件、吞吐、所有交易格式及端到端流程。本研究不改卡协议。

### 结构输出应保留的事实

| 字段                  | 可直接解析的内容                                                | 需要额外上下文的部分                       |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Header / static keys  | signer、消息声明的 writable / readonly、fee payer、所需签名数量 | 实际账户 owner、余额和程序可执行状态       |
| Blockhash             | 原始 32 字节及来源为交易输入                                    | 是否仍有效、过期高度、是否为 durable nonce |
| Compiled instructions | program 索引、顺序账户索引、原始 data、顶层顺序                 | 参数含义、账户角色、业务后果               |
| v0 ALT                | table 地址、writable / readonly 索引                            | 对应链及 slot 上的 table 内容和可用性      |

消息权限是运行时权限约束的输入；展示时应说“请求可写”，不要暗示被标为 writable 的账户必然发生变化。durable nonce 还要识别首条 nonce advance 指令、nonce 账户及 authority，不能只按普通 recent blockhash 的过期规则解释。[Durable nonces](https://solana.com/docs/core/transactions/durable-nonces)

### v0 与 ALT

解析后的账户索引顺序为静态账户、所有 lookup 装载的 writable 地址、所有 lookup 装载的 readonly 地址。ALT 装载账户不能充当 transaction signer。签名绑定 table 地址及索引，而不是把解析出的公钥内联签入 message，因此解析来源也必须记录。[Versioned transactions](https://solana.com/docs/core/transactions/versioned-transactions)

建议把 cluster / genesis hash、RPC 身份、commitment、context slot、table 数据指纹、索引映射一起保存；校验 table owner、布局、索引边界和当前 slot 可用性。dApp 提供的 ALT 内容只能作为未验证提示。解析失败时不要用占位地址继续输出可信收款方，更不要静默改成另一笔交易。ALT 的扩展、停用和关闭有程序约束，应使用官方账户解码器及 runtime 规则，而不是假定任何读取到的地址数组都可执行。[ALT program](https://github.com/solana-program/address-lookup-table)

### v1 单列跟踪

调研日的官方文档已经描述 v1：wire 布局、资源配置及 ALT 支持均与 legacy / v0 不同。本文未核实目标网络的激活状态或实际端点兼容性，不能声称所有 Solana 交易只有 legacy / v0，也不能把 v1 自动套入 v0 decoder。首版必须显式拒绝未验收版本；后续另做 v1 字节、费用、模拟和卡片长度验收。[版本文档](https://solana.com/docs/core/transactions/versioned-transactions)、[SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md)

## 2. 模拟是主路径：输入、输出与状态一致性

### 标准 `simulateTransaction`

| 参数                     | 研究建议                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `encoding`               | 使用 `base64` 传完整交易 envelope，保留原 message；未签名时仍要满足端点要求的签名槽布局                                  |
| `sigVerify`              | 签名前设 `false`，明确“未验签”；签名齐全后的复核可设 `true`                                                              |
| `replaceRecentBlockhash` | 尽可能对真实待签 blockhash 用 `false`；过期草稿可单独用 `true` 模拟，但记录替换及 returned blockhash，不冒充原交易可执行 |
| `commitment`             | 显式指定并记录；与余额、ALT、mint 等上下文读取保持一致                                                                   |
| `minContextSlot`         | 防止节点使用更旧状态；它是下限，**不是固定 slot 的快照查询**                                                             |
| `accounts`               | 指定需要返回的 post-state 账户及 base64 编码；覆盖可写账户、收款账户、mint 和权限相关账户，控制端点上限                  |
| `innerInstructions`      | 请求 CPI 记录，供执行路径及 token 动作解释；同时保留缺失或截断状态                                                       |

这些是标准 RPC 的配置入口。`sigVerify: true` 与 `replaceRecentBlockhash: true` 不可同时使用；因为 blockhash 被改后签名不再对应。未签名模拟说明的是“假设签名获得后执行会怎样”，不是证明授权已存在。[RPC 规范](https://solana.com/docs/rpc/http/simulatetransaction)、[Agave RPC 实现](https://github.com/anza-xyz/agave/blob/master/rpc/src/rpc.rs)

当前官方示例及 Agave 源码已包含 `fee`、`preBalances`、`postBalances`、`preTokenBalances`、`postTokenBalances`、`loadedAddresses`；不要沿用旧实现“标准模拟完全没有 before balances”的结论。具体服务可能尚不返回这些字段，需启动时做能力探测并保留字段缺失信息。余额列表按执行账户索引解释；v0 必须合并 loaded addresses 后再映射。不能把缺失列表当空列表，更不能把未知金额当 0。[RPC 结果示例](https://solana.com/docs/rpc/http/simulatetransaction)、[Agave response types](https://github.com/anza-xyz/agave/blob/master/rpc-client-types/src/response.rs)

### 应生成的用户结果

以下是建议的结果模型，不是已实现 API：

| 类别     | 需要解释的内容                                                                                   | 证据与限制                                                                        |
| -------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 执行状态 | 成功、程序失败、环境失败、未运行、依赖前序失败而跳过                                             | 记录 `err` / provider status，区分余额不足、blockhash 过期和解析失败              |
| 原生资产 | 每账户 lamports 变化、用户净 SOL 变化、fee、账户创建资金和关闭返还                               | 净变化已包含费用时不可再减一次；用整数运算，展示中区分 fee 与账户资金             |
| Token    | mint、Token Program、token account、owner、raw amount 及净变化                                   | 以 mint / program 确认身份；symbol、logo 只作辅助元数据；不用浮点 `uiAmount` 作账 |
| 授权     | delegate、delegated amount、owner authority、close authority、mint / freeze authority 的前后差异 | 余额不变仍可能新增长期授权，需要账户数据 decoder                                  |
| 生命周期 | ATA / token / stake 等账户的创建、关闭、账户 owner 程序变化                                      | 账户缺失与模拟失败返回 null 必须分开                                              |
| 执行路径 | 顶层 instruction、CPI、日志、CU、return data                                                     | 日志和 return data 是程序可控文本或数据，不充当资产事实                           |
| 覆盖缺口 | 未知程序、未知扩展、未解析账户、未捕获前态、模拟状态变化                                         | 与已确认变化同时显示，禁止折叠为“无风险”                                          |

在调研日读取的 Agave 实现中，模拟出错时请求的 `accounts` 会返回一组 `None`。因此 `err != null` 时不能把这些 null 解读为“账户全部被关闭”；失败时的费用、nonce 等特殊处理也应按结果字段和对应运行时解释，不能从部分日志外推成功结算。[Agave 模拟结果构造](https://github.com/anza-xyz/agave/blob/master/rpc/src/rpc.rs)

### 前态、后态必须来自可说明的上下文

1. 优先使用同一次模拟返回的原生 / token pre/post balances；它们解决余额差额的一致性问题。
2. 权限和扩展需要完整账户数据。标准 `accounts` 是 post-state，不等同于完整 before/after account diff；若服务无同快照前态，单独读取 `getMultipleAccounts` 只能提供旁证。
3. 单独读取时记录各次 slot、commitment、账户数据指纹。即使设置相同 `minContextSlot`，也不能宣称锁定同一个 bank；若快照不一致，授权变化应标为估计或不可确认。
4. 若产品必须可靠报告完整权限变化，选择能在一次执行中返回 pre/post account 数据的服务，或在固定状态下运行本地模拟；不能用“多请求恰好同 slot”替代已定义的快照语义。

第 2—4 项是基于标准查询接口能力作出的工程判断：`getMultipleAccounts` 提供 commitment 和最小 slot，而没有任意指定历史 slot 并把另一 RPC 调用锁在同一快照的通用参数。[账户批量读取](https://solana.com/docs/rpc/http/getmultipleaccounts)

### 多笔相互依赖交易

“创建 ATA → 转入代币”“approve → 使用 delegate”“先换币 A → 再花 A”都要求后笔看到前笔的模拟写入。HTTP JSON-RPC batch、并发调用或逐笔普通 `simulateTransaction` 都不自动建立该状态继承。若产品接收 `signAllTransactions`，必须分别说明“独立签名列表”与“有序执行序列”；签名多笔本身也不保证链上原子性。

| 方案                                       | 能力                                                                            | 适用位置及待验证项                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 标准 `simulateTransaction`                 | 单笔、程序错误、日志、CPI、请求账户后态；新端点可返回 pre/post balances         | 单笔 MVP；探测字段与版本；不承诺多笔连续状态                                                          |
| Jito `simulateBundle` / QuickNode Lil' JIT | 专有 bundle 模拟、按交易配置 pre/post 账户                                      | 验证服务是否安装扩展、顺序语义、失败终止、费用/tip、before/after 覆盖；不是所有 Solana RPC 的标准方法 |
| Alchemy `simulateTransactionsAtSlot`       | 官方文档描述最多 5 笔在共享可写状态上顺序模拟，指定历史 slot，可做账户 override | 固定状态研究、回归和依赖多笔；历史覆盖、运行时版本、配额、延迟均需实测                                |
| 本地 LiteSVM / 自管 SVM                    | 加载程序及账户后可控制执行状态，用于确定性 fixture                              | 需维护完整程序、账户、sysvar、feature set；不能仅载入用户余额便声称复现主网                           |

Jito 的扩展类型有独立 pre/post 配置；QuickNode 文档把该方法归在 JITO 并要求相应服务能力。[Jito 类型](https://github.com/jito-foundation/jito-solana/blob/master/rpc-client-api/src/bundles.rs)、[QuickNode simulateBundle](https://www.quicknode.com/docs/solana/simulateBundle)。Alchemy 文档要求按 `status` 判断，`skipped` 的 `err` 也可能为 null，且固定运行时不能无条件复现很久以前的网络行为。[Alchemy 文档](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-transactions-at-slot)。LiteSVM 是可嵌入的测试执行环境；此处作为后续回归路线，不把它当作开箱即用的主网快照服务。[LiteSVM](https://github.com/LiteSVM/litesvm)

### 模拟结果的边界

余额、程序升级、oracle、slot / Clock、账户权限、ALT 可用性和竞争交易均可能在签名前后变化。应记录模拟 message 指纹、slot、cluster、端点、运行时版本、blockhash 替换、验签开关、state overrides 和时间；用户改动任何待签字段后原结果失效。可以允许“模拟不可用”的显式流程，但不能把超时、缺数据或 unknown program 转成绿色成功。

`sigVerify: false` 允许构造带 signer 权限但没有有效签名的假设执行；state override 可以构造现实中不存在的余额和权限。因此应把真实请求模拟、替换 blockhash 的草稿模拟、override 情景模拟分别标示。网络正常、模拟成功也不保证落链顺序、价格、可用余额或最终成功。

## 3. 指令与账户解码覆盖

按 **program id + 明确 schema 版本** 路由 decoder，保留全部顶层指令，不只识别第一条 transfer。所有 u64 / u128 使用大整数和定点展示。程序名、token symbol 和 IDL 描述都不能覆盖字节及公钥事实。

| Program / 领域           | 首批应识别                                                                                                         | 额外上下文或特殊点                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| System                   | SOL transfer、create account、assign、allocate、nonce 操作                                                         | account owner、租金资金、nonce authority；收款地址不一定是普通钱包                                                                  |
| SPL Token                | Transfer / TransferChecked、Approve / Revoke、SetAuthority、MintTo / Burn、CloseAccount、Freeze / Thaw、SyncNative | token account → mint / owner / delegate；unchecked transfer 不能仅凭指令得出 mint 与 decimals；wrapped SOL 关闭时注意 lamports 返还 |
| Token-2022               | 基础动作及已支持扩展                                                                                               | TLV 扩展、transfer fee / withheld amount、permanent delegate、transfer hook、显示金额缩放、机密余额；未知扩展不得伪装成普通 token   |
| Associated Token Account | Create、CreateIdempotent、RecoverNested                                                                            | 钱包 owner / mint / token program 的派生关系、payer 和账户创建资金；不是所有 token account 都是 ATA                                 |
| Compute Budget           | unit limit、unit price、heap / data limits                                                                         | legacy / v0 费用参数；与模拟 `fee` 和实际 CU 分开，不能把 unit price 当总费用                                                       |
| Stake                    | delegate、deactivate、withdraw、authorize、split / merge                                                           | staker / withdrawer、lockup、目标 vote account、账户余额与可提取额的区别                                                            |
| Memo / 未知程序          | 原始 memo；未知程序地址、账户权限、data 大小和字节                                                                 | memo 是任意文本；未知协议的模拟资产结果可以展示，但不声称已解释所有业务意图                                                         |

参考官方实现与生成客户端：[System](https://github.com/solana-program/system)、[SPL Token TransferChecked decoder](https://github.com/solana-program/token/blob/main/clients/js/src/generated/instructions/transferChecked.ts)、[ATA](https://github.com/solana-program/associated-token-account)、[Compute Budget](https://github.com/solana-program/compute-budget)、[Stake](https://github.com/solana-program/stake)。Token-2022 需要进一步解码 mint / account 的 TLV 扩展；明文 token amount 与用户可见净到手量并非总能直接等同。[Token extensions](https://solana.com/docs/tokens/extensions)

### CPI、未知程序与 IDL

一个顶层 swap 可以经 CPI 调用多个 token、系统及其他程序；静态反序列化只能得出输入，无法直接枚举所有依赖当前状态的内部调用。CPI 受账户权限约束，程序还能通过 PDA seeds 为自身 PDA 提供签名权限。因此应同时展示“交易 signer”与“执行中使用的 PDA authority”，不要把后者显示成用户额外签了一次。[CPI](https://solana.com/docs/core/cpi)、[无 PDA signer 的 CPI](https://solana.com/docs/core/cpi/cpi-without-pda)

Token-2022 的 transfer hook 也会触发 CPI，但不能泛化为“hook 自动拿到了用户的全部 signer 权限”：官方文档明确基础 transfer 账户传入 hook 时被降为 readonly，sender signer 权限不会直接传递。仍需检查额外账户与 hook 本身的实际模拟结果。[Transfer hook](https://solana.com/docs/tokens/extensions/transfer-hook)

Anchor IDL 可以恢复 instruction discriminator、参数和账户名称，减少手写 Borsh 的工作；但 IDL 文本不是程序行为证明。必须绑定 program id、IDL 来源和版本，考虑程序升级、额外 remaining accounts、可选账户及自定义布局。使用 IDL 明确提供的 discriminator，不应对所有生态程序盲目假设固定八字节约定。IDL 对不上时降为未知，不能借用“同名函数”的 decoder。[Anchor IDL](https://www.anchor-lang.com/docs/basics/idl)

Codama 能把 Anchor IDL 转换成其模型并生成 Kit 兼容客户端，适合为少量已审核协议生成 decoder。手写 schema 适用于 IDL 缺失、格式特殊的热门协议，但维护者必须提供原始字节 fixture、字段边界、账户顺序及差异测试。两种方法都需要另写“这些字段对用户意味着什么”的语义层。[Codama](https://github.com/codama-idl/codama)、[Kit JS renderer](https://github.com/codama-idl/renderers-js)

## 4. 离链消息、SIWS 与 domain

| 输入类型                          | 签名与解析规则                                                     | 建议的展示和校验                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `solana:signMessage`              | 直接签传入 bytes，没有以太坊 personal-sign 那样自动添加的通用前缀  | 严格 UTF-8 可读检查、控制字符及换行展示；保留 hex / 原始长度；不把任意文本归类为登录                                     |
| SIWS `solana:signIn`              | 钱包依据结构化输入构造标准 sign-in 内容，再返回确切 signed message | 显示并核对 domain、URI、address、chain、nonce、issuedAt、expiration、resources；服务端比较原 challenge，消费一次性 nonce |
| OCMS `solana:signOffchainMessage` | 标准 off-chain envelope，与 transaction 有格式隔离                 | 单列 message version、required signers 及实际签入 envelope；不能与 raw message bytes 混用                                |

原始 signMessage bytes 本身没有“这一定不是交易”的标记；解析器应识别交易形状并按产品策略拒绝或升级到交易审阅，不能因为调用名是 signMessage 就按低风险文本签名处理。SIWS 的 domain 也必须和请求来源比较，而非只相信正文自报的网站名。[消息与认证官方指南](https://solana.com/docs/frontend/messages-and-auth)、[SIWS 原始规范与验证流程](https://github.com/phantom/sign-in-with-solana)

OCMS 与 SIWS 是可组合但独立的层。调研日官方文档描述了 v1 off-chain message 以及 `solana:signIn` 1.1 的 opt-in 包装，旧客户端文档仍可能描述 v0；必须按 wallet feature/version 协商和最终 signed bytes 验证，不推断任意钱包或卡端都已支持。对于当前 Monoid，纯 Ed25519 原语可处理由应用构造的完整 envelope，但语义校验与格式支持仍要在应用实现并端到端验收。[Kit offchain messages](https://www.solanakit.com/docs/advanced-guides/offchain-messages)

## 5. 候选库组合与取舍

| 路线                                               | 收益                                                            | 主要成本 / 风险                                                              | 建议                                             |
| -------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `@solana/kit` + `@solana-program/*`                | transaction / message codec、RPC、官方程序的生成 decoder 可组合 | 需实测现有 Monoid 的 TS、bundler、Capacitor 运行环境；语义规则仍由应用维护   | 新解析模块优先做最小验证                         |
| legacy `@solana/web3.js` 1.x + `@solana/spl-token` | 既有 Transaction / Message / VersionedTransaction 生态资料多    | maintenance 路线、版本格式支持需核对、较旧 decoder 不覆盖新扩展              | 仅在已有依赖使成本明显较低时使用，并固定版本     |
| Anchor TS coder / client                           | 对已知 IDL 易恢复参数和账户数据                                 | 当前 Anchor 文档注明 legacy web3.js 兼容边界；整套 provider 并非纯解析所必需 | 限于特定程序的隔离适配器，不把它当全链 parser    |
| Codama 生成 + 小型语义 registry                    | 编译期冻结 schema，Kit 客户端可复用，覆盖按 program 扩充        | IDL 来源、升级映射和生成代码维护                                             | 与 Kit 组合，按真实协议需求逐个加入              |
| 全部手写二进制解析                                 | 依赖少、可以严格限定覆盖                                        | shortvec、账户布局、扩展、版本变更容易漏                                     | 只用于小范围缺口和独立验证，不建议作为第一条主线 |

官方 SDK 页面推荐 Kit，并区分 legacy web3.js；本次同时看到该页面把 web3.js v3 列为推荐，而 Solana Foundation 的迁移参考仍标记 v3 为 RC。未核实 npm dist-tags、精确发布版及 Monoid 的构建兼容性，因此本文不把 v3 判为稳定迁移目标，也不凭这些不同页面选择具体版本。[官方 JS SDK](https://solana.com/docs/clients/official/javascript)、[Foundation interop 参考](https://github.com/solana-foundation/solana-dev-skill/blob/main/skills/solana-dev/references/kit-web3-interop.md)、[Anchor TS 兼容边界](https://www.anchor-lang.com/docs/clients/typescript)

## 6. 建议实施阶段与验收

| 阶段               | 可交付范围                                                                                  | 验收门槛                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S0：字节及模拟基线 | legacy / v0、ALT、签名槽、单笔标准模拟、SOL / Token pre/post 变化、费用、失败和缺失字段状态 | 签名覆盖字节逐项一致；ALT 无法解析时不误报地址；未知格式明确拒绝；未验签和 blockhash 替换显式记录 |
| S1：授权及扩展结果 | 完整账户 decoder、可靠前态来源、approve / authority / close、Token-2022 常见扩展、CPI 分组  | 零余额变化的授权动作仍被捕捉；未知扩展保留缺口；模拟失败 null 不解释为关闭                        |
| S2：依赖序列及协议 | 同快照顺序模拟、provider adapter、少量已审核 IDL、swap 最小收款及实际模拟量                 | 后笔读取前笔写入；失败与 skipped 不混淆；服务不支持 bundle 时不降级成伪连续结果                   |
| S3：离链及版本扩展 | SIWS / OCMS 完整校验、v1 独立验收、更多协议                                                 | domain / nonce / exact bytes 一致；不依靠猜测支持未知 message / transaction version               |

建议至少纳入以下 fixture，使用公开测试密钥、本地 validator / 受控模拟数据，不需要真实资金：

1. legacy SOL transfer，fee payer 与转出 signer 不同；核对原始签名字节、签名槽和净额不重复扣 fee。
2. v0 使用两个 ALT，混合 writable / readonly 索引；覆盖 table 缺失、越界、网络不匹配和未生效状态。
3. partially signed 多签交易；补签不改 message、不覆盖已有签名；错误签名在签后复核被发现。
4. ATA 创建 + TransferChecked + 关闭 wrapped SOL 账户；正确区分 token 转账、租金资金与 SOL 返还。
5. `Approve` / `SetAuthority` 无余额变化；结果仍报告新 delegate、额度、owner / close authority 变化。
6. Token-2022 transfer fee、transfer hook、未知 TLV、scaled UI amount；保留 raw amount，未知扩展不输出普通转账承诺。
7. swap 顶层未知但 CPI 可识别；显示真实模拟资产变化、slippage 参数（若可解码）与程序语义未知两者。
8. 单次模拟失败返回 `accounts: [null, ...]`，不产生账户关闭事件；字段缺失也不产生零变化。
9. 前态读取 slot 与模拟 slot 不同；余额以同次 pre/post 为准，权限差异标出不确定性。
10. 两笔“创建 ATA → 使用 ATA”：独立模拟第二笔失败而顺序模拟成功；验证引擎确实传递前笔状态。
11. 三笔序列第二笔失败，第三笔 skipped；成功 JSON-RPC 响应不能被当作业务全部成功。
12. blockhash 过期、durable nonce、CU 不足、程序错误、RPC 超时、缺 inner instructions；状态分类可区分。
13. signMessage 中塞入交易 message、非法 UTF-8、控制字符；SIWS 域名错误、nonce 重放、过期以及 OCMS 版本不支持。
14. 未知 transaction version（包括尚未验收的 v1）；不得以 legacy / v0 尝试恢复后继续签名。

尚未验证：Monoid 现有构建环境对候选 SDK 的兼容性、目标 RPC 新字段实际可用性、各 provider 延迟和费用、完整 before/after 权限捕获、卡片实际固件及最大 message 长度、真实协议和网络上的端到端差异。优先验证 S0 / S1 模拟结果可信度，再扩大 decoder 数量。
