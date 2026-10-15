# Megnat EVM 实现：可复用部分与不能继承的假设

调研日期：2026-10-14。只读检查本地仓库 `C:\Projects\megnat`，HEAD 为 `5ce4e40d02e3e6af51da0885a7419eb7d8e92c4b`；检查时 `git status --short` 无输出。下文行号对应该提交。源码路径使用绝对本地链接，便于直接查看；此次没有启动 Megnat、请求其业务后端、安装依赖、连接 Tangem 或广播交易。

## 1. 已实现的链路

Megnat 已实现“WalletConnect 请求 → React Native 确认界面 → ethers 编码/摘要 → Tangem 卡签摘要 → 补 recovery bit → 返回签名/发送交易”的 EVM 流程。它具有实际参考价值，但解析逻辑主要嵌在 UI 内，还不是可直接移入 Monoid 的通用签名解析组件。

**针对本次重点“模拟事务结果”，Megnat 目前只能提供请求解析和 UI 思路参考。** 对 `src` 全部源码检索模拟/trace/资产差分相关调用，找到的是第 188 行 `signer.estimateGas(transaction)`，未发现 `eth_simulateV1`、traceCall、状态差分或资产变化的应用层实现。因此不能把既有 ABI 解码和估 gas 表述为已经实现事务结果预览；新增模拟能力还需要执行后端和结果解释层。[估 gas 调用](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:188)

依赖声明为 ethers `^6.13.5`、`@reown/walletkit ^1.2.2`，应用采用 Expo/React Native；这仅是 package.json 声明，不代表实装版本或当前 SDK 能力。[package.json](C:/Projects/megnat/package.json:19)

| 功能           | 源码证据                                                                                                                                                                | 实际行为                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 请求方法路由   | [view-request.tsx](C:/Projects/megnat/src/app/view-request.tsx:72)；[wallet-kit-service.ts](C:/Projects/megnat/src/services/wallet-kit-service.ts:28)                   | 支持 sendTransaction、eth_sign、personal_sign、三个 typed-data 方法名称                        |
| 普通消息       | [sign-message.tsx](C:/Projects/megnat/src/components/request-viewer/sign-message.tsx:47)                                                                                | 区分参数顺序；hex 转 Buffer；有效 UTF-8 显示文本，否则显示 hex；提取消息中的地址               |
| 结构化消息     | [sign-typed-data.tsx](C:/Projects/megnat/src/components/request-viewer/sign-typed-data.tsx:43)                                                                          | 解析 JSON，展示 domain.name 与 message；移除 `types.EIP712Domain` 后交给 ethers                |
| 交易确认与费用 | [send-transaction.tsx](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:64)                                                                        | 构造交易对象；获取/修改 gas 与费用；按 legacy/EIP-1559 展示                                    |
| calldata 解码  | [send-transaction.tsx](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:596)                                                                       | 目标 ABI → 部分代理情况查实现 ABI → 4byte 候选 → 原始 hex                                      |
| ABI 类型遍历   | [abi.ts](C:/Projects/megnat/src/utils/abi.ts:3)                                                                                                                         | 用 ethers `ParamType.walk` 从 tuple/array 等参数中提取 address 类型，排除交易 from/to 与零地址 |
| 外部签名器     | [tangem-signer.ts](C:/Projects/megnat/src/core/tangem-signer.ts:39)                                                                                                     | 使用 `Transaction.unsignedHash`、`hashMessage`、`TypedDataEncoder.hash` 请求 Tangem 签摘要     |
| 返回签名核对   | [tangem-signer.ts](C:/Projects/megnat/src/core/tangem-signer.ts:113)                                                                                                    | 尝试 v=27/28，恢复地址与预期 derivation.address 匹配后返回签名，否则抛错                       |
| 会话来源提示   | [session-verification.tsx](C:/Projects/megnat/src/components/session-verification.tsx:26)                                                                               | 显示 WalletConnect Verify 的 scam/domain mismatch/VALID 等状态                                 |
| 会话认证       | [wallet-kit-service.ts](C:/Projects/megnat/src/services/wallet-kit-service.ts:346)；[session-authenticate.tsx](C:/Projects/megnat/src/app/session-authenticate.tsx:153) | 由 WalletKit 格式化认证消息，用 EIP-191 签名，再组装 auth object                               |

## 2. ABI 解码的可借鉴设计

`decodeTransactionData` 第 596 行开始的函数有三个值得保留的思路：优先用合约 ABI；尝试代理实现；无可靠 ABI 时保留低置信度 fallback。解码后返回显示字符串、地址集合和一个 `verified` 布尔值。第 628 行起的 bigint 序列化避免了直接 JSON.stringify bigint 的错误。[源码入口](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:596)

`extractAddressesFromDecodedTransaction` 根据 ABI 类型递归查找地址，比在字符串里扫描 `0x...` 更能说明“这是 address 参数”；但它不区分 recipient、spender、owner、operator 或实现地址，也不会把 bytes 中隐藏的子调用自动拆开。这一函数适合作为类型遍历参考，不适合作为业务意图识别器。[ABI 遍历](C:/Projects/megnat/src/utils/abi.ts:14)

外部 signer 将 Ethereum 编码与 Tangem 接口隔开，并在回填签名前恢复地址检查，这是 Monoid 可参考的结构。应复用“算法/编码层与设备签名层分离”的方式，而不是照搬 Tangem 专属类或将硬件接口扩展成区块链业务 API。[签名适配器](C:/Projects/megnat/src/core/tangem-signer.ts:22)

## 3. 源码中确认的缺口

以下是控制流和字段使用上的静态事实。它们说明移植前需要补足的能力；不等于已经复现了线上损失或设备故障。

### 3.1 ABI 查询没有传链 ID

第 652–654 行请求 `${MEGNAT_API_URL}/etherscan?...&address=...`，只有 address，没有 chainId。解码函数的参数本身也没有 chainId。链 ID 虽在 UI 参数中存在，却没有进入 ABI 查询。后端如何选择链不在本仓库中，不能断言它一定选错链；能够确认的是客户端没有在这条查询上表达链身份。[ABI 查询](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:648)、[后端 URL](C:/Projects/megnat/src/constants/megnat.ts:6)

Monoid 的候选实现应将 chain ID 作为 ABI/代码/代理查询及缓存键的一部分。当前 Etherscan v2 的官方 `getabi` 接口也要求 `chainid`。[Etherscan getabi](https://docs.etherscan.io/api-reference/endpoint/getabi)

### 3.2 代理 fallback 只在 `null` 时发生

第 609 行是 `decoded === null`。`Interface.parseTransaction` 找不到函数时返回 null；但本地 `decodeBySourceCode` 在 HTTP 不成功、接口 status 为 0 或没有 iface 时返回 undefined。因此，**“代理本体没有可用 ABI”不会进入实现地址分支**，而直接退到 selector 目录。[代理分支](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:606)、[undefined 路径](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:652)

实现地址读取只检查 EIP-1967 implementation slot，没有看到 Beacon 分支、递归代理、minimal proxy 或 Diamond 处理，也没有固定查询区块。建议明确列出支持的代理类型，将“ABI 不可用”与“ABI 存在但 selector 不匹配”作为不同状态处理，允许二者按策略进入代理解析。[实现地址读取](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:710)

### 3.3 selector 目录取第一个可解码项

第 681–707 行向 4byte.directory 查询 selector，然后按服务返回顺序逐条构造 Interface，第一条可解码项立即返回。这里没有保留多候选、检查候选是否对应目标代码，或报告歧义。并且 `parseTransaction(...) ?? undefined` 会直接返回，只有抛出异常才继续循环。[selector fallback](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:681)

可复用 selector 查询能力，但结果应标为候选解释，不能变成确定函数身份；地址角色和资金流也不能由候选函数名直接推导。4 字节 selector 和非自描述的 ABI 编码决定了这一边界。[Solidity ABI](https://docs.soliditylang.org/en/latest/abi-spec.html)

### 3.4 `verified` 命名会混淆来源与安全

`verified=true` 表示使用了目标/实现 ABI 进行解码，fallback 则为 false。UI 文案在第 521 行称签名已对照合约源码验证；客户端实际取的是后端返回的 ABI，没有本地重编译/字节码校验，更没有证明行为安全。来源验证、ABI 匹配、代理映射和模拟结果应该分别表达，不能压成一个安全勾。[结果标志](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:606)、[UI 文案](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:515)

### 3.5 `eth_sign` 与 `personal_sign` 共用消息前缀签名

路由把两种方法交给同一个 `SignMessage`。界面只在参数顺序上区分；第 163 行统一调用 `signer.signMessage(data)`，而 `TangemSigner.signMessage` 使用 `hashMessage`。因此 Megnat 当前签的是 EIP-191 personal-sign 摘要，**没有一条 raw-digest 的 eth_sign 路径**。[消息签名调用](C:/Projects/megnat/src/components/request-viewer/sign-message.tsx:150)、[摘要计算](C:/Projects/megnat/src/core/tangem-signer.ts:81)

这不是简单的“所有 eth_sign 都实现错误”：ethereum.org 文档本身描述带前缀的 eth_sign，MetaMask 历史语义则是无前缀摘要签名。移植时必须明确支持哪一类客户端语义，不能因为方法名相同就宣称全面兼容。[Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_sign)、[MetaMask MIP-3](https://github.com/MetaMask/metamask-improvement-proposals/blob/main/MIPs/mip-3.md)

### 3.6 EIP-712 显示与校验不完整

界面展示 chainName、signer、domain.name 和 message。domain 的 chainId/verifyingContract/version、完整 types 和 primaryType 没有在当前主视图展开；复制按钮能复制 dataJSON。`TypedData` 只是 TypeScript 类型断言，未见运行时 schema 校验；`primaryType` 没有传给 signer，ethers 根据类型图处理。没有看到请求链与 domain.chainId 的显式一致性检查、Permit/Permit2 语义识别或金额/期限格式化。[请求处理](C:/Projects/megnat/src/components/request-viewer/sign-typed-data.tsx:43)、[显示](C:/Projects/megnat/src/components/request-viewer/sign-typed-data.tsx:72)、[签名](C:/Projects/megnat/src/components/request-viewer/sign-typed-data.tsx:144)

另外 `eth_signTypedData`、v3、v4 均进入同一路径，源码没有按版本差异选择编码。函数可调用不等于已覆盖这些历史 RPC 变体。候选做法是先明确支持 v4，并以特定变体的规范/向量决定是否扩展；不默认附带历史兼容承诺。[方法分派](C:/Projects/megnat/src/app/view-request.tsx:78)

### 3.7 交易入口只保留常见字段

第 64 行解构收到的参数，第 112–130 行重建交易时只保留 chainId、to、data、value、nonce、gasLimit 和费用字段。没有传递显式 type、accessList、blob 字段或 authorizationList；`to` 被直接传给 `getAddress`，没有合约创建分支。因此，不能根据 ethers 库的底层能力声称 Megnat 入口支持全部交易类型。[参数重建](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:64)

用户点击 Sign 后实际调用 `signer.sendTransaction` 并返回交易 hash，不是仅导出一个签名。费用/nonce 的最终补全过程也需要在 Monoid 原型中核对是否发生在用户确认之前，确保确认视图与最终签名载荷一致。[发送路径](C:/Projects/megnat/src/components/request-viewer/send-transaction.tsx:437)

### 3.8 认证界面隐藏了 Resources

`session-authenticate.tsx` 第 53–56 行对展示文本去掉 `Resources:` 段落，但复制和实际签名使用完整原文。静态上确认了显示内容与完整签名内容之间的差异；Resources 具体是否包含会话权限需要逐个实际 payload 分析，不能断言全部都是敏感权限。Monoid 应将所有被签资源/权限按结构展示，不因列表较长而完全隐藏。[显示文本处理](C:/Projects/megnat/src/app/session-authenticate.tsx:53)、[实际签名](C:/Projects/megnat/src/app/session-authenticate.tsx:165)

### 3.9 方法协商与实际处理范围存在差异

session proposal 第 306–315 行明确接受 required namespace 中的所有 methods，以提高兼容性；实际 session_request 第 90 行只允许 `SUPPORTED_METHOD_SET`。因此可出现会话协商了某方法，收到请求时才拒绝的情况。新解析模块应让“可接受请求类型、可解析类型、可签名类型”各自明确，并避免对外宣称超出实际能力的支持范围。[协商](C:/Projects/megnat/src/services/wallet-kit-service.ts:306)、[请求过滤](C:/Projects/megnat/src/services/wallet-kit-service.ts:87)

## 4. 迁移建议

| 保留思路                                  | 迁移时补足                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| ethers 负责成熟的 ABI/交易/EIP-712 编码   | 固定版本；运行时 schema 校验；大整数/hex/递归边界；严格声明交易/RPC 类型  |
| 本地 ABI → 实现 ABI → selector 候选的流程 | chain ID、区块、代码身份和来源证据；完整失败状态；处理候选歧义            |
| ABI 参数递归遍历                          | 从地址列表扩展到有证据的参数角色；协议化解析 nested bytes 与 batch        |
| 独立的硬件签名适配器                      | 与 Monoid 当前固件算法/输入能力逐项匹配；批准数据与签名输入绑定；本地验签 |
| WalletConnect 来源提示                    | 与 payload、ABI 和执行结果的验证分开；来源验证不等于权限安全              |
| 确认界面展示原文/结构                     | 全量 domain/types/资源、明确授权额度/范围、未知部分可见                   |

不建议直接复制 `SendTransaction`：数据获取、React state、费用修改、解码、UI 与签名/广播耦合在同一文件，且 React Native/Expo 组件不适用于 Monoid 的 Ionic/Capacitor UI。更合适的是提取独立、可在无设备环境测试的解析和摘要逻辑，再接入 Monoid 的确认流程与外部签名器；这仍是研究建议，未批准任何新 API。

## 5. 尚未验证

- `api.megnat.app` 的源码、链路由、ABI 来源校验、缓存和当前可用性均未核对。
- 没有执行依赖安装、构建、UI 测试、Tangem 签名或 WalletConnect 端到端请求。
- 没有评估 Megnat 历史实现是否曾在特定 dApp/链上完成这些请求，也没有把截图当当前运行结果。
- 没有确认 Tangem 返回签名的规范化细节；不能把成功恢复地址的源码分支当作本次设备签名验证。
- 没有修改任何业务文件或依赖；本研究仅新增调研文档。
