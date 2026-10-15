# EVM：签名前的数据解析、权限解释与签名封装

调研日期：2026-10-14。范围为钱包收到的待签名请求，包含交易、消息、结构化授权与账户抽象；并非从一个已有签名反推出原文。以下属于候选方案，未修改 Monoid API，也未做真卡签名或链上交易验证。

## 结论

EVM 可以复用成熟库完成交易封装、ABI 解码和签名摘要计算，但没有一个通用函数能把任意 `bytes` 可靠地转换为“用户实际同意的行为”。根据本次需求补充，重点应是**签名前模拟事务结果**：以真实链状态上的执行为中心，结合本地确定性解析、ABI/元数据和协议规则，把结果解释为资产变化、授权变化和失败原因。未知协议仍可显示执行证据与原始状态变化，但不能生成貌似确定的业务结论。

Megnat 已有 ethers v6、外部签名器、ABI/代理/4byte 解码的可参考代码；其现有解码结果、`verified` 标记和 RPC 方法兼容性不能直接作为新的安全边界，详见 [Megnat 源码分析](./megnat-reference.md)。跨链解码服务、模拟服务和 ERC-7730 的位置见 [生态方案](./ecosystem-solutions.md)。

## 1. 先确定签名对象

| 请求类别               | 解析输入                                    | 能确定的内容                                                | 主要边界                                       |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| 普通交易               | JSON 交易对象或序列化交易                   | 链、发送者/目标、value、nonce、费用字段、calldata、交易类型 | calldata 的实际语义依赖代码和执行状态          |
| `personal_sign`        | 原始消息字节                                | EIP-191 消息、可读文本、字节长度；符合格式时进一步识别 SIWE | 可读文本仍可能是业务授权，不自动等于登录       |
| 原始摘要签名           | 32 字节摘要及明确的签名语义                 | 摘要本身、算法、指定签名账户                                | 摘要不可逆，无法恢复交易、订单或权限           |
| `eth_signTypedData_v4` | `domain`、`types`、`primaryType`、`message` | EIP-712 类型和值、domain separator、最终摘要                | 类型和字段名由请求方给出，不证明合约按字面执行 |
| EIP-7702 authorization | chain ID、delegate 地址、nonce              | 委托谁作为账户代码、适用链及授权 nonce                      | 与外层交易是不同签名；可能长期改变账户行为     |
| ERC-4337 UserOperation | 完整 UserOp、EntryPoint、版本、账户实现     | 账户调用、费用/赞助字段及相应摘要                           | 用户签名验证策略属于账户实现，非通用 EOA 交易  |

### 消息：EIP-191、`personal_sign` 与 `eth_sign`

`personal_sign` 的摘要为 `keccak256(0x19 || "Ethereum Signed Message:\n" || decimalByteLength || messageBytes)`。长度必须按字节计算；`"0x4243"` 这段 UTF-8 文本与两个字节 `0x42 0x43` 是不同消息。EIP-191 还定义 intended-validator 和 EIP-712 对应的版本，不应把所有 EIP-191 数据当普通文本。[EIP-191](https://eips.ethereum.org/EIPS/eip-191)、[ethers hashMessage](https://docs.ethers.org/v6/api/hashing/#hashMessage)

`eth_sign` 存在真实的实现语义差异：ethereum.org 的 JSON-RPC 文档描述带消息前缀的签名，而 MetaMask 的历史实现支持无前缀的任意摘要签名，其 MIP-3 已决定停止支持。**适配器必须明确方法、参数顺序和摘要规则；既不能统一当 raw digest，也不能静默改成 personal-sign。** 对来源不明的 `eth_sign` 请求，候选策略是拒绝；若产品确需原始摘要签名，应单独定义支持范围和展示策略。[Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_sign)、[MetaMask MIP-3](https://github.com/MetaMask/metamask-improvement-proposals/blob/main/MIPs/mip-3.md)、[当前签名指南](https://docs.metamask.io/metamask-connect/evm/guides/sign-data/)

文本展示应保留完整字节，严格验证 hex/UTF-8，显式显示控制字符与不可见字符，避免丢弃无效编码后显示一段与签名不对应的文本。地址正则只能辅助定位文本，不能识别 spender、收款人或权限范围。

### EIP-712 与 SIWE

EIP-712 的摘要为 `keccak256(0x1901 || domainSeparator || hashStruct(message))`。应验证完整类型图、数组、整数范围和 `primaryType`，按类型显示地址/原始数值，并展示 domain 中实际存在的链 ID、verifying contract、名称、版本、salt。协议本身不提供 nonce/过期机制；字段是否具备重放防护须由具体协议判断。不要因 JSON 可读或 domain.name 像知名协议就判为可信。[EIP-712](https://eips.ethereum.org/EIPS/eip-712)

SIWE 是可机器识别的登录消息格式，应按 ABNF 解析并核对 domain/origin、URI、账户、chain ID、nonce、issued-at，以及存在时的 expiration/not-before/resources；不能仅匹配“wants you to sign in”字符串。钱包能核对会话来源与消息作用域，服务端仍须验证 nonce、新鲜度和签名；这些不是仅靠离线解码就能完成的。[ERC-4361](https://eips.ethereum.org/EIPS/eip-4361)

## 2. 交易封装与摘要

支持范围应逐种声明，不能“先转为普通交易对象，再忽略不认识的字段”。保留收到的原始对象/字节，并在补全 nonce、费用或解析地址后生成最终待批准快照。

| 类型                 | 应保留和展示的差异                                                                  | 规范                                                |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| Legacy / EIP-155     | gasPrice；是否带链重放保护；合约创建时 `to` 为空                                    | [EIP-155](https://eips.ethereum.org/EIPS/eip-155)   |
| Type 1               | access list 也是签名输入；不能默默丢弃                                              | [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930) |
| Type 2               | maxFeePerGas、maxPriorityFeePerGas；费用上限与预计费用不同                          | [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) |
| Type 3               | maxFeePerBlobGas、blob versioned hashes；交易签名载荷与网络传输的 blob sidecar 分开 | [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844) |
| Type 4               | authorization list 加外层调用；逐项解析授权者、delegate、chain ID、nonce            | [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) |
| 其他未来/L2 专用格式 | 精确识别类型；未支持则报告“不支持的交易类型”，不能改写为其他类型                    | [EIP-2718](https://eips.ethereum.org/EIPS/eip-2718) |

EIP-7702 授权签名的摘要是 `keccak256(0x05 || rlp([chain_id, address, nonce]))`；`chain_id=0` 允许跨链使用。delegate 设置具有持续性，外层执行回滚也不会撤销已处理的委托。UI 必须把“账户代码委托”和随附的转账/调用同时呈现；未知 delegate 不能按普通登录签名处理。清除委托也是独立行为。[EIP-7702 授权处理与安全考虑](https://eips.ethereum.org/EIPS/eip-7702#behavior)

ethers v6 的 `Transaction.from`、`unsignedHash`、`unsignedSerialized`、`serialized` 提供编码/摘要基础；当前文档也包含 authorization 支持。它们不能证明一个旧版本具备这些能力，也不能保证业务入口保留了所有字段。[ethers Transaction](https://docs.ethers.org/v6/api/transaction/)

## 3. calldata：从 ABI 解码到业务解释

ABI 给出函数选择器和参数编码，**不携带函数名/参数名的可信来源，也不描述执行效果**。4 字节 selector 可以冲突；即便参数可以解码，也不能证明目标实际实现该函数。动态数组、tuple 和 bytes 的嵌套需要完整处理；`abi.encodePacked` 及自定义字节流并不具有通用可逆结构。[Solidity ABI 规范](https://docs.soliditylang.org/en/latest/abi-spec.html)

建议按以下来源进行解析，并保存每项结论所依赖的证据：

1. 已知协议规则与固定 ABI：适合 ERC-20/721/1155、明确版本的路由器和账户合约。匹配条件至少包括 chain ID、目标地址/代码身份、selector、参数约束；不能只匹配函数名。
2. 经验证合约的 ABI：Etherscan v2 的 `getabi` 显式要求 chain ID；Sourcify 可提供源码/编译产物匹配信息。标签应表达“ABI 来源/匹配等级”，不能表达“交易安全”。[Etherscan getabi](https://docs.etherscan.io/api-reference/endpoint/getabi)、[Sourcify Exact Match 与 Match](https://docs.sourcify.dev/docs/exact-match-vs-match/)
3. 代理解析：在同一链、同一区块上下文读取实现/Beacon，记录代理与实现地址、代码身份和 ABI 来源。EIP-1967 implementation slot 只覆盖一部分代理；还需决定 Beacon、minimal proxy、Diamond 等是否支持，未知结构保留未解析状态。[ERC-1967](https://eips.ethereum.org/EIPS/eip-1967)
4. selector 目录：仅提供候选函数签名和可能参数；多候选应保留歧义，不能取第一个成功解码的结果作为事实。Sourcify 的 4byte 服务是一个候选来源，和其源码验证 API 是不同服务。[Sourcify API](https://docs.sourcify.dev/docs/api/)

ABI/元数据缓存应包含 chain ID、目标地址、实现地址、代码身份和区块信息。代理升级或委托变化会使旧解释失效。失败状态要区分未验证、未找到、离线、限流、格式错误和解码失败。Sourcify 官方文档在本次调研时明确：v1 API 已于 2026-07-07 关闭，新集成应查 v2。[Sourcify API](https://docs.sourcify.dev/docs/api/)

`multicall(bytes[])`、钱包的 `execute`/`executeBatch`、router 的命令流需要**按具体协议**递归展开。目标合约、value、调用方式和子调用顺序都应保留；不能把任意 `bytes` 自动当下一层 calldata。`delegatecall` 的存储/权限上下文与普通 `call` 不同。设置最大字节数、数组长度、递归深度和总节点数，避免解析器或展示界面被超大载荷拖垮。这是基于 ABI 能力边界提出的工程建议，具体路由协议必须另取其官方 ABI/源码验证。

## 4. 应优先解释的高价值授权

| 行为                               | 核心展示内容                                                       | 不能混淆的含义                                                            |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| ERC-20 `transfer` / `transferFrom` | token 地址、from/to、原始数量、经核验 decimals 后的数量            | token 符号不是身份，`transferFrom` 的执行者与资产所有者可能不同           |
| ERC-20 `approve`                   | token、spender、授权额度，明确撤销/有限/最大值                     | 设置额度，不是本次立即转账                                                |
| ERC-721 `approve`                  | collection、token ID、被授权地址                                   | 一个 NFT 的转移权限                                                       |
| ERC-721/1155 `setApprovalForAll`   | collection、operator、true/false                                   | operator 对该 collection 的整体操作权限，不是单个 token                   |
| ERC-2612 `permit`                  | owner、spender、token/domain、value、nonce、deadline               | 链下签名也能授予链上花费能力；签名过期时间不等于既有 allowance 的过期时间 |
| Permit2 AllowanceTransfer          | token、spender、amount、expiration、nonce、sigDeadline，完整 batch | 签名提交期限与生效后的 allowance 期限分别展示                             |
| Permit2 SignatureTransfer          | token、最大可用量、spender、nonce、deadline、witness，完整 batch   | 一次性签名授权；基础 permit 不保证已绑定最终收款人                        |

前三类代币行为依据 [ERC-20](https://eips.ethereum.org/EIPS/eip-20)、[ERC-721](https://eips.ethereum.org/EIPS/eip-721)、[ERC-1155](https://eips.ethereum.org/EIPS/eip-1155)。ERC-2612 的字段和语义依据 [ERC-2612](https://eips.ethereum.org/EIPS/eip-2612)。

Permit2 有“token 合约授予 Permit2 的 allowance”和“Permit2 管理的具体 spender 权限”两个层次，必须分开展示。`SignatureTransferDetails.to/requestedAmount` 来自执行调用，基础签名中的 token/额度不是最终收款保证；witness 可以增加已签上下文，但仍须识别其类型和调用方校验。不能将“无 gas 的签名”描述成没有资产风险，也不能仅凭 `primaryType=Permit` 判断属于哪个协议。[Permit2 概览](https://developers.uniswap.org/docs/protocols/permit2/overview)、[SignatureTransfer](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer)

注意区分 Solidity 调用参数结构和实际 EIP-712 类型：Permit2 的 SignatureTransfer 摘要包含 spender，尽管函数参数中的 `PermitTransferFrom` struct 没有这个字段；实现将调用者上下文纳入摘要。因此应解析真正被签的 typed data，并与对应部署代码核对，不能单靠一个函数参数 ABI 重建全部授权含义。[PermitHash.sol](https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol)

## 5. ERC-4337 与合约钱包签名

UserOperation 应作为独立请求类型解析，显示 sender、EntryPoint、nonce、factory/initCode、账户 callData、费用上限和 paymaster。账户的执行函数再按其实现递归展开；不能把 UserOp 包装成普通转账。当前 ERC-4337 规范包含 EIP-712 UserOp 摘要及 7702 扩展，但已部署的 EntryPoint 版本可能采用不同封装，账户验证签名的方法也可能不同。[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337)

viem 当前主分支的 `getUserOperationHash` 对 0.6、0.7 和 0.8/0.9 采用不同路径，说明版本是解析上下文的一部分。落地时应锁定具体库版本、EntryPoint 地址/代码及账户适配器，禁止“猜一个通用 userOpHash”。本次只核查文档和源码，未验证任何线上 EntryPoint 部署。[viem getUserOperationHash 源码](https://github.com/wevm/viem/blob/main/src/account-abstraction/utils/userOperation/getUserOperationHash.ts)

EOA 的 `recoverAddress` 只能核对 ECDSA 签名对应的 EOA。合约账户要依赖其链上验证逻辑，例如 ERC-1271 `isValidSignature`；返回的是合约状态下的有效性结论，不能把 owner 的 EOA 签名恢复结果当作合约账户验证结果。[ERC-1271](https://eips.ethereum.org/EIPS/eip-1271)

## 6. TypeScript 候选库

| 方案                         | 可复用能力                                                                            | 对 Monoid 的价值与限制                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ethers v6                    | `Interface.parseTransaction`、`AbiCoder`、`TypedDataEncoder`、`Transaction`、签名恢复 | 与 Megnat 思路一致，外部 signer 适配直接；需重构独立解析层，补元数据来源与语义规则       |
| viem                         | `decodeFunctionData`、`hashTypedData`、交易解析、AA 工具                              | 适合函数式模块和类型明确的适配器；不能用静态 TS 类型替代对不可信 JSON 的运行时校验       |
| `@metamask/eth-sig-util`     | personal-sign、EIP-712 的签名/恢复工具                                                | 可作为兼容性参考及交叉测试实现；它不是交易意图解释器，签名私钥工具不能直接替代外部签名器 |
| 自行实现全部 RLP/ABI/EIP-712 | 能完全控制接口                                                                        | 不建议作为首选；更应把开发投入放在输入验证、来源证据、业务语义和签名绑定                 |

能力依据：[ethers ABI](https://docs.ethers.org/v6/api/abi/)、[ethers hashing](https://docs.ethers.org/v6/api/hashing/)、[viem decodeFunctionData](https://viem.sh/docs/contract/decodeFunctionData)、[viem hashTypedData](https://viem.sh/docs/utilities/hashTypedData)、[viem parseTransaction 源码](https://github.com/wevm/viem/blob/main/src/utils/transaction/parseTransaction.ts)、[MetaMask eth-sig-util](https://github.com/MetaMask/eth-sig-util)。此次未安装新库、测量包体积或执行 Capacitor/WebView 兼容性测试。

候选选择：若以复用 Megnat 为优先，可以先用 ethers v6 进行 EVM 原型；若 Monoid 新模块更重视独立函数和 AA 扩展，可评估 viem。没有证据支持仅为解析能力同时引入两套完整 SDK。ERC-7730 描述符可扩展语义显示，但当前标准与部署范围仍需单独评估，见 [生态方案](./ecosystem-solutions.md)。

## 7. 与外部签名器的边界及验收样例

解析应发生在摘要产生之前。用户确认的最终对象、待签名原文/摘要、所用 chain ID、算法与密钥必须形成一个不可变的批准记录；更改 nonce、费用、to/data、EIP-712 domain 或代理解析上下文后，应重新生成展示与批准。返回签名后，按所选编码组装并核对 EOA 地址；low-s、recovery parity 和交易 `v` 编码由明确的库/协议路径处理。只收到摘要的设备无法自行恢复上述语义；这是可信展示能力的边界，而不是补一个 ABI 库就能解决的问题。

以下是建议进入后续原型的验收样例，**本次未执行**：

| 样例                                                                       | 预期结果                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 相同可见文本，不同 Unicode/控制字符；hex 字符串与字节                      | 展示和摘要保留差异；不做隐式归一化                            |
| EIP-712 官方 Mail 向量、嵌套数组、大整数、缺失/额外 domain 字段            | 与固定版本的独立实现交叉核对；不能发生 JS number 精度丢失     |
| SIWE domain 与 WalletConnect 来源不一致、nonce 缺失、过期、resources 存在  | 给出具体不匹配/未验证状态；完整签名内容可查看                 |
| 同地址不同链、代理 ABI 缺失/implementation 改变、selector 多候选           | 不串用缓存；未找到 ABI 时仍可尝试已支持代理；歧义不升级为可信 |
| `approve(max)`、`setApprovalForAll(true)`、ERC-2612、Permit2 batch/witness | 显示不同授权范围、全部条目、期限与实际被签字段                |
| multicall 里含未知调用、嵌套自定义 bytes、超深数组                         | 已解析与未知部分同时呈现；超限得到明确错误                    |
| legacy/1/2/3/4、未知类型、合约创建                                         | 不丢签名字段；类型不支持时不转换为普通交易                    |
| 7702 chainId=0、清除委托、外层调用失败                                     | 解释跨链适用、清除动作和独立的委托持久性                      |
| 不同 EntryPoint 版本、不同账户签名方案                                     | 仅明确支持的组合产生摘要；不能靠 ABI 解码成功判定可签         |
| 确认后修改 payload、外部 signer 返回错误账户签名                           | 批准失效或组装失败；不能继续发送                              |

## 8. 重点方案：签名前模拟事务结果

跨链选型见 [模拟方案总览](./simulation.md)。本节说明 EVM 后端需要实际执行什么，以及怎样把执行结果变为用户可判断的结果。模拟应回答“这份确定的请求，在某一链状态和上下文下会产生什么变化”，而不是仅返回“success”或“ABI 已识别”。

### 8.1 执行接口不是同一种能力

| 能力                                                | 可获得结果                                                               | 适合用途                                 | 不能据此声称                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| `eth_call`                                          | 返回字节或 revert data                                                   | 单次执行是否成功、返回值、自定义错误     | 没有标准化的完整资金流/状态差分；也不验证普通外层交易签名                  |
| `eth_estimateGas`                                   | 可完成执行所需 gas 的估算                                                | 费用准备、发现部分执行错误               | 不是资产变化分析，也不是最终 gas/成交结果保证                              |
| `debug_traceCall` + `callTracer`                    | 调用树、子调用、错误；可配置日志                                         | 解释嵌套调用、内部 ETH 转移、回滚位置    | 不是自动解码好的全部资产/授权变化                                          |
| `debug_traceCall` + `prestateTracer(diffMode=true)` | 修改账户的 pre/post 原始状态，包括 balance/code/storage 等               | 取得状态变化证据                         | storage slot 不会自动变成 allowance、债务或 NFT 所有权；结果没有密码学证明 |
| `eth_simulateV1`                                    | 连续执行多笔 call、继承前一步状态；返回每步状态、gas、日志和 return data | approve → swap、按序批量请求、多区块假设 | 普通 JSON-RPC batch 不能替代它；也不是所有 RPC 商均已开放                  |
| 专门模拟服务                                        | 视服务提供 trace、状态差分、资产变化、逐步 bundle 结果                   | 快速实现钱包可读结果                     | 不能从宣传页推定所有链/交易类型/权限都受支持                               |

接口事实分别依据 [Execution APIs eth_call](https://ethereum.github.io/execution-apis/api/methods/eth_call/)、[eth_estimateGas](https://ethereum.github.io/execution-apis/api/methods/eth_estimateGas/)、[Geth debug_traceCall](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug#debug_tracecall)、[Geth 内置 tracers](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers)、[Execution APIs eth_simulateV1](https://ethereum.github.io/execution-apis/api/methods/eth_simulateV1/)。

同一个确定的请求可以分别运行 `callTracer` 和 `prestateTracer`，但必须固定相同的链、区块/交易位置、完整 call 字段与 overrides，不能分别对两个 `latest` 结果做无条件拼接。`debug_traceCall` 还支持 `txIndex`、state/block overrides；客户端具体状态起点与区块上下文应以固定版本和重放样例核对，而不是混用不同服务对“block N”的解释。[Geth tracing API](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug#debug_tracecall)

Geth 的 `eth_simulateV1` 默认 `validation=false`，语义接近 eth_call；设为 true 后增加交易有效性检查，但文档明确仍不做 contract-sender 和签名检查。`traceTransfers=true` 把原生 ETH 转移作为 emitter 为 `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` 的合成 Transfer 日志返回，应标为模拟器生成的原生币证据。它不是 ERC-20 合约真实发出的事件。[Geth eth_simulateV1](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth_simulatev1)

### 8.2 用户应看到哪些结果

建议结果至少有五类，并可展开到对应执行证据：

1. **执行状态与失败原因**：成功、revert、out-of-gas、RPC 超时、不支持方法、状态不可用分别表示。保存 raw revert data；有匹配 ABI 时解码 custom error。一个子调用失败但被外层捕获，不应等同整笔失败。
2. **资产净变化**：以用户控制的 EOA/智能账户为观察对象，分别显示原生币、ERC-20、ERC-721、ERC-1155 的变化；列出 token 合约地址、精确数量、NFT ID 和交易对方。操作历史与净变化分开，避免只显示“转出再转入后为零”而隐藏中间授权。
3. **权限和账户控制变化**：allowance、operator approval、Permit2 权限、代理升级/账户 owner 或 module 更新、7702 delegation。余额未变不能归类为“无影响”。
4. **费用**：预计执行 gas 与上限分开，注明 ETH 净变化是否已含费用；L2 data fee、blob fee、paymaster token 扣费另核对实际引擎覆盖，避免漏计或重复扣除。
5. **上下文与不确定性**：链、基准区块 hash/number、模拟时间、引擎版本、采用的假设、未知状态变化、覆盖不全的协议。把“没有观察到资产变化”和“无法确定资产变化”作为不同结果。

这些是建议的产品输出，不是任何单一节点 RPC 的现成返回 schema。代币/权限语义依赖前述 ERC 规范；模拟器只能证明其已执行分支中的结果，不能穷举授权之后所有可能调用。

### 8.3 资产解释不能只依赖日志

Transfer/Approval 日志可提供候选资产与账户列表，但恶意合约可以发出误导性日志，不标准的代币、rebasing/fee-on-transfer 逻辑也可能使简单的事件求和不等于余额变化。对已识别资产，应优先核对同一执行状态前后的 `balanceOf`、`ownerOf`、`allowance`、`isApprovedForAll` 或协议专用读数；这需要引擎提供 pre/post 状态查询，或服务明确提供经过何种计算的 balanceChanges。

`prestateTracer` 返回的 storage 差分是有价值的证据，但未知布局无法通用地逆推出用户金额；不得按几个硬编码 slot 假装支持所有 ERC-20。若采用自建后端，可以维护可克隆的执行状态，分别在执行前后做只读查询；这属于额外的资产解释实现，不能把 Geth 的 `eth_simulateV1` 直接宣称为现成资产变化 API。必须正确处理 tracer 中缺失字段、插入、删除与置零的语义。[Geth prestateTracer](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers#prestatetracer)

同样，不能把 trace 中进入过某个子调用或暂时写过某个 slot 就视为最终生效；回滚的子树/整笔回滚要结合最终状态区分。合成 ETH 事件、真实合约事件、状态读数和 ABI 推断应具有各自来源标签。

### 8.4 顺序事务、原子 multicall 与 UserOperation

- **多笔交易**：approve → swap 要继承前一步模拟状态；同时展示每一步和累计结果。把两笔交易塞进 JSON-RPC batch 并分别 eth_call 不会获得这种语义。按序模拟成功也不保证链上按序打包，更不赋予多笔交易原子性。
- **同一交易内的 multicall**：模拟真正的外层调用，保持 caller、value、delegatecall/call 和协议允许失败的标记。不能把内部 calldata 拆成多笔从用户地址发出的独立交易，那会改变权限和回滚语义。
- **ERC-4337**：先确认 EntryPoint 版本、账户实现、factory、paymaster 和实际签名验证策略，再走对应 bundler 的验证/估 gas及完整执行模拟。验证阶段成功不等于执行成功；仅模拟账户内部 `execute` 会绕开 EntryPoint/account/paymaster 的真实路径。模拟的 account/paymaster 时间范围、7702 授权与最终 UserOp 均须绑定。[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337)

以上关于序列的能力依据 [eth_simulateV1](https://ethereum.github.io/execution-apis/api/methods/eth_simulateV1/)。第三方 bundle 服务也需要核查是在同块连续执行、跨块执行还是仅聚合独立结果，不能仅因名称带 bundle 就假设其回滚、nonce 和失败后继续行为一致。

### 8.5 链下签名与 7702 的特殊困难

未签名普通 EOA 交易可以用 `from` 构造 call 模拟，但 permit、订单、智能钱包等往往在**执行过程中**调用 ecrecover/合约验签；签名前不存在有效签名，不能直接保证完整链上执行会通过。候选处理应是：先准确解析被授予的权限；在明确协议适配器下，构造“签名有效”假设的模拟；签后如再校验，必须在释放给 dApp/广播之前完成，并保持批准载荷不变。不要为获取一次模拟结果先无条件发出具有花费效力的签名。

Geth overrides 允许改代码/状态，甚至替换 ecrecover precompile；这是情景分析能力，**不能把绕过验签后成功称作已验证授权**。通用改写 ecrecover 还可能影响同笔执行中的其他验签，必须限制用途并公开假设。[Geth State override set](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set)

7702 需要同时观察 delegation/code 变化和外层执行。其委托可能在执行失败时仍然生效，后续影响也可能超出本次余额变化。规范的通用 call 对象已包含 authorizationList，但具体 RPC/引擎是否按目标分叉和签名规则处理，仍要用清除委托、跨链授权及执行回滚向量验证。[Execution APIs 交易对象](https://ethereum.github.io/execution-apis/api/methods/eth_estimateGas/)、[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702#behavior)

### 8.6 State override 必须与真实预览分开

余额、nonce、代码、storage、timestamp、base fee 等 override 能回答“如果先有足够余额/完成授权/升级实现会怎样”。它们不能回答“按用户现在的真实状态能否执行”。默认预览应不改余额、授权或代码；任何 override 都记录完整值和原因，并使 UI 明确进入假设模式。`state` 是替换整份账户 storage，`stateDiff` 仅覆盖指定 slot，二者误用会制造完全不同的执行环境。[Geth overrides](https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set)

批准记录应绑定完整 payload、观察账户、网络/分叉、基准区块、引擎配置、overrides 和结果指纹。费用、nonce、滑点、deadline、子调用、paymaster 或授权列表任一改变，都要重新判断是否需模拟及重新确认。指定区块模拟是可重放的预测；实际打包时的价格、流动性、nonce、代理实现、时间和排序仍可能改变，不能将模拟结果写成保证。

### 8.7 自建与服务方案的实际边界

**自建节点/执行后端**：有利于控制输入、版本、状态与日志保留，能取得原始 trace/state diff。代价是所需链和历史状态的运维、tracing 资源消耗、链特定分叉，以及资产/权限解释规则的维护。debug/tracing 应作为后端内部能力暴露给受限业务请求；不能假设移动端公共 RPC 免费提供所有 tracer。历史重放需节点确有相应状态或可重建，缺失时返回不可用，而不是换成最新块后沿用历史标签。

**Tenderly 等模拟服务**：官方目前描述单笔模拟、继承前一步状态的 simulation bundles、gas/资产移动/状态变化；因此适合作为快速 PoC 候选，但本次未调用其 API。链范围、授权识别、7702/4337 完整路径、费用是否计入余额、token 解释方法、保存策略、超时/限额与当前价格仍须用目标账号和固定样例验收，不能从产品页推定覆盖。[Tenderly Simulator](https://tenderly.co/products/simulator)、[官方 Simulation Bundles 更新](https://tenderly.co/blog/changelog/preview-multi-step-flows-with-simulation-bundles/)

建议 EVM PoC 以“一个明确链 + 普通 type-2 交易 + ERC-20/721 授权与转移 + 一个真实 swap + 一个按序 approve/swap”为首轮范围，比较专门服务与节点 tracer 的结果。若用户更重视尽快看到事务结果，服务方案可减少初期资产解释工作；是否采用仍取决于固定样例验证与数据/成本边界。

### 8.8 模拟专项验收（待执行）

| 固定样例                                             | 验收重点                                                  |
| ---------------------------------------------------- | --------------------------------------------------------- |
| 普通 ETH 转账与余额不足                              | from/to/value、成功/失败、费用是否已计入净变化            |
| ERC-20 transfer、fee-on-transfer、伪造 Transfer 日志 | 资产身份、实际余额变化与日志推断区分                      |
| approve(max)、setApprovalForAll(true)、撤销          | 即使余额零变化，也显示权限变化和范围                      |
| 固定块的真实 swap、修改滑点/时间/余额的对照请求      | 输出收到/付出、失败原因及 override 假设差异               |
| approve → swap，反转顺序，第一步失败                 | 状态连续性、逐步/总结果、失败后是否继续，不能伪称原子执行 |
| multicall 中某子调用失败但允许继续                   | 正确解释最终生效结果与失败子树                            |
| 未签 permit/订单与有效签名的对照                     | 明确跳过/替代了什么验签；不得无提示泄露有效签名           |
| 7702 委托 + 外层 revert                              | 保留委托变化，不能只显示“失败所以无影响”                  |
| 4337 paymaster/验证通过但执行 revert                 | 阶段区分、费用承担者、版本与账户实现绑定                  |
| 确认后改变任一签名字段，RPC 超时/方法不存在          | 旧结果失效或明确不可用；不能显示空变化等同安全            |
