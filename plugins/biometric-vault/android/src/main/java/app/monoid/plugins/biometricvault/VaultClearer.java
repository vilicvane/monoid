package app.monoid.plugins.biometricvault;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

/** Orders destructive cleanup without reading records, obtaining keys, or authenticating. */
final class VaultClearer {
    interface DirectorySync {
        void sync() throws IOException;
    }

    interface KeyDeletion {
        void delete(String alias) throws GeneralSecurityException;
    }

    private VaultClearer() {}

    static void clear(FileVaultStore files, Enumeration<String> aliases, DirectorySync directorySync, KeyDeletion deletion)
        throws IOException, GeneralSecurityException {
        List<String> ownedAliases = new ArrayList<>();

        // Android may enumerate in batches. Finish the snapshot before changing the key store.
        // Public AndroidKeyStore providers can hide internal enumeration errors as an empty batch.
        while (aliases.hasMoreElements()) {
            String alias = aliases.nextElement();

            if (alias.startsWith(VaultRecordCodec.ALIAS_PREFIX)) {
                ownedAliases.add(alias);
            }
        }

        files.clear();
        // Persist file removal before destroying keys which an older directory entry could reference.
        directorySync.sync();

        for (String alias : ownedAliases) {
            deletion.delete(alias);
        }
    }
}
