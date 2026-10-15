# 解析方案生态与其他链

调研日期：2026-10-14。EVM、BTC、Solana 的具体方案分别见对应文件；本篇比较可复用组件，并用其他链说明通用框架的边界。所有库和服务都是候选，没有新增项目依赖。

## 应当组合的五类方案

| 类别             | 实例                                                      | 能解决什么                       | 需要补上的部分                               |
| ---------------- | --------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| 编解码/签名库    | ethers、viem、bitcoinjs-lib、scure-btc-signer、Solana Kit | 结构、字节、哈希、签名与序列化   | 合约业务含义、用户资产变化、恶意行为识别     |
| 已知协议解析器   | ERC-20/Permit2、PSBT scripts、SPL instructions            | 受控范围内的确定性意图与权限描述 | 新协议、升级、嵌套执行、未知字段             |
| 描述元数据       | ABI、Anchor IDL、ERC-7730                                 | 字段类型、标签、单位和显示规则   | 元数据与真实部署绑定、来源可信度、执行结果   |
| 节点/VM/服务模拟 | Geth、Solana RPC、Bitcoin Core、Tenderly                  | 给定状态下的执行或收支预览       | 前后状态一致性、业务解释、未来状态和提交保证 |
| 风险引擎         | Blockaid、钱包内规则                                      | 已知恶意实体/模式与风险提示      | 无命中不能证明安全；不能取代确定性解析和验签 |

各库的具体官方来源与比较见 [evm.md](evm.md)、[bitcoin.md](bitcoin.md)、[solana.md](solana.md)；模拟提供方的证据与限制见 [simulation.md](simulation.md)。

## ERC-7730：值得借鉴的可读签名元数据

ERC-7730 用 JSON 描述结构化调用/消息怎样展示，并把格式与适用 context 绑定。它可以提供金额、地址、标签等语义，但依赖可信描述和正确匹配，不是任意合约的自动安全证明。本次官方页仍标为 Draft；版本表与 schema 有单独演进，实施时必须固定实际 schema，不能复制不同年代的教程拼成实现。[ERC-7730](https://eips.ethereum.org/EIPS/eip-7730)

对 Monoid 的建议：优先借鉴“声明式字段展示、部署绑定、版本化、完整性检查”的设计。不要让远端 descriptor 任意隐藏关键字段，也不要执行 descriptor 携带的代码。复杂 calldata/typed data 的解析仍由本地适配器负责。Ledger 当前概览将通用描述符、schema 与工具入口指向 ClearSigning.org；旧 builder 教程不应作为当前能力边界。[Ledger 概览](https://developers.ledger.com/docs/clear-signing/overview)、[ClearSigning Build](https://clearsigning.org/build/)

现成组件中，`@ethereum-sourcify/clear-signing` 尤其值得做 TypeScript 原型：维护方描述其将 calldata/EIP-712 转成 display model，token/chain/ENS 等外部数据由钱包提供，没有匹配描述时回退。它不执行交易模拟，也不替钱包决定 descriptor 是否可信。官方 Build 页还列出 Rust 实现和 Cyfrin Clearsig；本次只核查其入口，未测试构建与格式覆盖。[Sourcify 实现与集成指南](https://github.com/sourcifyeth/clear-signing)、[Rust 实现](https://github.com/llbartekll/clear-signing)、[Cyfrin Clearsig](https://github.com/Cyfrin/clearsig)

registry 可以包含质量较低甚至恶意的描述；发布到 registry 本身不是安全背书。Monoid 需要选择接受哪些来源、review/attestation，并明确缺少可信描述时的展示。这个信任策略与 ABI 解码和交易模拟分别建立。[Wallet builders 指南](https://clearsigning.org/build/#for-wallet-developers)

ERC-7730 只解决元数据层的一部分。没有独立可信屏幕的卡，即使手机使用同样的 descriptor，也不能称为已经具备 Ledger 式设备可信显示保证。

## 可参考的钱包实现

### Rabby

Rabby 当前 `SignTx.tsx` 将 `parseTx` 与 `preExecTx` 分开，并结合 action/security engine 和 pending transactions 展示结果。源码明确调用 `wallet.openapi`，因此不能把“前端源码公开”理解成完整解析/模拟服务可以离线移植。可参考它的职责分离与结果 UI，服务部分需独立选择。[源码](https://raw.githubusercontent.com/RabbyHub/Rabby/develop/src/ui/views/Approval/components/SignTx.tsx)

本次读取的 LICENSE 为 MIT，并另有品牌名称/标识保留说明；如果以后移植代码，应按所选提交、依赖和素材分别核对许可。本次没有拷贝其代码。[LICENSE](https://raw.githubusercontent.com/RabbyHub/Rabby/develop/LICENSE)

### MetaMask Snaps

Transaction insights 与 Signature insights 分别提供交易/签名确认阶段的扩展入口，体现了消息签名与交易执行的不同需求。它们是 MetaMask 的扩展机制，可作解析器隔离、权限控制和确认页的设计参考，不能直接当 Monoid 的跨链 SDK。[Transaction insights](https://docs.metamask.io/snaps/features/transaction-insights/)、[Signature insights](https://docs.metamask.io/snaps/features/signature-insights/)

### 硬件钱包与多链签名核心

Trezor firmware 可用作硬件侧链特定交易处理和测试样例的进一步研究入口；Wallet Core 提供多链底层功能。两者都不能仅凭支持链名单就认定覆盖了“任意 DApp 语义解析 + 资产模拟”。若后续采用原生/WASM 核心，应先证明它能接外部卡签名、返回准确 signing input，并核对移动端构建与依赖许可。[Trezor firmware](https://github.com/trezor/trezor-firmware)、[Wallet Core](https://developer.trustwallet.com/developer/wallet-core)

## 其他链：按协议适配，不能只按曲线适配

本节是扩展路线扫描，深度低于三条主链；没有验证每个生态最新网络/SDK组合。

| 生态       | 主要解析对象                                                                      | 可利用组件/资料                                    | 对统一设计的启示                                                               |
| ---------- | --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Cosmos SDK | Protobuf `SignDoc`、`TxBody`、`AuthInfo`、`Any` 消息；Amino/Textual 等 sign modes | CosmJS registry + 对应链 proto；SDK sign-mode 规范 | 相同 secp256k1 不代表与 EVM 相同哈希/序列化；未知 type URL 必须保留未知        |
| Sui        | BCS TransactionData、intent、PTB commands、对象引用与 gas                         | 官方 Sui SDK/BCS 类型与 intent signing             | Ed25519 的外部输入是协议定义的 intent digest，不是直接照搬 Solana 原始 message |
| Aptos      | BCS transaction、domain separator、不同 signer/authenticator 形式                 | 官方 TypeScript SDK 的 signing message 构造        | 需要区分 raw transaction 与多方/费用赞助等上下文，不能只展示 Move 函数名       |
| TRON       | Protobuf transaction、raw_data、合约调用参数、权限信息                            | TronWeb 的 protobuf/transaction 工具及消息签名接口 | EVM ABI 可用于部分合约参数；交易 envelope、地址、费用和消息前缀需单独处理      |

### Cosmos

`SIGN_MODE_DIRECT` 的签名对象是包含原始 `body_bytes/auth_info_bytes` 等字段的 SignDoc。Amino 和 Textual 是不同协议模式，不应为了可读展示自行改写待签内容。Textual 模式尤其值得研究：其显示内容与签名规则有规范关系，不能降格为普通 JSON 美化。这里引用的官方 docs 仓库已归档，内容用作模式解释，具体链版本需要重新核验。[官方交易文档源码](https://github.com/cosmos/cosmos-sdk-docs/blob/main/docs/learn/advanced/01-transactions.md)

CosmJS `Registry` 按 type URL 解码；真实链上需要注册其模块类型，未知 `Any` 不会自动获得业务含义。授权委托、fee grant、IBC 等应单独编写解析规则。[CosmJS Registry](https://cosmos.github.io/cosmjs/latest/proto-signing/classes/Registry.html)

### Sui

官方 intent signing 定义了对 intent 与 BCS 消息组合的 Blake2b-256 摘要签名。移植到卡端时应精确确定哪层负责该摘要：不能因为算法同为 Ed25519 就额外套一次 Solana/Sui 不要求的预哈希。PTB 的对象流、所有权和 gas 需要结合模拟结果解释。[Intent signing](https://www.docs.sui.io/develop/transactions/transaction-auth/intent-signing)

### Aptos

官方 SDK 的 `generateSigningMessage` 接收字节与 `APTOS::` 开头的 domain separator。应让对应 SDK/协议版本负责构造签名输入，再对 payload、chain、sequence、expiration、费用与签名者作独立展示；新增账户认证方案需要独立验收。本次仅验证该构造入口，不声称完成 Aptos 全格式覆盖。[固定版本 SDK 文档](https://aptos-labs.github.io/aptos-ts-sdk/@aptos-labs/ts-sdk-7.2.0/functions/generateSigningMessage.html)

### TRON

TronWeb 交易对象同时包含可读 `raw_data`、`raw_data_hex` 与 txID。钱包应从实际待签字节验证它们的一致性，不信任请求方提供的 txID/JSON 摘要。官方将消息签名单列 `signMessageV2`；不应与交易签名入口混用。[TronWeb sign](https://tronweb.network/docu/docs/API%20List/trx/sign/)、[官方签名实现](https://raw.githubusercontent.com/tronprotocol/tronweb/master/src/utils/crypto.ts)

## 复用范围建议

统一层可以共享请求生命周期、证据来源、金额显示、资产变化、权限提示和用户确认。各链保留自己的解析器、签名 preimage、模拟输入、账户归属和验签/封装规则。

不要设计成“猜测 bytes 属于哪条链 → 自动选算法”。链/请求方法/协议版本应来自已校验的会话上下文，原始字节再通过严格结构校验。不明格式明确显示未知，不能用 LLM 输出替代确定性解码、哈希和风险规则；若引入自然语言总结，应仅消费已经验证的结构化结果。
