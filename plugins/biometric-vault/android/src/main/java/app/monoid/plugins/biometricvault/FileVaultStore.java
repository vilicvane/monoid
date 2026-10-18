package app.monoid.plugins.biometricvault;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.regex.Pattern;

/** Access is serialized by VaultController; names are SHA-256 digests, never caller paths. */
final class FileVaultStore {
    private static final Pattern OWNED_FILE_NAME = Pattern.compile("[0-9a-f]{64}(?:\\.new)?");

    interface FileMover {
        boolean move(File source, File target) throws IOException;
    }

    interface FilePresence {
        boolean exists(File file) throws IOException;
    }

    private final File directory;
    private final FileMover mover;
    private final FilePresence presence;

    FileVaultStore(File directory, FilePresence presence) throws IOException {
        this(directory, File::renameTo, presence);
    }

    FileVaultStore(File directory, FileMover mover, FilePresence presence) throws IOException {
        this.directory = directory;
        this.mover = mover;
        this.presence = presence;

        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Could not create the vault directory.");
        }
    }

    byte[] read(String name) throws IOException {
        File record = file(name);

        try (FileInputStream input = new FileInputStream(record)) {
            long length = input.getChannel().size();

            if (length > VaultRecordCodec.MAX_RECORD_BYTES) {
                throw new VaultRecordCodec.MalformedRecordException("Vault record exceeds the supported size.");
            }

            byte[] bytes = new byte[(int) length];
            int offset = 0;

            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);

                if (count < 0) {
                    throw new VaultRecordCodec.MalformedRecordException("Vault record is truncated.");
                }

                offset += count;
            }

            if (input.read() != -1) {
                throw new VaultRecordCodec.MalformedRecordException("Vault record length changed while reading.");
            }

            return bytes;
        } catch (FileNotFoundException exception) {
            if (!presence.exists(record)) {
                return null;
            }

            throw exception;
        }
    }

    PendingWrite stage(String name, byte[] bytes) throws IOException {
        if (bytes.length > VaultRecordCodec.MAX_RECORD_BYTES) {
            throw new IOException("Vault record exceeds the supported size.");
        }

        File target = file(name);
        File temporary = new File(directory, name + ".new");

        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
            output.getFD().sync();
        } catch (IOException exception) {
            temporary.delete();
            throw exception;
        }

        return new PendingWrite(target, temporary, mover, presence);
    }

    void remove(String name) throws IOException {
        delete(new File(directory, name + ".new"), presence);
        // The visible record deletion is the final, irreversible mutation inside CommitGate.
        delete(file(name), presence);
    }

    void clear() throws IOException {
        File[] entries = directory.listFiles();

        if (entries == null) {
            throw new IOException("Could not list the vault directory.");
        }

        // Snapshot direct children before deleting. Never decode records or recurse into a directory.
        for (File entry : entries) {
            if (OWNED_FILE_NAME.matcher(entry.getName()).matches() && !entry.delete()) {
                throw new IOException("Could not delete a vault file.");
            }
        }
    }

    private File file(String name) {
        return new File(directory, name);
    }

    private static void delete(File file, FilePresence presence) throws IOException {
        if (presence.exists(file) && !file.delete()) {
            throw new IOException("Could not delete the vault record.");
        }
    }

    static final class PendingWrite implements AutoCloseable {
        private final File target;
        private final File temporary;
        private final FileMover mover;
        private final FilePresence presence;
        private boolean committed;
        private boolean closed;

        PendingWrite(File target, File temporary, FileMover mover, FilePresence presence) {
            this.target = target;
            this.temporary = temporary;
            this.mover = mover;
            this.presence = presence;
        }

        void commit() throws IOException {
            if (closed || committed) {
                throw new IOException("Vault write is no longer pending.");
            }

            // Android/Linux atomically replaces the old file with this same-directory rename.
            // Never delete the previous record before this succeeds.
            if (!mover.move(temporary, target)) {
                throw new IOException("Could not commit the vault record.");
            }

            committed = true;
        }

        @Override
        public void close() throws IOException {
            if (closed) {
                return;
            }

            closed = true;

            if (!committed) {
                delete(temporary, presence);
            }
        }
    }
}
