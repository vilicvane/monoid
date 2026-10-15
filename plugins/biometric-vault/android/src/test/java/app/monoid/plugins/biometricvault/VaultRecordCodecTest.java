package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.junit.Test;

public class VaultRecordCodecTest {
    @Test
    public void recordRoundTripPreservesMaximumPayload() throws Exception {
        VaultRecordCodec.Record original = record(VaultRecordCodec.MAX_VALUE_UTF8_BYTES + VaultRecordCodec.TAG_BYTES);
        byte[] encoded = VaultRecordCodec.encode(original);
        assertEquals(VaultRecordCodec.MAX_RECORD_BYTES, encoded.length);
        VaultRecordCodec.Record decoded = VaultRecordCodec.decode(encoded);
        assertEquals(original.revision, decoded.revision);
        assertArrayEquals(original.iv, decoded.iv);
        assertArrayEquals(original.ciphertext, decoded.ciphertext);
    }

    @Test
    public void truncatedAndExtendedRecordsAreRejected() throws Exception {
        byte[] encoded = VaultRecordCodec.encode(record(32));

        for (int length = 0; length < encoded.length; length++) {
            byte[] truncated = Arrays.copyOf(encoded, length);
            assertThrows(VaultRecordCodec.MalformedRecordException.class, () -> VaultRecordCodec.decode(truncated));
        }

        assertThrows(VaultRecordCodec.MalformedRecordException.class,
            () -> VaultRecordCodec.decode(Arrays.copyOf(encoded, encoded.length + 1)));
    }

    @Test
    public void unsupportedVersionAndUntrustedRevisionAreRejected() throws Exception {
        byte[] encoded = VaultRecordCodec.encode(record(32));
        encoded[4] = 2;
        assertThrows(VaultRecordCodec.MalformedRecordException.class, () -> VaultRecordCodec.decode(encoded));
        encoded[4] = 1;
        Arrays.fill(encoded, 5, 21, (byte) 0);
        assertThrows(VaultRecordCodec.MalformedRecordException.class, () -> VaultRecordCodec.decode(encoded));
    }

    @Test
    public void ciphertextLengthsCannotDriveUnboundedAllocation() throws Exception {
        byte[] encoded = VaultRecordCodec.encode(record(32));

        for (int length : new int[] { -1, 0, 15, 31, 33, Integer.MAX_VALUE }) {
            ByteBuffer.wrap(encoded).putInt(33, length);
            assertThrows(VaultRecordCodec.MalformedRecordException.class, () -> VaultRecordCodec.decode(encoded));
        }

        assertThrows(VaultRecordCodec.MalformedRecordException.class,
            () -> VaultRecordCodec.decode(new byte[VaultRecordCodec.MAX_RECORD_BYTES + 1]));
    }

    @Test
    public void textLimitsCountUtf8BytesAndRejectInvalidUnicode() throws Exception {
        assertEquals(0, VaultRecordCodec.encodeText("", 0).length);
        assertArrayEquals(new byte[] { (byte) 0xC3, (byte) 0xA9 }, VaultRecordCodec.encodeText("é", 2));
        assertThrows(IOException.class, () -> VaultRecordCodec.encodeText("é", 1));
        assertThrows(CharacterCodingException.class, () -> VaultRecordCodec.encodeText("\uD800", 4));
        assertThrows(CharacterCodingException.class, () -> VaultRecordCodec.decodeText(new byte[] { (byte) 0xC0, (byte) 0xAF }));
        assertThrows(CharacterCodingException.class, () -> VaultRecordCodec.decodeText(new byte[] { (byte) 0xED, (byte) 0xA0, (byte) 0x80 }));
        assertEquals("\0秘密🔑", VaultRecordCodec.decodeText(VaultRecordCodec.encodeText("\0秘密🔑", 64)));
    }

    @Test
    public void namesAndAliasesAreScopedToTheExactId() throws Exception {
        String first = VaultRecordCodec.fileName("../secret");
        String second = VaultRecordCodec.fileName("secret");
        UUID revision = UUID.randomUUID();
        assertTrue(first.matches("[0-9a-f]{64}"));
        assertNotEquals(first, second);
        assertNotEquals(VaultRecordCodec.alias(first, revision), VaultRecordCodec.alias(second, revision));
        assertTrue(VaultRecordCodec.alias(first, revision).startsWith(VaultRecordCodec.ALIAS_PREFIX + first + "."));
    }

    @Test
    public void gcmRecordBindsEntryIdRevisionIvAndCiphertext() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        SecretKey key = generator.generateKey();
        UUID revision = UUID.randomUUID();
        String id = "example:秘密";
        byte[] plaintext = "secret 🔑".getBytes(StandardCharsets.UTF_8);
        Cipher encryption = Cipher.getInstance("AES/GCM/NoPadding");
        encryption.init(Cipher.ENCRYPT_MODE, key);
        encryption.updateAAD(VaultRecordCodec.aad(id, revision));
        VaultRecordCodec.Record record = VaultRecordCodec.decode(VaultRecordCodec.encode(
            new VaultRecordCodec.Record(revision, encryption.getIV(), encryption.doFinal(plaintext))
        ));

        assertArrayEquals(plaintext, decrypt(key, id, revision, record.iv, record.ciphertext));
        assertThrows(AEADBadTagException.class, () -> decrypt(key, "other", revision, record.iv, record.ciphertext));
        assertThrows(AEADBadTagException.class, () -> decrypt(key, id, UUID.randomUUID(), record.iv, record.ciphertext));
        byte[] changedIv = record.iv.clone();
        changedIv[0] ^= 1;
        assertThrows(AEADBadTagException.class, () -> decrypt(key, id, revision, changedIv, record.ciphertext));
        byte[] changedCiphertext = record.ciphertext.clone();
        changedCiphertext[0] ^= 1;
        assertThrows(AEADBadTagException.class, () -> decrypt(key, id, revision, record.iv, changedCiphertext));
    }

    private static VaultRecordCodec.Record record(int ciphertextLength) {
        byte[] iv = new byte[VaultRecordCodec.IV_BYTES];
        Arrays.fill(iv, (byte) 0xA5);
        byte[] ciphertext = new byte[ciphertextLength];
        Arrays.fill(ciphertext, (byte) 0x5A);
        return new VaultRecordCodec.Record(UUID.randomUUID(), iv, ciphertext);
    }

    private static byte[] decrypt(SecretKey key, String id, UUID revision, byte[] iv, byte[] ciphertext) throws Exception {
        Cipher decryption = Cipher.getInstance("AES/GCM/NoPadding");
        decryption.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        decryption.updateAAD(VaultRecordCodec.aad(id, revision));
        return decryption.doFinal(ciphertext);
    }
}
