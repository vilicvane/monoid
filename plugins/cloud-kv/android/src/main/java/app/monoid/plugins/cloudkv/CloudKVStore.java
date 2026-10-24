package app.monoid.plugins.cloudkv;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Applies the same key, count and size limits as iCloud key-value storage. */
final class CloudKVStore {
    static final int MAX_KEYS = 1024;
    static final int MAX_KEY_BYTES = 64;
    static final int MAX_TOTAL_BYTES = 1_000_000;

    interface Backend {
        Map<String, ?> getAll();

        boolean putString(String key, String value);

        boolean remove(String key);
    }

    static final class Entry {
        final String key;
        final String value;

        Entry(String key, String value) {
            this.key = key;
            this.value = value;
        }
    }

    private final Backend backend;

    CloudKVStore(Backend backend) {
        this.backend = backend;
    }

    synchronized String get(String key) throws CloudKVException {
        validateKey(key);
        Object value = backend.getAll().get(key);
        return value instanceof String ? (String) value : null;
    }

    synchronized void set(String key, String value) throws CloudKVException {
        validateKey(key);
        if (value == null) {
            throw CloudKVException.invalidArgument("value must be a string.");
        }

        int count = 1;
        long bytes = utf8Length(key) + utf8Length(value);
        for (Map.Entry<String, ?> entry : backend.getAll().entrySet()) {
            if (entry.getKey().equals(key) || !(entry.getValue() instanceof String)) {
                continue;
            }
            count++;
            bytes += utf8Length(entry.getKey()) + utf8Length((String) entry.getValue());
        }
        if (count > MAX_KEYS) {
            throw CloudKVException.quotaExceeded("At most " + MAX_KEYS + " keys can be stored.");
        }
        if (bytes > MAX_TOTAL_BYTES) {
            throw CloudKVException.quotaExceeded(
                "Stored keys and values must total at most " + MAX_TOTAL_BYTES + " UTF-8 bytes.");
        }

        if (!backend.putString(key, value)) {
            throw CloudKVException.io("Could not write the value.");
        }
    }

    synchronized void remove(String key) throws CloudKVException {
        validateKey(key);
        if (!backend.remove(key)) {
            throw CloudKVException.io("Could not remove the value.");
        }
    }

    synchronized List<Entry> list(String prefix) {
        String effectivePrefix = prefix == null ? "" : prefix;
        List<Entry> entries = new ArrayList<>();
        for (Map.Entry<String, ?> entry : backend.getAll().entrySet()) {
            if (entry.getKey().startsWith(effectivePrefix) && entry.getValue() instanceof String) {
                entries.add(new Entry(entry.getKey(), (String) entry.getValue()));
            }
        }
        // String.compareTo orders by UTF-16 code unit, matching JavaScript.
        entries.sort((a, b) -> a.key.compareTo(b.key));
        return entries;
    }

    static void validateKey(String key) throws CloudKVException {
        if (key == null || key.isEmpty()) {
            throw CloudKVException.invalidArgument("Key must be a nonempty string.");
        }
        if (utf8Length(key) > MAX_KEY_BYTES) {
            throw CloudKVException.invalidArgument("Key must be at most " + MAX_KEY_BYTES + " UTF-8 bytes.");
        }
    }

    private static int utf8Length(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }
}
