# 多链签名解析与交易结果模拟调研

调研日期：2026-10-14。面向 Monoid 的 TypeScript/Capacitor App 和外部卡签名器，重点覆盖 EVM、Bitcoin、Solana，并参考 `C:\Projects\megnat` 的已有 EVM 实现；补充 Cosmos、Sui、Aptos、TRON 的扩展路径。

用户补充希望做“模拟事务结果”，因此本研究将**签名前的执行/收支预览**作为核心方向，同时保留消息、授权、签名输入和验签方面的研究。

## 主要结论

建议采用“本地确定性解析 + 链特定模拟 + 资产/权限变化解释 + 精确签名输入绑定”。目前核查到的方案分属编解码、协议规则、元数据、执行引擎和风险服务，没有足够证据把其中一个当作覆盖所有链、所有签名的完整解决方案。

| 链      | 解析方案候选                                                                      | 结果模拟候选                                                                | 首期最需要解决的问题                                          |
| ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| EVM     | 先复用 ethers 6；按需评估 viem；已知协议规则 + ABI/部署证据                       | Tenderly 与 Geth trace / `eth_simulateV1` 做对照                            | 资产、授权、控制权一起解释；permit/订单不能直接当普通交易模拟 |
| Bitcoin | 优先验证 scure-btc-signer，bitcoinjs-lib 作对照；PSBT + 可信 prevout + descriptor | 本地收支推导、Core `simulaterawtransaction`；完整交易再 `testmempoolaccept` | 找零归属、手续费、逐输入 sighash、多方签名与附加资产语义      |
| Solana  | 优先验证 Kit + 官方 program decoders；Codama/IDL 扩展                             | 标准 `simulateTransaction`；依赖多笔另选共享状态服务                        | 原始 message 保真、ALT、同快照结果、Token-2022 与权限变化     |

上述为基于源码与文档的候选建议，不是性能/互操作测试结论。库依据与详细比较见各链专题；模拟能力依据见 [Geth](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)、[Tenderly](https://docs.tenderly.co/simulations/overview)、[Bitcoin Core](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/simulaterawtransaction/)、[Solana RPC](https://solana.com/docs/rpc/http/simulatetransaction)。

**余额不变不能代表没有影响。** approve、Permit2、账户代码委托、delegate/authority 修改等可能在本次不转走资产，却赋予后续操作能力。预览应并列展示资产变化、权限变化、费用、执行状态以及未覆盖的影响。

## 阅读入口

| 文档                                       | 内容                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [交易结果模拟](simulation.md)              | 优先阅读；自建与服务比较、三链差异、消息模拟限制、结果模型、流程图与 PoC 验收       |
| [EVM](evm.md)                              | EIP-191/712、SIWE、ABI/代理、Permit2、7702、4337、SDK、执行轨迹与资产解释           |
| [Bitcoin](bitcoin.md)                      | PSBT v0/v2、UTXO/找零、三代 sighash、Taproot、BIP322、descriptor、Core 模拟与库对比 |
| [Solana](solana.md)                        | legacy/v0、ALT、Ed25519、program/IDL、标准 RPC、账户变化、顺序模拟、SIWS 与版本演进 |
| [Solana 服务选型](solana-services.md)      | 连接与四类签名流程、RPC、Jupiter、模拟扩展、IDL 和源码验证、Cloudflare 接入安排     |
| [方案生态与其他链](ecosystem-solutions.md) | ERC-7730、Rabby、MetaMask Snaps、硬件钱包参考，以及 Cosmos/Sui/Aptos/TRON           |
| [Megnat 源码参考](megnat-reference.md)     | 已有实现、精确源码定位、可复用流程和不能照搬的假设                                  |
| [Monoid 接入建议](monoid-integration.md)   | 当前 App/卡能力、源码快照、缺口、职责边界和分阶段研究路径                           |

## 与现有项目的关系

Megnat 已有外部 signer、ABI → 代理实现 → selector 目录的解码思路，但未发现完整的执行模拟/资产差分链路。现有 ABI 查询、代理回退条件、selector 歧义、typed-data 展示等存在明确缺口，应复用其分层思路并重新定义可信证据，不能直接沿用 `verified` 作为安全标记。详见 [源码参考](megnat-reference.md)。

Monoid 固件源码已有 ECDSA digest、Ed25519 message、Schnorr digest/Taproot 路径；App 卡封装尚无 sign 方法，WalletKit service 仍是空壳，长 CBOR 请求也缺 multipart 发送。支持曲线与完成链级钱包签名之间仍有较多接入工作。本次未验证已安装固件和实卡能力，详见 [接入建议与证据](monoid-integration.md)。

## 下一步建议

先用公开 fixture 和受控链状态做模拟 PoC，比较资产/权限变化的正确率与覆盖缺口，再测延迟和成本。第一轮覆盖 EVM 转账/approve/swap、BTC PSBT 收支与找零、Solana SOL/SPL/ATA/authority；包含失败、未知格式、服务缺字段和状态过期样例。

模拟与解析需要在本地绑定同一份待批准内容。用户改 gas、nonce、blockhash、目标或数据后，不能继续使用旧确认结果。普通消息没有执行入口时明确保留“不可直接模拟”，不能编造一次执行来解释签名。

## 证据与验证边界

- 资料优先使用官方规范、维护方文档与源码，段落旁附来源。规范、SDK 和供应商页面可能继续变化；BTC 专题固定了主要源码快照，其余动态链接应按选定版本复核。
- 各文档区分源码事实、规范能力、供应商声明、研究建议和未验证项。Blockaid 文档需登录、部分旧服务链接不可访问等限制已记录，没有据此猜测其完整能力或停服状态。
- 本次仅新增本目录研究文档，完成内容交叉检查、Markdown 格式和本地链接检查；没有安装 SDK、修改业务/API、调用实卡、广播交易、订阅服务或执行付费接口。
- 这里的“签名解析”指还原和解释**待签 payload**。单独拿到签名或不可逆摘要，不能恢复完整的交易/消息意图。
