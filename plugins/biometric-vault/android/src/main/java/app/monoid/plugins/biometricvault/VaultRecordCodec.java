package app.monoid.plugins.biometricvault;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.UUID;

final class VaultRecordCodec {
    static final int MAX_ID_UTF8_BYTES = 512;
    static final int MAX_VALUE_UTF8_BYTES = 64 * 1024;
    static final int IV_BYTES = 12;
    static final int TAG_BYTES = 16;
    static final int MAX_RECORD_BYTES = 4 + 1 + 16 + IV_BYTES + 4 + MAX_VALUE_UTF8_BYTES + TAG_BYTES;
    static final String ALIAS_PREFIX = "app.monoid.biometric-vault.v1.";

    private static final int MAGIC = 0x42565431;
    private static final int VERSION = 1;
    private static final byte[] NAMESPACE = ALIAS_PREFIX.getBytes(StandardCharsets.US_ASCII);

    static final class Record {
        final UUID revision;
        final byte[] iv;
        final byte[] ciphertext;

        Record(UUID revision, byte[] iv, byte[] ciphertext) {
            this.revision = revision;
            this.iv = iv;
            this.ciphertext = ciphertext;
        }
    }

    static final class MalformedRecordException extends IOException {
        MalformedRecordException(String message) {
            super(message);
        }

        MalformedRecordException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private VaultRecordCodec() {}

    static byte[] encodeText(String value, int maxBytes) throws IOException {
        // UTF-8 needs at least as many bytes as UTF-16 code units for valid text.
        if (value.length() > maxBytes) {
            throw new IOException("Text exceeds the supported size.");
        }

        ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(value));

        try {
            if (encoded.remaining() > maxBytes) {
                throw new IOException("Text exceeds the supported size.");
            }

            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            return bytes;
        } finally {
            if (encoded.hasArray()) {
                Arrays.fill(encoded.array(), (byte) 0);
            }
        }
    }

    static String decodeText(byte[] value) throws CharacterCodingException {
        CharBuffer decoded = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(value));

        try {
            return decoded.toString();
        } finally {
            if (decoded.hasArray()) {
                Arrays.fill(decoded.array(), '\0');
            }
        }
    }

    static String fileName(String id) throws IOException {
        byte[] bytes = encodeText(id, MAX_ID_UTF8_BYTES);

        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder name = new StringBuilder(64);

            for (byte value : digest) {
                name.append(Character.forDigit((value >>> 4) & 15, 16));
                name.append(Character.forDigit(value & 15, 16));
            }

            return name.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new AssertionError("SHA-256 is required by the Java platform.", exception);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    static String alias(String fileName, UUID revision) {
        return ALIAS_PREFIX + fileName + "." + revision;
    }

    static byte[] aad(String id, UUID revision) throws IOException {
        byte[] idBytes = encodeText(id, MAX_ID_UTF8_BYTES);

        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            DataOutputStream output = new DataOutputStream(bytes);
            output.write(NAMESPACE);
            output.writeByte(VERSION);
            output.writeShort(idBytes.length);
            output.write(idBytes);
            output.writeLong(revision.getMostSignificantBits());
            output.writeLong(revision.getLeastSignificantBits());
            return bytes.toByteArray();
        } finally {
            Arrays.fill(idBytes, (byte) 0);
        }
    }

    static byte[] encode(Record record) throws IOException {
        validate(record);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        output.writeInt(MAGIC);
        output.writeByte(VERSION);
        output.writeLong(record.revision.getMostSignificantBits());
        output.writeLong(record.revision.getLeastSignificantBits());
        output.write(record.iv);
        output.writeInt(record.ciphertext.length);
        output.write(record.ciphertext);
        return bytes.toByteArray();
    }

    static Record decode(byte[] bytes) throws MalformedRecordException {
        if (bytes.length > MAX_RECORD_BYTES) {
            throw new MalformedRecordException("Vault record exceeds the supported size.");
        }

        try {
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes));

            if (input.readInt() != MAGIC || input.readUnsignedByte() != VERSION) {
                throw new MalformedRecordException("Vault record format is not supported.");
            }

            UUID revision = new UUID(input.readLong(), input.readLong());
            byte[] iv = new byte[IV_BYTES];
            input.readFully(iv);
            int ciphertextLength = input.readInt();

            if (ciphertextLength < TAG_BYTES || ciphertextLength > MAX_VALUE_UTF8_BYTES + TAG_BYTES
                || ciphertextLength != input.available()) {
                throw new MalformedRecordException("Vault record length is invalid.");
            }

            byte[] ciphertext = new byte[ciphertextLength];
            input.readFully(ciphertext);
            Record record = new Record(revision, iv, ciphertext);
            validate(record);
            return record;
        } catch (MalformedRecordException exception) {
            throw exception;
        } catch (IOException exception) {
            throw new MalformedRecordException("Vault record is truncated.", exception);
        }
    }

    private static void validate(Record record) throws MalformedRecordException {
        if (record.revision.version() != 4 || record.revision.variant() != 2
            || record.iv.length != IV_BYTES || record.ciphertext.length < TAG_BYTES
            || record.ciphertext.length > MAX_VALUE_UTF8_BYTES + TAG_BYTES) {
            throw new MalformedRecordException("Vault record fields are invalid.");
        }
    }
}
