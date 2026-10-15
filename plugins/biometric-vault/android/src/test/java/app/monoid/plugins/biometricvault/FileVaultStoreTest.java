package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class FileVaultStoreTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void replacementIsInvisibleUntilCommitAndCloseDoesNotUndoCommit() throws Exception {
        FileVaultStore store = store(temporary.newFolder());
        String name = VaultRecordCodec.fileName("entry");
        byte[] oldValue = { 1, 2, 3 };
        byte[] newValue = { 4, 5 };
        assertNull(store.read(name));
        save(store, name, oldValue);

        try (FileVaultStore.PendingWrite write = store.stage(name, newValue)) {
            assertArrayEquals(oldValue, store.read(name));
            write.commit();
            assertArrayEquals(newValue, store.read(name));
        }

        assertArrayEquals(newValue, store.read(name));
    }

    @Test
    public void cancellationPreservesThePreviousRecordAndClosesIdempotently() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });
        FileVaultStore.PendingWrite write = store.stage(name, new byte[] { 2 });
        write.close();
        write.close();
        assertArrayEquals(new byte[] { 1 }, store.read(name));
        assertFalse(new File(directory, name + ".new").exists());
        assertThrows(IOException.class, write::commit);
    }

    @Test
    public void cancelledInitialWriteRemainsMissing() throws Exception {
        FileVaultStore store = store(temporary.newFolder());
        String name = VaultRecordCodec.fileName("entry");
        store.stage(name, new byte[] { 1 }).close();
        assertNull(store.read(name));
    }

    @Test
    public void failedRenameDoesNotDeleteThePreviousRecord() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });

        try (FileVaultStore.PendingWrite write = store.stage(name, new byte[] { 2 })) {
            assertTrue(new File(directory, name + ".new").delete());
            assertThrows(IOException.class, write::commit);
            assertArrayEquals(new byte[] { 1 }, store.read(name));
        }
    }

    @Test
    public void falseRenameResultDoesNotDeleteThePreviousRecord() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });
        FileVaultStore failing = new FileVaultStore(directory, (source, target) -> false, FileVaultStoreTest::exists);

        try (FileVaultStore.PendingWrite write = failing.stage(name, new byte[] { 2 })) {
            assertThrows(IOException.class, write::commit);
            assertArrayEquals(new byte[] { 1 }, store.read(name));
        }
    }

    @Test
    public void readDoesNotTreatAnAccessErrorAsAMissingRecord() throws Exception {
        IOException accessError = new IOException("Simulated EACCES");
        FileVaultStore store = new FileVaultStore(temporary.newFolder(), file -> { throw accessError; });
        String name = VaultRecordCodec.fileName("entry");
        assertSame(accessError, assertThrows(IOException.class, () -> store.read(name)));
    }

    @Test
    public void removeDoesNotTreatAnAccessErrorAsSuccessfulDeletion() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore working = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(working, name, new byte[] { 1 });
        IOException accessError = new IOException("Simulated EIO");
        FileVaultStore failing = new FileVaultStore(directory, file -> { throw accessError; });
        assertSame(accessError, assertThrows(IOException.class, () -> failing.remove(name)));
        assertArrayEquals(new byte[] { 1 }, working.read(name));
        assertSame(accessError, assertThrows(IOException.class, () -> failing.remove(VaultRecordCodec.fileName("missing"))));
    }

    @Test
    public void confirmedAbsentRecordIsNullAndDeletionIsIdempotent() throws Exception {
        FileVaultStore store = store(temporary.newFolder());
        String name = VaultRecordCodec.fileName("missing");
        assertNull(store.read(name));
        store.remove(name);
        store.remove(name);
        assertNull(store.read(name));
    }

    @Test
    public void failedStagingDoesNotDeleteThePreviousRecord() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });
        File blockedTemporary = new File(directory, name + ".new");
        assertTrue(blockedTemporary.mkdir());
        assertTrue(new File(blockedTemporary, "occupied").createNewFile());
        assertThrows(IOException.class, () -> store.stage(name, new byte[] { 2 }));
        assertArrayEquals(new byte[] { 1 }, store.read(name));
    }

    @Test
    public void abandonedTemporaryFileCannotReplaceTheCommittedRecordOnRead() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });

        try (FileOutputStream output = new FileOutputStream(new File(directory, name + ".new"))) {
            output.write(new byte[] { 99 });
        }

        assertArrayEquals(new byte[] { 1 }, store(directory).read(name));
        save(store, name, new byte[] { 2 });
        assertArrayEquals(new byte[] { 2 }, store.read(name));
    }

    @Test
    public void malformedOversizedRecordIsBoundedAndCanBeRemoved() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");

        try (RandomAccessFile output = new RandomAccessFile(new File(directory, name), "rw")) {
            output.setLength(VaultRecordCodec.MAX_RECORD_BYTES + 1);
        }

        assertThrows(VaultRecordCodec.MalformedRecordException.class, () -> store.read(name));
        store.remove(name);
        store.remove(name);
        assertNull(store.read(name));
    }

    @Test
    public void recordsRemainIndependentAndRemoveAlsoDiscardsPendingBytes() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String first = VaultRecordCodec.fileName("a");
        String second = VaultRecordCodec.fileName("b");
        save(store, first, new byte[] { 1 });
        save(store, second, new byte[] { 2 });
        store.stage(first, new byte[] { 3 });
        store.remove(first);
        assertNull(store.read(first));
        assertFalse(new File(directory, first + ".new").exists());
        assertArrayEquals(new byte[] { 2 }, store.read(second));
    }

    @Test
    public void clearRemovesRecordsAndAbandonedWritesWithoutDecodingAndPreservesOtherFiles() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        String first = VaultRecordCodec.fileName("first");
        String corrupt = VaultRecordCodec.fileName("corrupt");
        String pending = VaultRecordCodec.fileName("pending");
        save(store, first, new byte[] { 1, 2 });
        store.stage(pending, new byte[] { 3 });

        try (RandomAccessFile output = new RandomAccessFile(new File(directory, corrupt), "rw")) {
            output.setLength(VaultRecordCodec.MAX_RECORD_BYTES + 1);
        }

        File unrelated = new File(directory, "unrelated");
        File otherSuffix = new File(directory, first + ".backup");
        File nested = new File(directory, "unrelated-directory");
        assertTrue(unrelated.createNewFile());
        assertTrue(otherSuffix.createNewFile());
        assertTrue(nested.mkdir());
        File nestedRecord = new File(nested, first);
        assertTrue(nestedRecord.createNewFile());

        store.clear();
        store.clear();

        assertNull(store.read(first));
        assertNull(store.read(corrupt));
        assertFalse(new File(directory, pending + ".new").exists());
        assertTrue(unrelated.exists());
        assertTrue(otherSuffix.exists());
        assertTrue(nestedRecord.exists());
    }

    @Test
    public void clearDoesNotTreatAnEnumerationFailureAsAnEmptyVault() throws Exception {
        File directory = temporary.newFolder();
        File inaccessible = new File(directory.getAbsolutePath()) {
            @Override
            public File[] listFiles() {
                return null;
            }
        };
        FileVaultStore store = store(directory);
        String name = VaultRecordCodec.fileName("entry");
        save(store, name, new byte[] { 1 });

        assertThrows(IOException.class, () -> store(inaccessible).clear());
        assertArrayEquals(new byte[] { 1 }, store.read(name));
    }

    @Test
    public void clearRejectsFailedDeletionWithoutRecursivelyDeletingUnexpectedDirectories() throws Exception {
        File directory = temporary.newFolder();
        FileVaultStore store = store(directory);
        File blocked = new File(directory, VaultRecordCodec.fileName("unexpected directory"));
        assertTrue(blocked.mkdir());
        File child = new File(blocked, "keep");
        assertTrue(child.createNewFile());

        assertThrows(IOException.class, store::clear);
        assertTrue(child.exists());

        assertTrue(child.delete());
        assertTrue(blocked.delete());
        store.clear();
    }

    private static FileVaultStore store(File directory) throws IOException {
        // Java's Windows renameTo cannot replace an existing file. This has the same atomic
        // replacement semantics as Android/Linux renameTo without deleting the old file first.
        return new FileVaultStore(directory, (source, target) -> {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return true;
        }, FileVaultStoreTest::exists);
    }

    private static boolean exists(File file) throws IOException {
        try {
            Files.readAttributes(file.toPath(), BasicFileAttributes.class);
            return true;
        } catch (NoSuchFileException exception) {
            return false;
        }
    }

    private static void save(FileVaultStore store, String name, byte[] value) throws IOException {
        try (FileVaultStore.PendingWrite write = store.stage(name, value)) {
            write.commit();
        }
    }
}
