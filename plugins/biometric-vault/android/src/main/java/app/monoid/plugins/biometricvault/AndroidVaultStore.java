package app.monoid.plugins.biometricvault;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.charset.CharacterCodingException;
import java.security.GeneralSecurityException;
import java.security.InvalidAlgorithmParameterException;
import java.security.Key;
import java.security.KeyStore;
import java.security.NoSuchAlgorithmException;
import java.security.NoSuchProviderException;
import java.security.UnrecoverableKeyException;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.NoSuchPaddingException;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/** All methods, including Prepared.complete/close, run on the controller's single worker. */
final class AndroidVaultStore implements VaultController.Store {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TAG = "BiometricVault";

    private final KeyStore keyStore;
    private final FileVaultStore files;
    private final File directory;

    AndroidVaultStore(Context context) throws VaultException {
        try {
            directory = new File(context.getNoBackupFilesDir(), "biometric-vault-v1");
            files = new FileVaultStore(directory, AndroidVaultStore::fileExists);
            keyStore = KeyStore.getInstance(KEYSTORE);
            keyStore.load(null);
        } catch (GeneralSecurityException | IOException | RuntimeException exception) {
            throw failure(exception, false);
        }
    }

    @Override
    public VaultController.Prepared prepareSet(String id, String value) throws VaultException {
        String name = nameFor(id);
        byte[] plaintext;

        try {
            plaintext = VaultRecordCodec.encodeText(value, VaultRecordCodec.MAX_VALUE_UTF8_BYTES);
        } catch (IOException exception) {
            throw new VaultException("INVALID_ARGUMENT", "Value must be valid UTF-8 text within the supported size.", exception);
        }

        String newAlias = null;
        byte[] aad = null;
        boolean prepared = false;

        try {
            VaultRecordCodec.Record previous = readRecordForReplacement(name);
            UUID revision = UUID.randomUUID();
            newAlias = VaultRecordCodec.alias(name, revision);
            SecretKey key = generateKey(newAlias);
            validateKey(key);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            aad = VaultRecordCodec.aad(id, revision);

            if (cipher.getIV().length != VaultRecordCodec.IV_BYTES) {
                throw new VaultException("HARDWARE_SECURITY_UNAVAILABLE", "The secure cipher returned an unsupported IV.");
            }

            WritePrepared result = new WritePrepared(
                cipher, name, revision, newAlias,
                previous == null ? null : VaultRecordCodec.alias(name, previous.revision), plaintext, aad
            );
            prepared = true;
            return result;
        } catch (GeneralSecurityException | IOException | RuntimeException exception) {
            throw failure(exception, false);
        } finally {
            if (!prepared) {
                Arrays.fill(plaintext, (byte) 0);
                if (aad != null) {
                    Arrays.fill(aad, (byte) 0);
                }
                deleteKeyQuietly(newAlias);
            }
        }
    }

    @Override
    public VaultController.Prepared prepareGet(String id) throws VaultException {
        String name = nameFor(id);

        try {
            VaultRecordCodec.Record record = readRecord(name);

            if (record == null) {
                return null;
            }

            Key loaded = keyStore.getKey(VaultRecordCodec.alias(name, record.revision), null);

            if (!(loaded instanceof SecretKey)) {
                throw new VaultException("ENTRY_INVALIDATED", "The stored entry's protected key is no longer available.");
            }

            SecretKey key = (SecretKey) loaded;
            validateKey(key);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(VaultRecordCodec.TAG_BYTES * 8, record.iv));
            return new ReadPrepared(cipher, record.ciphertext, VaultRecordCodec.aad(id, record.revision));
        } catch (GeneralSecurityException | IOException | RuntimeException exception) {
            throw failure(exception, true);
        }
    }

    @Override
    public void remove(String id) throws VaultException {
        String name = nameFor(id);

        try {
            VaultRecordCodec.Record previous = readRecordForReplacement(name);
            files.remove(name);

            if (syncDirectory() && previous != null) {
                // The record is already deleted. A key cleanup failure must not resurrect it.
                deleteKeyQuietly(VaultRecordCodec.alias(name, previous.revision));
            }
        } catch (IOException | RuntimeException exception) {
            throw failure(exception, false);
        }
    }

    @Override
    public void clear() throws VaultException {
        try {
            VaultClearer.clear(files, keyStore.aliases(), this::syncDirectoryStrictly, keyStore::deleteEntry);
        } catch (GeneralSecurityException | IOException | RuntimeException exception) {
            // Cleanup can be partial; expose observable failures so the caller can retry.
            throw new VaultException("IO_ERROR", "The protected storage operation failed.", exception);
        }
    }

    private String nameFor(String id) throws VaultException {
        try {
            return VaultRecordCodec.fileName(id);
        } catch (IOException exception) {
            throw new VaultException("INVALID_ARGUMENT", "ID must be valid UTF-8 text within the supported size.", exception);
        }
    }

    private VaultRecordCodec.Record readRecord(String name) throws IOException {
        byte[] bytes = files.read(name);
        return bytes == null ? null : VaultRecordCodec.decode(bytes);
    }

    private VaultRecordCodec.Record readRecordForReplacement(String name) throws IOException {
        try {
            return readRecord(name);
        } catch (VaultRecordCodec.MalformedRecordException exception) {
            // Explicit set/remove may recover a corrupt entry; never trust it to select a key.
            return null;
        }
    }

    private SecretKey generateKey(String alias) throws GeneralSecurityException {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true);

        if (Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(-1);
        }

        if (Build.VERSION.SDK_INT >= 24) {
            spec.setInvalidatedByBiometricEnrollment(true);
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(spec.build());
        return generator.generateKey();
    }

    private void validateKey(SecretKey key) throws GeneralSecurityException, VaultException {
        KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .getKeySpec(key, KeyInfo.class);
        boolean hardware;

        if (Build.VERSION.SDK_INT >= 31) {
            int security = info.getSecurityLevel();
            hardware = security == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
                || security == KeyProperties.SECURITY_LEVEL_STRONGBOX
                || security == KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE;
        } else {
            hardware = info.isInsideSecureHardware();
        }

        VaultKeyPolicy.requireHardwareBiometrics(
            hardware, info.isUserAuthenticationRequired(), info.isUserAuthenticationRequirementEnforcedBySecureHardware(),
            info.getUserAuthenticationValidityDurationSeconds(),
            Build.VERSION.SDK_INT < 30 || info.getUserAuthenticationType() == KeyProperties.AUTH_BIOMETRIC_STRONG,
            Build.VERSION.SDK_INT < 24 || info.isInvalidatedByBiometricEnrollment()
        );

        if (info.getKeySize() != 256
            || info.getOrigin() != KeyProperties.ORIGIN_GENERATED
            || info.getPurposes() != (KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            || !Arrays.equals(info.getBlockModes(), new String[] { KeyProperties.BLOCK_MODE_GCM })
            || !Arrays.equals(info.getEncryptionPaddings(), new String[] { KeyProperties.ENCRYPTION_PADDING_NONE })) {
            throw new VaultException("HARDWARE_SECURITY_UNAVAILABLE", "The key does not meet the vault's cryptographic policy.");
        }
    }

    private void deleteKeyQuietly(String alias) {
        if (alias == null) {
            return;
        }

        try {
            keyStore.deleteEntry(alias);
        } catch (GeneralSecurityException | RuntimeException exception) {
            // No identifiers, plaintext, or provider exception details enter logs.
            Log.w(TAG, "Could not clean up an unused vault key.");
        }
    }

    private boolean syncDirectory() {
        try {
            syncDirectoryStrictly();
            return true;
        } catch (IOException | RuntimeException exception) {
            // Keep the previous key if persistence of the new directory entry is uncertain.
            Log.w(TAG, "Could not confirm vault directory persistence; retaining the previous key.");
            return false;
        }
    }

    private void syncDirectoryStrictly() throws IOException {
        FileDescriptor descriptor = null;

        try {
            descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            Os.fsync(descriptor);
        } catch (ErrnoException exception) {
            throw new IOException("Could not persist the vault directory.", exception);
        } finally {
            if (descriptor != null) {
                try {
                    Os.close(descriptor);
                } catch (ErrnoException exception) {
                    throw new IOException("Could not close the vault directory handle.", exception);
                }
            }
        }
    }

    private static boolean fileExists(File file) throws IOException {
        try {
            Os.stat(file.getAbsolutePath());
            return true;
        } catch (ErrnoException exception) {
            if (exception.errno == OsConstants.ENOENT) {
                return false;
            }

            throw new IOException("Could not inspect the vault record.", exception);
        }
    }

    static VaultException failure(Exception exception, boolean reading) {
        boolean legacyInvalidation = false;

        for (Throwable cause = exception; cause != null; cause = cause.getCause()) {
            if (cause instanceof KeyPermanentlyInvalidatedException) {
                return new VaultException("ENTRY_INVALIDATED", "The stored entry's protected key is no longer available.", exception);
            }

            // Older providers discard the permanent-invalidation cause. Modern providers also
            // wrap transient service failures, so an unknown retained cause must stay IO_ERROR.
            if (cause instanceof UnrecoverableKeyException && cause.getCause() == null) {
                legacyInvalidation = true;
            }

            if (cause instanceof UserNotAuthenticatedException) {
                return new VaultException("AUTHENTICATION_FAILED", "The protected operation was not authorized.", exception);
            }

            if (cause instanceof NoSuchAlgorithmException || cause instanceof NoSuchProviderException
                || cause instanceof NoSuchPaddingException || cause instanceof InvalidAlgorithmParameterException
                || cause instanceof UnsupportedOperationException) {
                return new VaultException("HARDWARE_SECURITY_UNAVAILABLE", "The secure provider cannot support the vault's cryptographic policy.", exception);
            }
        }

        if (legacyInvalidation) {
            return new VaultException("ENTRY_INVALIDATED", "The stored entry's protected key is no longer available.", exception);
        }

        if (exception instanceof VaultRecordCodec.MalformedRecordException
            || exception instanceof CharacterCodingException || (reading && exception instanceof BadPaddingException)) {
            return new VaultException("DATA_CORRUPTED", "The stored entry failed its integrity or format check.", exception);
        }

        return new VaultException("IO_ERROR", "The protected storage operation failed.", exception);
    }

    private abstract class Prepared implements VaultController.Prepared {
        Cipher operation;
        final byte[] aad;
        private boolean closed;
        private boolean completed;

        Prepared(Cipher operation, byte[] aad) {
            this.operation = operation;
            this.aad = aad;
        }

        @Override
        public Cipher cipher() {
            return operation;
        }

        final void beginComplete() throws VaultException {
            if (closed || completed) {
                throw new VaultException("IO_ERROR", "The protected operation is no longer pending.");
            }

            completed = true;
        }

        @Override
        public final void close() {
            if (closed) {
                return;
            }

            closed = true;
            operation = null;
            Arrays.fill(aad, (byte) 0);
            cleanup();
        }

        abstract void cleanup();
    }

    private final class WritePrepared extends Prepared {
        private final String name;
        private final UUID revision;
        private final String alias;
        private final String previousAlias;
        private final byte[] plaintext;
        private FileVaultStore.PendingWrite pending;
        private boolean committed;

        WritePrepared(Cipher cipher, String name, UUID revision, String alias, String previousAlias, byte[] plaintext, byte[] aad) {
            super(cipher, aad);
            this.name = name;
            this.revision = revision;
            this.alias = alias;
            this.previousAlias = previousAlias;
            this.plaintext = plaintext;
        }

        @Override
        public String complete(VaultController.CommitGate gate) throws VaultException {
            beginComplete();

            try {
                // AAD updates reach KeyMint too, so they must follow CryptoObject authentication.
                operation.updateAAD(aad);
                byte[] ciphertext = operation.doFinal(plaintext);
                byte[] encoded = VaultRecordCodec.encode(new VaultRecordCodec.Record(revision, operation.getIV(), ciphertext));
                pending = files.stage(name, encoded);

                gate.commit(() -> {
                    try {
                        pending.commit();
                        committed = true;
                    } catch (IOException exception) {
                        throw failure(exception, false);
                    }
                });
            } catch (GeneralSecurityException | IOException | RuntimeException exception) {
                throw failure(exception, false);
            }

            // The new record now owns its key. Cleanup cannot turn a committed set into a failure.
            if (syncDirectory()) {
                deleteKeyQuietly(previousAlias);
            }
            return null;
        }

        @Override
        void cleanup() {
            Arrays.fill(plaintext, (byte) 0);

            if (pending != null) {
                try {
                    pending.close();
                } catch (IOException | RuntimeException exception) {
                    Log.w(TAG, "Could not clean up a pending vault file.");
                }
            }

            if (!committed) {
                deleteKeyQuietly(alias);
            }
        }
    }

    private final class ReadPrepared extends Prepared {
        private final byte[] ciphertext;

        ReadPrepared(Cipher cipher, byte[] ciphertext, byte[] aad) {
            super(cipher, aad);
            this.ciphertext = ciphertext;
        }

        @Override
        public String complete(VaultController.CommitGate gate) throws VaultException {
            beginComplete();
            byte[] plaintext = null;

            try {
                operation.updateAAD(aad);
                plaintext = operation.doFinal(ciphertext);
                // Reads remain cancellable until the control executor delivers their plaintext.
                return VaultRecordCodec.decodeText(plaintext);
            } catch (GeneralSecurityException | IOException | RuntimeException exception) {
                throw failure(exception, true);
            } finally {
                if (plaintext != null) {
                    Arrays.fill(plaintext, (byte) 0);
                }
            }
        }

        @Override
        void cleanup() {
            Arrays.fill(ciphertext, (byte) 0);
        }
    }
}
