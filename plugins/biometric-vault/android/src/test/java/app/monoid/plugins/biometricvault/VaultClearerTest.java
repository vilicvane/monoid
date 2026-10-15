package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.KeyStoreException;
import java.security.ProviderException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.UUID;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class VaultClearerTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void snapshotsAliasesBeforeDeletingOnlyOwnedKeysIncludingOrphans() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        File record = new File(directory, VaultRecordCodec.fileName("saved"));
        assertTrue(record.createNewFile());
        String saved = ownedAlias("saved");
        String orphan = ownedAlias("orphan");
        String foreign = "app.other.vault.key";
        String similar = "app.monoid.biometric-vault.v10.key";
        String noSeparator = "app.monoid.biometric-vault.v1-other.key";
        List<String> remaining = new ArrayList<>(List.of(saved, foreign, orphan, similar, noSeparator));
        List<String> events = new ArrayList<>();

        VaultClearer.clear(store, Collections.enumeration(remaining), () -> {
            assertFalse(record.exists());
            events.add("sync");
        }, alias -> {
            assertEquals("sync", events.get(0));
            assertTrue(remaining.remove(alias));
            events.add(alias);
        });

        assertEquals(List.of(foreign, similar, noSeparator), remaining);
        assertEquals(List.of("sync", saved, orphan), events);
        VaultClearer.clear(store, Collections.enumeration(remaining), () -> {}, alias -> fail("Foreign key selected"));
    }

    @Test
    public void observableEnumerationFailureDoesNotDeleteFilesOrKeys() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        File record = new File(directory, VaultRecordCodec.fileName("entry"));
        assertTrue(record.createNewFile());
        ProviderException failure = new ProviderException("Enumeration failed");
        String firstAlias = ownedAlias("entry");
        Enumeration<String> aliases = new Enumeration<String>() {
            private boolean returnedFirst;

            @Override
            public boolean hasMoreElements() {
                if (returnedFirst) {
                    throw failure;
                }
                return true;
            }

            @Override
            public String nextElement() {
                returnedFirst = true;
                return firstAlias;
            }
        };

        assertSame(failure, assertThrows(ProviderException.class, () -> VaultClearer.clear(
            store, aliases, () -> fail("Directory sync must not run"), alias -> fail("Key deletion must not run")
        )));
        assertTrue(record.exists());
    }

    @Test
    public void fileDeletionFailureRetainsKeys() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        File blocked = new File(directory, VaultRecordCodec.fileName("entry"));
        assertTrue(blocked.mkdir());
        assertTrue(new File(blocked, "child").createNewFile());

        assertThrows(IOException.class, () -> VaultClearer.clear(
            store, Collections.enumeration(List.of(ownedAlias("entry"))),
            () -> fail("Directory sync must not run"), alias -> fail("Key deletion must not run")
        ));
    }

    @Test
    public void directorySyncFailureRemainsAnErrorAndRetainsKeys() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        File record = new File(directory, VaultRecordCodec.fileName("entry"));
        assertTrue(record.createNewFile());
        IOException failure = new IOException("Directory sync failed");

        assertSame(failure, assertThrows(IOException.class, () -> VaultClearer.clear(
            store, Collections.enumeration(List.of(ownedAlias("entry"))),
            () -> { throw failure; }, alias -> fail("Key deletion must not run")
        )));
        assertFalse(record.exists());
    }

    @Test
    public void keyDeletionFailureIsReportedAndPartialCleanupCanBeRetried() throws Exception {
        FileVaultStore store = store(temporary.newFolder());
        String first = ownedAlias("first");
        String second = ownedAlias("second");
        List<String> remaining = new ArrayList<>(List.of(first, second));
        KeyStoreException failure = new KeyStoreException("Deletion failed");

        assertSame(failure, assertThrows(KeyStoreException.class, () -> VaultClearer.clear(
            store, Collections.enumeration(remaining), () -> {}, alias -> {
                if (alias.equals(second)) {
                    throw failure;
                }
                remaining.remove(alias);
            }
        )));
        assertEquals(List.of(second), remaining);

        VaultClearer.clear(store, Collections.enumeration(remaining), () -> {}, remaining::remove);
        assertTrue(remaining.isEmpty());
    }

    private static String ownedAlias(String id) throws IOException {
        return VaultRecordCodec.alias(VaultRecordCodec.fileName(id), UUID.randomUUID());
    }

    private static FileVaultStore store(File directory) throws IOException {
        return new FileVaultStore(directory, file -> {
            try {
                Files.readAttributes(file.toPath(), BasicFileAttributes.class);
                return true;
            } catch (NoSuchFileException exception) {
                return false;
            }
        });
    }
}
