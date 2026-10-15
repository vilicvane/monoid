# Security Key 签名算法支持顺序

记录日期：2026-10-15。供 Monoid 与 `monoid-javacard` 后续规划和实现参考。

排序以 **Passkey/FIDO2、SSH、企业证书/mTLS、PIV/OpenPGP 的综合兼容覆盖**为标准：在可实现的前提下，优先补主流生态需要的能力，不按实现难度排序。它是基于协议要求和代表性设备支持面的产品优先级，不是全行业使用份额统计。

新增主线为 **ES256 → RSA PKCS#1 v1.5 → RSA-PSS → ES384 → ES512 → Ed25519ph/ctx**。已有 pure Ed25519 继续作为 SSH 等场景的核心能力；未列入新增项不代表降低其优先级。

## 新增公钥签名的支持顺序

| 顺序  | 签名组合                                      | 目标场景与排序理由                                                                                                         |
| ----- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **1** | **P-256 + ECDSA + SHA-256，ES256**            | 优先补齐主流 Passkey/FIDO2、SSH `ecdsa-sk`、普通 ECDSA SSH、企业证书及 PIV 所需的曲线。现有 secp256k1 不能替代 P-256。     |
| **2** | **RSA PKCS#1 v1.5 + SHA-256 / SHA-512**       | 覆盖 WebAuthn RS256、SSH `rsa-sha2-256/512`、现有企业证书、PIV 和 OpenPGP 身份；随后补齐 SHA-384 组合。                    |
| **3** | **RSA-PSS + SHA-256，再补 SHA-384 / SHA-512** | 覆盖现代 RSA 认证，特别是企业客户端证书和 mTLS。TLS 1.3 的 RSA 握手签名需要 PSS，仅有 PKCS#1 v1.5 不足以覆盖这一使用场景。 |
| **4** | **P-384 + ECDSA + SHA-384，ES384**            | 扩展企业 PKI、PIV、TLS 和 SSH 的 ECC 配置；主流多协议安全钥匙已有 P-384 支持。                                             |
| **5** | **P-521 + ECDSA + SHA-512，ES512**            | 补充标准 SSH、TLS 等支持的曲线，但其在常见硬件安全钥匙中的新增覆盖价值低于 P-256、P-384。                                  |
| **6** | **Ed25519ph / Ed25519ctx**                    | 为有明确需求的特定协议补预哈希或 context 变体。已有 pure Ed25519 后，这两项对主流 Passkey、SSH 的兼容增量较小。            |

RSA-PSS 排在 P-384 前，是因为本路线将企业客户端证书和 mTLS 纳入目标范围。RSA 密钥长度与签名哈希独立；2048、3072、4096 位的生成、导入和签名能力须分别验证，不能由某一长度的成功推断全部可用。

前两项的依据是 WebAuthn 的 ES256/RS256 兼容需求和 SSH 的 RSA-SHA2 定义；第三项的依据是 TLS 1.3 对 RSA-PSS 的要求。P-384 的覆盖价值还体现在主流 PIV 实现中。[WebAuthn 算法支持](https://developers.yubico.com/WebAuthn/WebAuthn_Developer_Guide/Algorithms.html)、[SSH RSA-SHA2](https://www.rfc-editor.org/rfc/rfc8332.html)、[TLS 1.3 算法要求](https://www.rfc-editor.org/rfc/rfc8446.html#section-9.1)、[YubiKey PIV 支持矩阵](https://developers.yubico.com/PIV/Introduction/YubiKey_and_PIV.html)、[OpenSSH 密钥类型](https://man.openbsd.org/ssh-keygen)。

## OTP 和对称认证支线

HMAC 属于共享密钥的消息鉴别码，不是公钥数字签名，单独安排 **HMAC-SHA-1 → HMAC-SHA-256 → HMAC-SHA-512** 支线。若将 OTP / challenge-response 纳入产品范围，这条支线的优先级高于 P-521 和 Ed25519ph/ctx。

HMAC-SHA-1 用于兼容常见 HOTP/TOTP 配置，与 SHA-1 数字签名是不同的用途。HMAC 原语之外，完整 OTP 功能还需要计数器或时间输入、动态截断、位数配置及凭证管理。[HOTP](https://www.rfc-editor.org/rfc/rfc4226.html)、[TOTP](https://www.rfc-editor.org/rfc/rfc6238.html)。

## 当前固件基线

源码核对基准：`monoid-javacard` 提交 `44ef1081aa7931868a5680e8f2f37a7803136322`。本节描述该快照；实现前应核对最新源码和目标卡型号。

| 能力                           | 当前状态与证据                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secp256k1 ECDSA                | 已有预计算摘要签名路径，原生签名引擎配置 SHA-256。`signPreComputedHash` 不会对输入再次 SHA-256；输出为固定 64 字节的 r、s 顺序拼接，执行 secp256k1 low-S 归一化。[Signer](../../../monoid-javacard/src/main/java/monoid/Signer.java)、[OneShot](../../../monoid-javacard/src/main/java/monoid/OneShot.java)、[LibECDSA](../../../monoid-javacard/src/main/java/monoid/LibECDSA.java)。 |
| pure Ed25519                   | 已有完整消息签名路径，不等于 ctx/ph 变体。[LibED25519](../../../monoid-javacard/src/main/java/monoid/LibED25519.java)。                                                                                                                                                                                                                                                                |
| secp256k1 BIP340 Schnorr       | 已有签名；上层当前限制 32 字节消息，底层函数接受消息长度。[Signer](../../../monoid-javacard/src/main/java/monoid/Signer.java)、[LibBIP340](../../../monoid-javacard/src/main/java/monoid/LibBIP340.java)。                                                                                                                                                                             |
| SHA-256、SHA-512、HMAC-SHA-512 | 已在内部使用。HMAC-SHA-512 有原生尝试及基于 SHA-512 的软件组合；公开为通用功能前需补长密钥处理或明确长度限制。[LibHMACSha512](../../../monoid-javacard/src/main/java/monoid/LibHMACSha512.java)。                                                                                                                                                                                      |
| RSA 模幂                       | 当前仅以 512-bit RSA 对象辅助内部模运算，不是 RSA 身份密钥或通用 RSA 签名能力。[LibMath](../../../monoid-javacard/src/main/java/monoid/LibMath.java)。                                                                                                                                                                                                                                 |

SHA-256、双 SHA-256、Keccak-256 等由主机计算得到的 32 字节摘要，可交给现有 secp256k1 ECDSA 路径。raw/DER 转换和 Ethereum recovery 标志计算也属于协议适配，不作为新增公钥算法排期。BIP340 变长消息和 RFC 6979 确定性 ECDSA 不因能复用现有运算而提前于上述主流兼容缺口。

源码与文档存在一处已确认偏差：当前 [bitcoin.md](../../../monoid-javacard/doc/bitcoin.md) 将 ECDSA 输出描述为 DER，实际实现为 `r || s`。后续适配应按源码行为处理，并在相应维护任务中修正文档。

## Java Card 实现时的验证边界

- **P-256 的已有实卡证据是 GP 验签。** [记录 97](../../../monoid-javacard/.agents/project-memory/97.md)验证了 serial `55690320` 上由主机生成的 P-256/SHA-256 Load/Install Token。它不证明 Monoid Applet 的 Java Card API 已能生成 P-256 密钥或执行签名，也不能直接推广到其他卡。
- **新增曲线需独立验证。** EC XY 运算的存在不证明任意曲线都可用。P-256 需补正确的曲线参数、密钥范围校验和按曲线处理的 low-S；当前 low-S 常量固定为 secp256k1。P-384/P-521 还涉及密钥长度、摘要算法、公钥生成和编码。当前软件模运算及 HD 派生中的 32 字节限制不能直接沿用到更大曲线，新增独立密钥签名也不等于同时支持对应 HD 派生。
- **RSA 需完整密钥与签名路径。** 分别验证目标长度的生成/导入、保存、公钥输出、签名和资源消耗。GP 的算法声明、Token 验签或现有 `RSA_NOPAD` 辅助运算均不能代替这些验证。PSS 必须明确消息哈希、MGF1 哈希和 salt length，按目标协议做互操作验证。
- **签名名称必须对应正确组合。** ES256 是 P-256/SHA-256；ES384 是 P-384/SHA-384；ES512 是 P-521/SHA-512；secp256k1/SHA-256 是 ES256K。SHA-384 不能通过直接截断 SHA-512 输出获得。
- **保留 pure Ed25519 的语义。** `Ed25519(SHA512(message))` 不等于 Ed25519ph。ctx/ph 需要在 nonce 与 challenge 的哈希输入中使用标准域分离，不能用简单前缀或替换现有 pure Ed25519 接口代替。[RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1)。
- **算法能力与协议接入分别验收。** Passkey 仍需 WebAuthn/CTAP、凭证生命周期和用户验证；SSH、PIV、OpenPGP 各需相应适配。算法匹配后，attestation、认证要求及站点/企业策略仍可能限制设备使用。

后续实现应沿上述顺序推进，并分别记录“目标卡原语验证通过”“固件入口实现完成”“目标协议互操作通过”，避免将某一层的成功写成整个 Security Key 场景已经支持。
