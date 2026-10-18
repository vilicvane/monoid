# Solana 连接与签名服务选型

调研日期：2026-10-18。面向 Monoid 后续的 Solana WalletConnect 接入，保存连接、消息签名、交易审阅、模拟、广播和结果展示所需的服务选择。底层解析与签名保真要求见 [Solana 签名解析与事务结果模拟](solana.md)。

首版建议复用现有 WalletConnect，增加一个 Solana RPC，并使用 Jupiter 提供 Token 名称和图标。连接本身和消息签名不依赖 RPC；交易相关读取、模拟、发送与确认可以共用同一个 RPC。先实现连接，再逐项开放签名能力，不需要预先接入交易索引器或专业广播服务。

## 签名流程

| 流程           | WalletConnect 方法              | 签名之后                                 |
| -------------- | ------------------------------- | ---------------------------------------- |
| 消息签名       | `solana_signMessage`            | 返回签名给网站，用于登录或证明账户所有权 |
| 单笔交易签名   | `solana_signTransaction`        | 返回签好的交易，由网站负责广播           |
| 批量交易签名   | `solana_signAllTransactions`    | 返回多笔签好的交易，由网站负责发送       |
| 签名并发送交易 | `solana_signAndSendTransaction` | 钱包负责签名、广播，返回交易标识         |

上述是后续需要覆盖的交互范围；实际连接授权只宣告当前已经实现的方法。不同网站和连接器支持的方法可能不同，不能把四种流程都假设为每个网站的必选能力。[ConnectorKit 支持的方法](https://github.com/solana-foundation/connectorkit/blob/main/packages/connector/README.md#supported-walletconnect-solana-methods)

SIWS（Sign In With Solana）将域名、登录说明、nonce、时间等组成标准登录消息，适合独立的 Sign in 审阅页。签名原语仍是 Ed25519，但 Wallet Standard 的 `solana:signIn` 与 WalletConnect 方法属于不同接口，不能直接按同名能力接入。网站后端负责生成挑战、校验签名和维护登录状态。[消息与登录规范](https://solana.com/docs/frontend/messages-and-auth)

## 功能与服务对应关系

| 功能                       | 所需能力                                            | 首版选择                                         |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| 连接网站、接收请求         | Relay、会话和账户授权                               | 复用现有 WalletKit 与 Project ID                 |
| 消息签名、SIWS             | 本地解析、卡片签名、本地验签                        | 无需 RPC；保持待签原始字节                       |
| 交易审阅和签名             | 读取账户、Mint、地址查找表；本地解析指令            | 标准 Solana RPC，签名仍在卡内                    |
| 手续费与优先费             | `getFeeForMessage`、`getRecentPrioritizationFees`   | 先用标准 RPC；需要推荐档位时再使用服务商估算     |
| 签前模拟                   | `simulateTransaction`                               | 标准 RPC                                         |
| 广播与确认                 | `sendTransaction`、`getSignatureStatuses`           | 同一 RPC，初期轮询状态                           |
| 交易结果与资产变化         | `getTransaction` 的余额、Token 余额、费用和指令结果 | 同一 RPC；区分净变化、手续费、账户创建或关闭资金 |
| Token 名称、图标和收录情况 | 通过 Mint 查询元数据                                | Jupiter Tokens V2，必要时补充链上元数据          |
| 地址的见过、信任、危险标记 | 本地持久化和实际签名记录                            | 沿用现有机制，无需外部服务                       |

连接与标准 RPC 的来源见 [Reown Relay](https://docs.reown.com/cloud/relay)、[Solana HTTP RPC](https://solana.com/docs/rpc/http)。Mint 小数位、Token Program 和权限状态以链上数据为准；名称、符号、Logo 和服务商收录标志只用于辅助识别，不能替代资产身份或权限判断。[Token Mint](https://solana.com/docs/tokens/basics/create-mint)、[Jupiter Token 信息](https://developers.jup.ag/docs/tokens/token-information)

## 首选服务与费用

价格和限额为调研日页面值，实际启用前按服务商当前套餐复核。Credits 不等于所有接口都消耗一次请求的统一计数。

| 服务               | 适合承担的部分                                       | 开发起步条件                                                                               |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Helius             | 标准 RPC、交易发送与确认；可选优先费估算和资产元数据 | Free 每月 100 万 credits、10 次 RPC/秒、1 次 `sendTransaction`/秒；Developer 为 49 美元/月 |
| Jupiter Tokens V2  | Token 名称、图标和收录信息                           | 无 Key 为 0.5 RPS；免费 Key 为 1 RPS；按 Mint 批量查询最多 100 个                          |
| Alchemy、QuickNode | RPC 替代选项                                         | 在端点覆盖、限流或实际稳定性不符合需求时比较                                               |

Helius 可先用于开发和初期联调，标准费用接口不足时再评估 `getPriorityFeeEstimate`；无需为了连接功能先购买套餐。[Helius 价格](https://www.helius.dev/pricing)、[优先费估算](https://www.helius.dev/docs/api-reference/priority-fee/getpriorityfeeestimate)

Jupiter 的批量查询和本地缓存适合钱包元数据加载。限流按服务实际窗口处理，不能把 0.5 RPS 简化成允许瞬间并发 30 次。[Jupiter 接入与套餐](https://developers.jup.ag/docs/portal/setup)、[限流规则](https://developers.jup.ag/docs/portal/rate-limits)、[Mint 批量查询](https://developers.jup.ag/docs/tokens/token-information)

## 模拟和解析的扩展服务

单笔交易优先使用标准 `simulateTransaction`，无需专用模拟订阅。需要核实目标端点是否返回预期的账户前后余额、Token 余额和内部指令等字段；缺失字段不能当成零变化。[标准模拟接口](https://solana.com/docs/rpc/http/simulatetransaction)

批量签名不额外依赖服务，但相互依赖的交易不能分别独立模拟后当作顺序执行结果。例如第一笔创建账户、第二笔使用该账户，需要共享前序执行状态。以后遇到这种需求可评估 QuickNode `simulateBundle`，它要求启用 Lil' JIT 插件；模拟 bundle 不等于承诺后续一定以原子 bundle 发送。[QuickNode simulateBundle](https://www.quicknode.com/docs/solana/simulateBundle)

基础 SOL、SPL Token 和 Token-2022 指令优先本地解析。其他程序可以补充链上 IDL 或 IDL Explorer 的元数据，并区分程序升级权限持有人发布的描述和第三方描述。IDL 解释字段，并不证明程序实际行为或安全性。[IDL Explorer](https://idl.solana.com/docs)

源码匹配可查询 OtterSec 的 verified builds 结果。这项证明关心源码构建产物是否匹配已部署程序，与 Token 收录、用户的信任标记、是否签过某个程序分别记录。程序升级后需要重新确认匹配关系。[Solana 程序验证指南](https://solana.com/docs/programs/verified-builds)

## Monoid 接入安排

1. 复用现有扫码、站点信息、账户选择和 Session 页面，先接通 Solana namespace 的授权与账户管理。地址保留大小写，不能沿用 EVM 的小写比较规则。
2. 接入消息签名与 SIWS 审阅，复用卡片签名流程；交易签名保持原始 message 字节，不通过重新编译悄悄改变签名内容。
3. 选择一个 RPC，打通 SOL、SPL Token 的交易审阅、模拟、签名、广播和确认，再扩大程序解析范围。
4. 拟将需要 API Key 的上游请求放到现有 Cloudflare API 后面，统一管理密钥、限流和 Token 元数据缓存。按网络与 Mint 区分缓存；交易广播不进入通用响应缓存。这里是后续部署方案，并非已经创建新服务。

2026-10-18 接入进展：消息、单笔与批量交易签名、签名并发送已接通，交易支持 legacy / v0，保留原始 message、blockhash 和已有共同签名。批量中同一笔交易匹配多个授权账户时，由用户在审阅页选择；只在全部签名完成后回复网站。签名并发送要求所有必需签名完整，广播被 RPC 接收后返回交易标识，进入 Transaction 页面追踪确认状态、Slot 和手续费，并提供 Explorer 链接。

经典 SPL Token 已增加 Transfer、TransferChecked、Approve、ApproveChecked、Revoke，以及关联 Token 账户的 Create / CreateIdempotent 审阅。展示签名中的 Token account 地址、执行权限账户及多签账户，不以 owner 钱包地址替换真实来源或目标账户。checked 指令以签入的 Mint、小数位和原始金额为准；unchecked 指令仅在账户状态可确定时通过链上账户补全 Mint 和小数位，否则展示 base units。链上数据与签入内容不符时提示，读取失败不改写签名，也不阻断原始内容审阅。关联账户创建校验 PDA 和程序，可供同一交易后续指令补全信息；未知指令可写入的账户不参与状态推断，批量签名也不假定网站的执行顺序。Revoke 不猜测原 delegate，最大 SPL 授权金额不显示为 Unlimited。

主网 Token 名称和图标已接入可选的 Jupiter 元数据查询，按精确 Mint 匹配经典 Token Program；成功结果持久缓存 24 小时，缺失或失败间隔 5 分钟重试。请求串行、起点至少相隔 2 秒，每批最多 100 个 Mint。服务商小数位不作为签名金额依据，不匹配时保留原始 Token 展示；devnet / testnet 不套用主网名称。尚未接入 Token-2022 专用审阅和 Solana 本地交易历史，未知指令继续展示程序、账户权限及原始数据。

签前模拟与预期手续费已接入交易审阅页。`simulateTransaction` 使用完整原始交易字节，设置 `sigVerify: false`、`replaceRecentBlockhash: false`，不替换 blockhash 或重新编译消息；优先展示同一次模拟返回的有效 fee，缺失时使用原始 message 的 `getFeeForMessage` 结果。费用不可用时不显示零。详情可查看执行状态、Compute units、Slot、日志并刷新。请求过期后停止模拟并隐藏费用操作。

模拟失败、RPC 不可用或费用缺失采用黄色警示，等待本轮检查完成后仍允许签名。模拟结果不保证实际执行结果：链上执行失败会回滚指令的转账、授权等状态变化，但仍可能收取手续费；模拟失败的交易也可能在状态变化后成功执行。批量请求最多两笔并发，每笔独立模拟，不继承前一笔的状态，并在页面提示此限制。当前未推导模拟资产净变化。[Solana 交易与失败语义](https://solana.com/docs/core/transactions)

广播前持久化完整签名后的交易，重试复用相同字节；响应丢失时先查询签名状态，已经被接收的交易只重试网站回复，不再刷卡或重复发送。默认启用 RPC preflight，沿用请求提供的发送选项，不替换过期的 blockhash。新方法需要网站重新连接授权。[WalletConnect 发送接口](https://docs.reown.com/advanced/multichain/rpc-reference/solana-rpc#solana_signandsendtransaction)、[Solana 广播语义](https://solana.com/docs/rpc/http/sendtransaction)

本地测试已覆盖请求绑定、共同签名、持久化恢复、丢失响应和 Relay 重试；浏览器使用模拟卡片与 RPC 验证了审阅、发送和确认页面。三个网络的 Reown RPC 均用空交易探测确认发送方法可达，没有广播有效交易；真实卡片与链上发送仍待设备联调。

本轮 SPL 测试覆盖指令布局、权限和多签、ATA 派生、链上账户补全、精度冲突及未知写入；元数据测试覆盖主网隔离、精确匹配、离线缓存、限流与非阻断失败。Jupiter 已用主网 USDC 做无 Key 只读查询，返回正常；这不等同于 SPL 真实卡片签名或链上发送验证，设备联调仍需分别完成。

签前模拟验证覆盖原始字节、部分签名、错误分类、费用回退和取消。浏览器以模拟 RPC 和卡片核对成功、失败、不可用、混合批量结果、刷新、过期和旧请求结果隔离，确认失败后仍签署原始消息。Reown devnet 已用公开测试账户做只读 RPC 验证：模拟成功、余额不足与无效 blockhash 均得到预期响应，费用为 5000 lamports 或明确不可用；没有实际签名或广播，真实设备与主网模拟尚待联调。

地址查找表使用现有 Project ID 的 [Reown Blockchain API](https://docs.reown.com/cloud/blockchain-api)。已带实际开发 Origin 验证 mainnet、devnet、testnet 的 genesis 与 getMultipleAccounts；没有查找表时无需读取表，但 SPL 审阅仍可能需要 Token account / Mint 查询。读取前验证网络，校验表的所有者、布局、激活范围与索引；正在停用的表暂时拒绝，后续补 SlotHashes 冷却期判断。

官方版本文档包含 v1，但当前接入明确拒绝；不能据此推断所有 SDK、WalletConnect 客户端、目标网络和 RPC 都已兼容。后续需分别验收新版本的解析、模拟字段、费用和返回格式，不套用另一版本解码。[交易版本](https://solana.com/docs/core/transactions/versioned-transactions)
