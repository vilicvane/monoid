# Bitcoin 签名请求解析与可读确认

调研日期：2026-10-14。范围为钱包在签名前解析 raw transaction、PSBT、消息签名，确认签名覆盖范围、计算摘要、验证返回签名；不包含交易广播、链上资金操作或业务代码实现。以下“建议”是设计判断，不代表 Monoid 已具备相应能力。本文没有验证实体卡、安装新依赖或运行库间互操作测试。

## 1. 结论与建议支持范围

Bitcoin 的关键是验证输入资金来源、钱包归属及每个签名真正承诺的内容。针对“签名前模拟结果”，建议先完成 UTXO 金额流/钱包净变化预览，再叠加节点状态检查；签名完成后的 mempool 接受性检查另行标注。推荐以 PSBT 为主要签名入口，raw transaction 作为检查入口；后者补齐 prevout、脚本和钱包策略后才能进入签名。首期支持 PSBT v0/v2、P2WPKH、P2SH-P2WPKH、P2TR key path，ECDSA 限定 `SIGHASH_ALL`，Taproot 限定 `SIGHASH_DEFAULT`/`ALL`。所有输出都展示；只有经过钱包策略重建验证的输出才标为找零。

TypeScript 落地优先评估 `@scure/btc-signer`，与 `bitcoinjs-lib` 对同一组公开向量做独立差分验证。多签、复杂锁定策略和通用 BIP322 full 验证需要单列阶段，Rust `bitcoin` + `miniscript` 适合作为策略/验证引擎候选。库的“支持 PSBT/Taproot”不等同于完整解释交易经济含义，也不意味着自动校验了所有外部元数据。

| 阶段     | 可读解析与签名范围                                                                      | 前置条件                                                            |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 首期     | PSBT v0/v2；单签 SegWit v0、Taproot key path；所有输入/输出/费用/锁定字段；受限 sighash | 输入证据完整、钱包归属可验证、返回签名可独立验证                    |
| 兼容扩展 | P2PKH、标准 P2WSH 多签、BIP322 simple、legacy message                                   | legacy 必须验证完整前序交易；多签须预注册完整策略；消息格式分别识别 |
| 策略扩展 | Taproot script path、Miniscript、BIP322 full/PoF、特殊 sighash、协作交易                | 精确脚本语义、支出路径和 signer policy；需要链状态时显式依赖节点    |
| 独立协议 | MuSig2、Ordinals/Runes 等资产语义                                                       | 专用协议实现及测试；不能从普通 Schnorr 或 BTC 数额显示推断支持      |

这是产品范围建议；协议格式依据 [BIP174](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0174.mediawiki)、[BIP370](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0370.mediawiki)、[BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki)。

## 2. 事务结果模拟：金额推导、余额投影与节点接受性

Bitcoin 普通交易的结果预览可以在没有私钥、没有完整签名时完成：消费哪些 UTXO、产生哪些输出、支付多少 BTC 手续费，都由交易与真实 prevout 决定。应将这类静态结果与“脚本能满足”“当前节点接受”“未来会确认”分别表示。特殊 sighash 允许他人继续变更部分交易时，当前预览只对应当前候选交易，不能声称未来签名被使用时必然得到相同完整结果。

| 方法                                           | 可在未签名时使用                | 得到的结果                                                               | 不能据此证明                                            |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| 本地 PSBT + 验证过的 prevout + 钱包 descriptor | 可以                            | 输入输出流、钱包净变化、全交易 fee、找零、锁定条件与预计 vsize           | UTXO 当前可用、脚本执行成功、节点接受                   |
| `analyzepsbt`                                  | 可以                            | 缺失哪些 UTXO/pubkey/script/signature、下一角色；信息充分时估计大小/费率 | PSBT 所述身份/找零可信、交易已可广播                    |
| `gettxout`                                     | 可以                            | 指定节点视角的未花费输出、金额/script、确认数和 bestblock                | 多次 RPC 的一致快照、未来不会冲突                       |
| `simulaterawtransaction`                       | 可以                            | 已加载钱包对 raw tx 或父子交易序列的 `balance_change`                    | 交易有效、脚本/签名正确、任意地址/资产的全局 state diff |
| `testmempoolaccept`                            | 常规花费须先有完整有效签名/见证 | 当前节点的 consensus/policy 接受性、拒绝原因、费用/vsize 等              | 广播成功、矿工收录、长期有效、Ordinals/Runes 语义安全   |

RPC 依据固定版本的官方文档：[analyzepsbt 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/analyzepsbt/)、[gettxout 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/)、[simulaterawtransaction 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/simulaterawtransaction/)、[testmempoolaccept 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/testmempoolaccept/)。30.0 用作已核对接口基线，不声称是最新发行版；部署节点应检测实际版本/能力。

本地预览建议输出两种数值：`fee = Σ全部输入金额 − Σ全部输出金额`，`walletDelta = Σ本钱包输出金额 − Σ本钱包输入金额`。假设自己的输入为 100,000 sats、外部收款输出为 60,000 sats、已验证找零为 39,000 sats，则 fee 为 1,000 sats，钱包净变化为 −61,000 sats。这是金额推导示例，不是节点模拟实测。CoinJoin/PayJoin 等多人输入场景不能把总 fee 全算作自己的花费，也不能按常见输出形状猜测找零；钱包净变化仍可按可信归属求和，个人费用分摊则需要协调协议上下文。

`simulaterawtransaction` 有实用价值，但需明确视角：它使用已加载钱包识别脚本，不能直接传一个任意钱包地址列表获取完整变化；可考虑预先配置 descriptor watch-only 钱包，或直接在 Monoid 本地用相同归属规则计算。官方功能测试对没有输入的 raw transaction 都能返回正向余额变化，随后对未签 funded tx、父子交易和 watch-only 钱包计算结果；因此成功响应不能用作有效性证明。测试还覆盖重复花费和缺失父交易错误。[Bitcoin Core wallet_simulaterawtx.py](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/test/functional/wallet_simulaterawtx.py)

`testmempoolaccept` 接收 raw transaction，不直接接收 PSBT；缺少常规支出所需签名的交易通常会因脚本验证失败，不能把它当作可跳过签名的通用事务模拟。文档基线一次最多 25 笔，父交易必须在子交易之前，并受到 package policy 约束。一笔失败时其他项可能没有 `allowed`，应呈现为“未完整检查”。父子包的有效费率与单笔费率也不同；它不会广播交易，`submitpackage`/`sendrawtransaction` 则属于另一类操作。[testmempoolaccept 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/testmempoolaccept/)

在线核验至少记录节点身份/版本、网络、时间、bestblock 和是否包含 mempool。`gettxout(include_mempool=true)` 对已被 mempool 交易花费的输出不返回记录；多次调用之间 mempool 或链头仍可变化。节点不存在该输出、节点尚未同步、已被花费和缺失尚未提交的父交易，需要结合上下文区分，不能一律显示成“余额不足”。状态陈旧时可以保留静态金额结果，但将在线有效性标为需要刷新。[gettxout 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/)

Ordinals/Runes 属于额外资产规则：Ordinals 的 sat 流转受输入输出顺序影响，需要相关 sat/inscription 索引；Runes 需要输入 rune 余额、runestone 解析和协议状态，某些 malformed runestone 会形成 cenotaph 并烧毁输入 runes。Bitcoin Core 验证通过仍可能产生这种资产损失。要展示 NFT/token 变化，需独立且版本固定的 overlay 解析器/索引器，并记录它的链头和覆盖范围；未接入时应显示“附加资产影响未评估”，不能显示“只有 BTC 变化”。[Ordinal Theory Overview](https://docs.ordinals.com/overview.html)、[Runes specification](https://docs.ordinals.com/runes/specification.html)

建议首个原型仅做：静态 PSBT 结果投影 + 可信 UTXO 查询 + 每项证据来源；之后增加完整签名后的 `testmempoolaccept` 和需要时的专用 overlay。测试至少覆盖普通支付、自己转自己、CoinJoin、父子包、已花费输入、缺签名、非法脚本、节点离线/链头变化，以及 BTC 金额正常但 rune 被烧毁的交易。

## 3. 输入格式与解析层次

| 格式                    | 可以直接取得                                                                       | 单独不足以证明                                                |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| raw transaction         | version、outpoint、sequence、outputs、locktime、现有 scriptSig/witness、txid/wtxid | 输入金额、真实 prevout script、钱包归属、准确费用、是否未花费 |
| PSBT v0                 | 全局 unsigned transaction；逐输入/输出脚本、UTXO、派生和部分签名                   | 字段真实性、找零归属、未花费状态、未知扩展含义                |
| PSBT v2                 | 从全局/输入/输出字段重建交易；输入输出可修改标志、locktime 要求                    | 同上；还须正确处理构造阶段和已有签名允许的修改范围            |
| BIP322 / legacy message | 消息字节、指定地址、消息证明                                                       | 身份真实性、授权域、资金当前仍可用；这些需额外上下文          |

PSBT v2 不是“PSBT v0 改个版本号”：它移除全局 unsigned transaction，把构造交易所需信息分散到各 map，并引入输入/输出数、可修改标志和逐输入 locktime 要求。解析器应分别校验各版本必需/禁止字段，再得到同一内部交易视图；展示给用户之后应锁定该视图，不能继续接受协调者增删输入输出。转换到 v0 必须先解析出有效 locktime 和交易，不能静默丢掉尚有语义的 v2 状态。[BIP370](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0370.mediawiki)

建议按四个层次返回状态：`已解码`、`签名承诺已核对`、`钱包策略已识别`、`链上状态已核验`。每项独立记录证据。仅收到 32 字节摘要时只能确认“签这个摘要”，不能反推交易或声称完成可读签名。

## 4. UTXO、费用与找零的证据

### 输入与脚本

逐输入验证 `non_witness_utxo` 的 txid 等于 outpoint，并核对输出索引存在；同时出现 `witness_utxo` 时，核对金额和 scriptPubKey 一致。P2SH 重算 redeemScript 的 HASH160，P2WSH 重算 witnessScript 的 SHA256。PSBT 的路径、fingerprint、脚本和标签都是请求方提交的数据，不能当作钱包可信配置。[BIP174 Signer](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0174.mediawiki#signer)

Taproot 还须区分 internal key 与经过 tweak 的 output key，核对内部公钥、Merkle root 和输出公钥的关系；script path 需要验证 tapleaf、control block、路径和 output key。不能因某个 `tap_bip32_derivation` 含有自己的公钥就认定整个策略属于自己。Taproot PSBT 字段见 [BIP371](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0371.mediawiki)，tweak/control block 规则见 [BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki#script-validation-rules)。

### 金额与费用

金额以整数 satoshi 保存，TypeScript 使用 `bigint`，显示时再格式化；费用为全部输入金额之和减全部输出金额之和。签名前 witness 尚未最终确定时，费率应显示“估算 sat/vB”或范围；最终组装后才计算准确 vsize。PSBT 提供的完整前序交易只把金额/脚本绑定到 txid，不证明该交易已确认或该输出仍未花费；后者依赖已选节点/链状态。[BIP174](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0174.mediawiki)、[Bitcoin Core gettxout](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/)

必须避免把“某个输入签名有效”误当作“展示的总手续费可信”：SegWit v0 摘要承诺当前输入金额，却不承诺其他输入的金额。恶意协调者可用其他输入的假金额影响费用展示；默认应验证所有输入的完整 prevtx，或从可信节点核对金额/脚本。Taproot 非 `ANYONECANPAY` 签名承诺全部输入金额/脚本，错误数据会令该签名无效，但仍不能证明链状态；`ANYONECANPAY` 不能沿用这项全输入保证。[BIP143](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0143.mediawiki)、[BIP341 Common signature message](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki#common-signature-message)

### 钱包归属与找零

建议以可信登记的 descriptor/公钥策略作为归属来源，使用获准派生路径重新生成 scriptPubKey 并与实际输出逐字节比较。单靠 `change=true`、路径以 `/1/i` 结尾、fingerprint 命中或公钥出现在脚本里，都不足以认定找零。多签找零须匹配门限、所有参与者公钥和排序规则；Taproot 找零须匹配整个输出策略，不能只匹配 internal key。登记新策略本身需要单独明确确认，不能从待签 PSBT 自动登记。Descriptor 的 key origin/path 和 checksum 是描述与检错机制，不能替代来源认证。[BIP380](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0380.mediawiki)、[Bitcoin Core descriptors](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/doc/descriptors.md)

raw transaction 不含 EVM 式 chain ID，网络选择应来自钱包上下文。地址是 scriptPubKey 在所选网络下的编码结果；不能由展示地址推导出交易签名已承诺 mainnet/testnet/signet。应保留实际 scriptPubKey，无法识别的脚本显示原始字节及“不支持的支出策略”。[Bitcoin Core transaction 结构](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/src/primitives/transaction.h)

## 5. 三代交易摘要与签名格式

| 支出类型               | 摘要/签名                                                       | 必须区分的细节                                                                             |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Legacy P2PKH/P2SH 等   | 按 sighash 构造 legacy preimage，double-SHA256；secp256k1 ECDSA | 摘要不含输入金额；scriptCode、签名删除和 OP_CODESEPARATOR 有旧规则；不能拿 txid 当 sighash |
| SegWit v0 P2WPKH/P2WSH | BIP143 preimage，double-SHA256；secp256k1 ECDSA                 | 当前 prevout 金额入摘要；P2WPKH 的 scriptCode 是 P2PKH 模板，不是直接使用 witness program  |
| Taproot key path       | tagged hash `TapSighash`；BIP340 Schnorr                        | 签名对应 tweaked output key；`DEFAULT` 使用 64 字节签名，显式非零 sighash 使用 65 字节     |
| Taproot script path    | BIP341 common message + BIP342 扩展；BIP340 Schnorr             | 额外承诺 tapleaf hash、key version、codesep position；需核对具体被执行的叶子与公钥         |

Legacy 摘要以 [Bitcoin Core interpreter](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/src/script/interpreter.cpp) 为实现依据；SegWit v0、Taproot 分别见 [BIP143](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0143.mediawiki)、[BIP340](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0340.mediawiki)、[BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki)、[BIP342](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0342.mediawiki)。

ECDSA 交易签名通常是 DER 编码 `(r,s)` 再附一个 sighash 字节；外部签名设备若返回定长 `r||s`，应用须转换格式并检查 low-S 策略。Taproot 的 65 字节形式末字节不得是 `0x00`。签名验证应使用重新计算的摘要和该支出路径实际要求的公钥，并再次确认已有部分签名的 sighash 与请求声明一致；“反序列化没有报错”不构成验签。[BIP66](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0066.mediawiki)、[Bitcoin Core interpreter](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/src/script/interpreter.cpp)、[BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki#taproot-key-path-spending-signature-validation)

## 6. Sighash 是授权范围，必须可读展示

| 标志                         | 对输出的承诺           | 对输入的主要影响                                                       | 建议普通转账策略                           |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `ALL = 0x01`                 | 全部输出               | 非 ACP 时承诺全部 outpoint；sequence/amount 的具体覆盖随签名版本而不同 | 默认允许                                   |
| `NONE = 0x02`                | 不承诺任何输出         | 可与 ACP 组合；其他参与者可改变资金去向                                | 拒绝；仅在专用协议内放行                   |
| `SINGLE = 0x03`              | 对应输入索引的一个输出 | 其他输出可变化；配合 ACP 有输入输出配对移动语义                        | 拒绝；专用协议须展示配对                   |
| `ANYONECANPAY = 0x80` 修饰位 | 取决于 ALL/NONE/SINGLE | 不承诺其他输入；可增删其他资金来源                                     | 默认拒绝；“追加输入”不等于“仅增加善意资助” |
| Taproot `DEFAULT = 0x00`     | 同 ALL 的覆盖范围      | 仅适用于 Taproot；不是与 `ALL` 相同的摘要字节值                        | 默认允许                                   |

表格是授权解释，不能替代各代摘要算法。Legacy/SegWit v0 的 `NONE`/`SINGLE` 对其他输入 sequence 的承诺不同于普通 `ALL`；Taproot 非 ACP 承诺全部 sequence。`ALL|ANYONECANPAY` 仍承诺全部输出，但交易整体费用和参与方结构可能改变，不能显示成完整冻结的交易。[BIP143](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0143.mediawiki#specification)、[BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki#common-signature-message)

`SINGLE` 缺少对应输出是必须单测的分歧：legacy 返回固定的 uint256 值 1；BIP143 令 `hashOutputs` 为零但仍计算完整摘要；Taproot 直接失败。普通转账路径应统一拒绝该请求，但底层验证器必须保留正确协议语义，不能让三个实现共用一个“修复后”算法。Taproot 只允许 `00/01/02/03/81/82/83`，`0x80` 并不是合法的 `DEFAULT|ANYONECANPAY`。Legacy 的非标准值也不应在产品中静默归一化为 `ALL`。[Bitcoin Core legacy 分支](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/src/script/interpreter.cpp)、[BIP143](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0143.mediawiki)、[BIP341](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341.mediawiki)

## 7. 消息签名：legacy 与 BIP322 分开处理

Legacy Bitcoin message 使用 `Bitcoin Signed Message:\n` 域前缀，按 Bitcoin 字符串序列化后 double-SHA256，再产生可恢复公钥的 compact ECDSA 签名并 base64 编码。Bitcoin Core 的该验证入口只接受 P2PKH。它不是 DER 交易签名，也不是 EVM personal_sign；其他钱包扩展地址类型的格式不能自动互换。[Bitcoin Core signmessage](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/src/common/signmessage.cpp)

BIP322 把原始消息做 `BIP0322-signed-message` tagged hash，构造虚拟 `to_spend`/`to_sign`，通过满足指定地址的脚本来证明消息。它覆盖普通公钥签名之外的脚本策略，验证过程可能需要脚本解释器；不能仅验证某一个 ECDSA/Schnorr 签名就报告完整证明有效。不认识脚本或升级规则时，结果应为 `inconclusive`，而非“有效”。[BIP322](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0322.mediawiki#verification)

本次核对的 BIP322 文件声明版本 **2.0.0**：simple 使用 `smp` 前缀加 witness stack 的 base64；full 使用 `ful` 加已签虚拟交易；Proof of Funds 使用 `pof` 加 finalized PSBT。新增 PSBT 全局字段 `PSBT_GLOBAL_GENERIC_SIGNED_MESSAGE = 0x09`。这与早期仅用无前缀 base64 的实现不同，不能根据库声称“支持 BIP322”推断互操作成功。只有明确需要对接旧钱包时，才增加范围受限的旧格式读取兼容。[BIP322 formats 与 PSBT-based signing](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0322.mediawiki)

安全呈现建议：显示消息原文、地址、网络上下文、请求网站/应用来源；对不可见字符、双向文本控制字符、非法 UTF-8 提供转义或十六进制视图，签名仍绑定原始字节。不要 trim、Unicode 归一化或先解析再重编码。BIP322 消息 PSBT 只有在重新构造虚拟 prevout 且核对输入/唯一零金额 OP_RETURN 输出等条件后才显示为“消息签名”；不能仅凭 `0x09` 字段或零金额就绕过交易确认。消息格式本身不提供网站域名、nonce 或有效期，登录用途需应用层设计并验证这些字段。

PoF 也不证明“这是全部余额”，离线验证更不能证明输入尚未花费。若实现，须把密码学验证与指定链状态下的可用 UTXO 查询分开展示。BIP322 规定签名只使用 `ALL` 或支持时的 `DEFAULT`，未知脚本、时间锁和升级规则有各自验证状态。[BIP322 proof-of-funds 与 required rules](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0322.mediawiki)

## 8. Descriptor、Miniscript、多签与批量请求

Descriptor 适合表示可登记、可重建地址和脚本的完整钱包策略；Miniscript 为特定 Script 子集提供结构化策略、满足条件和权重分析。它们有助于将“脚本 hex”提升为“2/3 多签、等待若干区块、恢复分支”等语义，但不是任意 Script 或任意资产协议的反编译器。应显示实际选择的支出路径和所需条件，其他路径作为钱包策略信息；校验脚本必须与最终输出承诺匹配。[Bitcoin Core descriptors](https://github.com/bitcoin/bitcoin/blob/173ec9a06cf6a1619a1d62cbace6520c1ada0201/doc/descriptors.md)、[rust-miniscript 文档](https://docs.rs/miniscript/latest/miniscript/)

普通 PSBT 多签是各参与者给相同交易添加部分签名，组合后再 finalize。对卡式外部 signer，推荐明确枚举 `(交易确认标识, input index, 公钥, sighash, tapleaf/path)`，逐项获得签名并独立验签；不应调用 `signAllInputs` 后把“至少一个输入成功”当作全部成功。多输入事务可能中途取消，返回结果须清楚标明已签/跳过/失败输入；再次执行必须重新比对交易确认视图。bitcoinjs 的 `signAllInputs` 实现确实允许部分输入失败，只在全部失败时整体报错。[bitcoinjs psbt 实现](https://github.com/bitcoinjs/bitcoinjs-lib/blob/ab9fad5978bc1f4fb6542d1cde903d4427c3344e/ts_src/psbt.ts)

多笔交易批量签名则需要逐笔授权对象：每笔的资产流向、费用、输入归属及摘要不能被一个总金额替代。若前后交易存在依赖，应显示依赖关系并验证 outpoint；用户批准一笔不能自动覆盖后续任意交易。PSBT combine 也要验证交易、策略、输入证据与已有签名冲突，不能让“最后写入的 metadata”改变原有确认含义。

MuSig2 是另一类协议：有公钥聚合、多轮 nonce 和部分签名交换，不能由“已支持 BIP340 Schnorr”直接推出。秘密 nonce 必须按会话单次使用，异常/重试不能复用；参与者集合、聚合公钥、tweak、消息及会话必须绑定。应单独审查 BIP327 和 PSBT 扩展 BIP373，首期不纳入普通外部签名适配器。[BIP327](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0327.mediawiki)、[BIP373](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0373.mediawiki)

## 9. 库方案比较与落地选择

本表核对的是 2026-10-14 可访问的一手文档/源码快照，不保证对应 npm/crates.io 最新发行物；依赖落地时需要锁定发行版本并验证构建产物。

| 候选                | 已核对能力                                                                                    | 对 Monoid 的适配成本和限制                                                                                                   | 适合用途                            |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `@scure/btc-signer` | raw tx、PSBT v0/v2、SegWit、Taproot、MuSig2；bigint 金额；可控制 unknown/proprietary 字段策略 | 外部卡 signer 需验证如何取得精确摘要、插入签名和 finalize；不能把需要私钥的便利 API 当成卡适配接口；默认未知字段策略会 strip | TypeScript 主解析候选               |
| `bitcoinjs-lib`     | Transaction、BIP174 PSBT、BIP371 Taproot；`Signer`/`SignerAsync` 外部摘要签名；独立验签回调   | 该快照围绕 `globalMap.unsignedTx` 实现，不能认定支持原生 PSBT v2；`setVersion(2)` 设置的是交易版本；Taproot 需 ECC 依赖      | PSBT v0、外部 signer 接入；差分校验 |
| Rust `bitcoin`      | 强类型交易、脚本、地址、PSBT 和 sighash 基础构件                                              | 当前文档 PSBT 声明 BIP174，未核实原生 BIP370 v2 支持；经 WASM/原生桥接增加打包、字节/BigInt 传输与错误映射成本               | 更严格的底层验证或离线差分工具      |
| Rust `miniscript`   | Descriptor、策略、满足条件/权重分析、PSBT 扩展                                                | 不是全功能 Bitcoin Core 验证节点；需明确支持的 script context 和标准子集                                                     | 复杂策略、多签、可读脚本解释        |

来源：[scure README](https://github.com/paulmillr/scure-btc-signer/blob/22770eb8d3342bef01484096a45679c93675a401/README.md)、[bitcoinjs README](https://github.com/bitcoinjs/bitcoinjs-lib/blob/ab9fad5978bc1f4fb6542d1cde903d4427c3344e/README.md)、[bitcoinjs psbt.ts](https://github.com/bitcoinjs/bitcoinjs-lib/blob/ab9fad5978bc1f4fb6542d1cde903d4427c3344e/ts_src/psbt.ts)、[Rust bitcoin PSBT](https://docs.rs/bitcoin/latest/bitcoin/psbt/)、[Rust miniscript](https://docs.rs/miniscript/latest/miniscript/)。

特别注意 scure 的文档漂移：旧搜索摘要仍说“draft PSBTv2，tx_modifiable 不支持”，但本次读到的当前 README 已描述 v0/v2 转换、`unknown`/`proprietary` 的 `ignore/strip/strict` 行为和 `strictPrevoutValidation`。后者要求各输入完整且 txid 匹配的 `nonWitnessUtxo`；应按实际锁定版本验证这些选项，不复制旧摘要。当前仓库 package.json 为 2.4.1，bitcoinjs 仓库为 7.0.1；这里只确认仓库文件内容，不等于确认包管理器分发物。[scure README](https://github.com/paulmillr/scure-btc-signer/blob/22770eb8d3342bef01484096a45679c93675a401/README.md#encodedecode)、[scure package.json](https://github.com/paulmillr/scure-btc-signer/blob/22770eb8d3342bef01484096a45679c93675a401/package.json)、[bitcoinjs package.json](https://github.com/bitcoinjs/bitcoinjs-lib/blob/ab9fad5978bc1f4fb6542d1cde903d4427c3344e/package.json)

建议保留原始 PSBT 及未知字段用于检查和无损转发，同时把未知字段是否影响签名资格作为独立策略；不要在展示阶段静默 strip，再对修改后的对象签名。对于不了解的安全相关扩展，允许只读查看但拒绝签名。若使用 scure 的 `strict` 策略，需要接受它会拒绝含未知/私有字段的请求；若采用保留策略，则要在签名入口显式限制已理解的特性。兼容性与安全资格应分别测试。

## 10. Monoid 的 BTC 请求处理建议

以下为实现流程建议，不提出已获批准的 API 变更，也不判断卡端当前是否支持某种曲线/算法。

1. 保留原始请求字节、格式版本和调用来源，限制总字节数、输入输出数、map 项数、脚本长度与派生路径深度；拒绝畸形编码、重复 key 和重复 outpoint。
2. 解码到包含原始 scriptPubKey 的交易视图；按钱包选定网络生成地址；不能把请求自带网络名当作签名承诺。
3. 验证所有 prevout、脚本承诺与受信钱包策略，逐输入生成签名计划；不支持的脚本保留可读详情但不签名。
4. 计算所有输出、费用、钱包净支出、估计费率及每个 sighash 覆盖范围；外部 labels 必须标记来源，不能遮蔽真实地址/脚本。
5. 冻结交易与签名计划，绑定同一确认记录；等待卡操作过程中若任何实际签名字节、prevout 证据或策略变化，重新确认。
6. 逐项计算摘要并调用卡签名。Taproot key path 必须明确由哪一层完成 private/public tweak，script path 必须明确 leaf 和 codesep 规则；不应重复 tweak 或对裸 internal key 验 output-key 签名。
7. 本地独立验签、插入对应 PSBT 字段，再检查签名覆盖和交易视图没有改变。返回逐输入结果；需要 finalize 时重新校验脚本/见证完整性，不自动广播。

若硬件只接收摘要且没有独立可信显示，卡并未验证 UI 展示的收款人/金额。应用层解析能改善用户确认，但不能对抗已被完全控制、能替换摘要和 UI 的宿主；报告和产品说明应准确描述这个边界。

## 11. 解析风险与预期行为

| 请求或风险                                                          | 建议行为                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 假 witnessUtxo 金额、prevtx txid 不匹配、同输入两类 UTXO 冲突       | 拒绝签名；指出冲突输入，不显示“已核验费用”                              |
| 请求把攻击者输出标成 change，或提供伪造路径/fingerprint             | 用登记策略重建输出；未匹配者作为外部/未知输出完整展示                   |
| 未知 script、未知 witness version、含未支持 OP_CODESEPARATOR 的路径 | 只读解析/显示未知语义；不能当普通转账签名                               |
| PSBT v2 locktime 时间/高度要求不兼容                                | 拒绝构造/签名，不能任选较大值                                           |
| 已有部分签名与 metadata sighash 冲突                                | 拒绝；验证每个现有签名自己的尾字节及摘要                                |
| 使用 NONE/SINGLE/ACP，或同一交易混用 sighash                        | 逐输入展示实际授权；普通转账流程默认拒绝                                |
| 批量中一项失败，其余已签                                            | 明确部分完成；禁止声称整批完成或忽略失败输入                            |
| 请求仅给 BIP322 标识，但虚拟交易结构不匹配                          | 不按消息流程确认；按普通交易重新分类或拒绝                              |
| 超大 PSBT、深路径、很多未知字段、重复 map key                       | 在进入密码学运算前执行资源/结构限制                                     |
| OP_RETURN、未知 tapscript、包含协议数据的 UTXO                      | 展示 BTC 流和原始数据，标注未解析附加资产语义；不能声称“无其他资产影响” |

PSBT 结构和签名职责依据 [BIP174](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0174.mediawiki)；v2 locktime/可修改性依据 [BIP370](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0370.mediawiki)；其余拒绝规则为本项目建议的首期策略。

## 12. 验收矩阵

以下是实施前应建立的向量和预期结果，本次尚未执行。

| 组别        | 样例                                                                        | 验收重点                                                         |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 编码        | 同一交易 raw/PSBT v0/v2；乱序 map、重复 key、尾部垃圾、非最短长度编码       | 合法对象同一语义；畸形对象被拒绝；字节保留与语义等价分开验证     |
| SegWit      | BIP143 P2WPKH/P2SH-P2WPKH/P2WSH 官方向量                                    | preimage 与 sighash 逐字节相同；改变当前输入金额必须导致验签失败 |
| Legacy      | P2PKH、多签；缺失 nonWitnessUtxo；`SINGLE` 越界                             | 缺证据拒绝签名；底层正确处理固定值 1；不把 txid 当签名摘要       |
| Taproot     | BIP340/341 官方向量；key/script path；wrong tweak/root/control block；annex | 公钥/摘要/签名均一致；64/65 字节和显式 0x00 严格校验             |
| 授权        | ALL/NONE/SINGLE/ACP 组合；Taproot 0x80、未知值、SINGLE 越界                 | 每个输入正确标注覆盖范围；首期不支持的模式不能降级为 ALL         |
| 元数据欺骗  | 假找零、改路径、只匹配 fingerprint、替换多签共签者、虚假其他输入金额        | 展示和拒签依据实际脚本/策略/prevout 证据                         |
| v2 状态     | 时间/高度 locktime 冲突；modifiable 标志；v2 转 v0；已有 SINGLE 签名        | 转换不改变有效交易；不丢失尚有语义的构造约束                     |
| 消息        | Legacy、BIP322 smp/ful/pof；无前缀旧实现；UTF-8/控制字符；假消息 PSBT       | 明确识别版本；原始消息逐字节签名；不支持脚本返回 inconclusive    |
| 多签/批量   | 2-of-3、缺签名、错公钥、重复签名；第二输入取消；交易间不同费用              | 正确门限与脚本顺序；逐项部分完成；不能误报整批成功               |
| 外部 signer | ECDSA DER 与 r\|\|s；Schnorr key/script path；断连/重新连接                 | 编码正确、无重复 hash/tweak、返回签名验签通过后才写回            |
| 跨实现      | scure / bitcoinjs / Rust 对同一公开 fixture                                 | 交易视图、sighash、验签结果一致；不只测 decode→encode 的自洽性   |
| 运行环境    | Android WebView/Capacitor 实际发行配置                                      | BigInt、WASM/ECC 依赖、构建目标、内存峰值和大 PSBT 延迟符合约束  |

官方向量入口：[BIP143](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0143.mediawiki#example)、[BIP174](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0174.mediawiki#test-vectors)、[BIP340 vectors](https://github.com/bitcoin/bips/tree/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0340)、[BIP341 vectors](https://github.com/bitcoin/bips/tree/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0341)、[BIP370](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0370.mediawiki#test-vectors)、[BIP371](https://github.com/bitcoin/bips/blob/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0371.mediawiki#test-vectors)、[BIP322 vectors](https://github.com/bitcoin/bips/tree/927b6de9915c9262615a6399de51b200f81e5aa4/bip-0322)。

## 13. 已确认与待验证

已确认：官方规范包含上述三代摘要、PSBT v0/v2、Taproot 扩展、BIP322 2.0.0 与 MuSig2 协议；库文档/源码具备表中列出的接口与限制。规范库快照为 `bitcoin/bips@927b6de9915c9262615a6399de51b200f81e5aa4`；库快照为 `scure-btc-signer@22770eb8d3342bef01484096a45679c93675a401`、`bitcoinjs-lib@ab9fad5978bc1f4fb6542d1cde903d4427c3344e`；Bitcoin Core 源码快照为 `173ec9a06cf6a1619a1d62cbace6520c1ada0201`。Rust 文档为调研日的 docs.rs `latest` 页面，后续应固定选定版本。

待验证：Monoid 实际依赖适配、两套 TypeScript 库的完整 PSBT v2 互操作、BIP322 新格式生态兼容、外部卡签名摘要/密钥 tweak 接口、卡端与宿主的实际哈希边界、实体卡性能和大输入内存、Android WebView 构建、节点 RPC 实跑、overlay 结果及所有验收向量。本报告只做规范/源码研究，没有执行上述模拟 RPC，也没有把“库宣称支持”升级为“Monoid 已端到端支持”。
