# Monoid 当前基础与接入建议

调研日期：2026-10-14。以下“已存在”均来自本次源码阅读，不表示已在实卡或网络上验证。本文只记录研究结论，没有变更 App、固件、协议或依赖。

## 本地证据快照

| 仓库                          | HEAD                                       | 本次状态                                  |
| ----------------------------- | ------------------------------------------ | ----------------------------------------- |
| `C:\Projects\monoid`          | `8c24d1b7bca94f4acd1ea352793b84916367ea51` | 有既存未提交更改；按工作区读取            |
| `C:\Projects\monoid-javacard` | `239b4cb866251d784b5c941d07ef3f643e9d52f7` | 有既存 staged/unstaged 更改；按工作区读取 |
| `C:\Projects\megnat`          | `5ce4e40d02e3e6af51da0885a7419eb7d8e92c4b` | 初次检查为 clean；只读参考                |

未提交内容不能由 HEAD 单独重现。关键文件的 SHA-256：

| 文件                                             | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Monoid `src/@lib/monoid/monoid-applet.ts`        | `B4B087A5F983CF48808742792FB213406EEA3230FC2DD98E87C2E39659A9D958` |
| Monoid `src/@services/wallet-kit-service.ts`     | `7B26327FCFB9163677BC4338F47B97FE46260448D08AED9C1F14CD1F7A885287` |
| Monoid `src/@lib/applet.ts`                      | `1382C9447C4996AE6EFA2773DD25B16693DA3A8A58117EB71260B36B0241D712` |
| JavaCard `src/main/java/monoid/CommandSign.java` | `6346507478B4697E7415BD383C500650E59E0FCAC1B41A10C2F89B6253AA175D` |
| JavaCard `src/main/java/monoid/Signer.java`      | `C40E8580EBFBA59DE7F1DE0107386AC8351D0BE3EAE94747A8A26E29651F60E9` |

## 已确认的能力和缺口

| 层            | 当前源码事实                                                     | 研究含义                                                                         |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| App 依赖      | 已有 ethers 6、WalletKit/Reown 依赖                              | EVM 编解码可优先复用 ethers；装了 WalletKit 不等于已处理签名请求                 |
| App WalletKit | service 仅保存 `kit`，没有请求处理逻辑                           | 接入 DApp 请求、批准、取消、超时和回复仍需实现                                   |
| App 卡封装    | 包含 hello/authenticate/setPIN/list/set/viewKey，没有 sign 方法  | 当前 App 尚不能直接使用固件签名分支                                              |
| App APDU      | `sendCommand` 将 CBOR 长度写入一字节 Lc，未实现 multipart 分帧   | 长 message/CBOR 请求不能直接套入；Solana 尤其需要完整 message 传输               |
| 卡 ECDSA      | 接收 digest，调用预计算摘要签名，输出 plain signature 并做 low-S | App 需正确构造链特定摘要，并转换成链所需签名格式                                 |
| 卡 EdDSA      | 读取 message 的 byte range，走 Ed25519 签名                      | Solana 应传原始序列化 message，而非交易哈希或整个含签名 envelope                 |
| 卡 Schnorr    | 校验 32-byte digest，支持可选 Taproot tweak 参数                 | 可研究 BTC Taproot；仍需 App 构造 BIP341 sighash、验证 output key 和 PSBT 上下文 |

源码入口：[App 卡封装](C:/Projects/monoid/src/@lib/monoid/monoid-applet.ts:49)、[WalletKitService](C:/Projects/monoid/src/@services/wallet-kit-service.ts:3)、[APDU 构造](C:/Projects/monoid/src/@lib/applet.ts:71)、[CommandSign](C:/Projects/monoid-javacard/src/main/java/monoid/CommandSign.java:44)、[Signer](C:/Projects/monoid-javacard/src/main/java/monoid/Signer.java:16)、[OneShot](C:/Projects/monoid-javacard/src/main/java/monoid/OneShot.java:15)、[Keystore](C:/Projects/monoid-javacard/src/main/java/monoid/Keystore.java:280)。

因此，“卡支持这些算法”与“钱包已支持这些链”之间还缺解析、网络上下文、哈希、序列化、确认和结果验证。后续实现需要单独讨论 App/API 变更；当前文档没有把候选设计当作既定接口。

## 建议的职责划分

1. 请求入口：校验会话网络、账户、方法和 payload；保存请求原件与生命周期。
2. 链适配器：严格反序列化、构造 signing input、识别资产/权限、定义未知项；多个 BTC 输入或多个交易产生多个签名计划。
3. 上下文获取：UTXO、ABI、IDL、ALT、token metadata、代理实现、链状态；记录来源与时点。
4. 模拟适配器：调用节点/服务，返回执行证据，保留跳过检查与 overrides。
5. 预览与确认：显示资产、权限、费用、网络、签名者、有效期和未知影响；批准绑定到同一内容版本。
6. 签名协调：将精确 digest/message 交给通用卡签名能力，不把 ABI/PSBT/IDL 逻辑塞进 ISO-DEP 传输插件。
7. 结果校验：以预期公钥本地验签，验证签名输入和批准版本一致，再按协议封装。部分签名 PSBT 与完整交易分开；只有签名/脚本满足条件后才 finalize，广播由请求方法和授权范围决定。

这是研究性的模块职责，不要求新建上述名称的类，也不预先固定 API。

### 三种卡签名输入不能统一成一个任意 hash

| 请求                             | App 应决定的签名输入                  | 卡后处理                                                                     |
| -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| EVM 交易/EIP-712/明确的消息签名  | 对应协议规定的 32-byte digest         | 用预期公钥确定恢复信息；按交易/message 类型编码 `r/s/v` 或 parity；本地验签  |
| BTC legacy/SegWit v0             | 每输入和 sighash 规则规定的 digest    | ECDSA plain 转 DER、附 sighash 类型、写回对应 PSBT/输入                      |
| BTC Taproot                      | BIP341 对应输入/路径的 32-byte digest | Schnorr 签名、按规则附非默认 sighash；分清 key-path tweak 与 script-path key |
| Solana 交易                      | 序列化 message 的精确原始字节         | 64-byte Ed25519 signature 填到对应 signer slot，其他签名保留并验证           |
| Solana signMessage / SIWS / OCMS | 各格式规定的完整 signed bytes         | 返回 detached signature 及协议要求的 signed message；不写入交易 signer slot  |

密码学算法、preimage 和封装规则的规范来源分别列在三份链研究中。卡只签摘要时无法由摘要恢复收款人/授权范围；通用算法接口不会自动带来语义保护。

## 以模拟结果为重点的实施顺序建议

### 第一阶段：解析与模拟样例，不接真实签名

- 建立固定输入、固定链状态、预期资产/权限变化的样例集。
- EVM：ethers 解析 + Tenderly/Geth 对照，先覆盖原生转账、ERC-20/NFT、approve 和常见 swap。
- Solana：Kit/明确固定版本的 SDK + RPC，先覆盖 SOL/SPL/ATA/基础权限和 legacy/v0。
- BTC：PSBT + 可信 prevout/descriptor，计算收支/手续费；与 Core 钱包余额模拟对照。
- 产出服务支持矩阵、错误/未知分类、延迟和成本数据，按 [simulation.md](simulation.md) 的样例验收。

### 第二阶段：闭合确认与签名链路

在单独确定 API 后，补 App 签名命令封装、长消息分片、取消/超时、请求到签名计划绑定、本地验签以及最终输出封装。任何 gas/nonce/blockhash/收款账户等修改均须与批准版本协调。通过测试卡/测试账户做端到端验收。

### 第三阶段：复杂授权与协议覆盖

扩展 Permit2、7702、4337、Safe、BTC 多签/复杂 script、Solana DeFi/Token-2022 扩展、多个相互依赖的交易。每项都声明可解析范围、模拟前提和未知行为，不以算法/链名单替代支持矩阵。

## 需要单独验收的现实边界

- 本次未连接实卡，未核实已安装 CAP 与当前源代码是否一致，也未测签名延迟/峰值 RAM/长消息传输。
- App 端解析/模拟可以抵御很多误签，但若手机本身失陷，卡端没有独立展示就不能保证用户看到的业务内容是真正待签内容。
- 模拟服务可能需要请求交易内容、地址与 DApp 来源；可用最小字段请求、后端持有服务凭据，并明确保存策略。无需上传 PIN、私钥或种子。
- 商业接口的套餐、链和版本支持、限流及数据保留尚未实测；不把本文候选写成部署承诺。

## 本次验证范围

完成官方资料查阅和本地源码核对；研究文件会做格式与交叉链接检查。未跑应用构建、固件测试、主网广播、付费 API 或性能基准，因为本次没有改实现。megnat 的可复用点与具体源码缺口另见 [megnat-reference.md](megnat-reference.md)。
