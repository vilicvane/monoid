package app.monoid.plugins.cloudkv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;

public final class CloudKVStoreTest {
    private Map<String, Object> values;
    private CloudKVStore store;

    @Before
    public void setUp() {
        values = new HashMap<>();
        store = new CloudKVStore(new CloudKVStore.Backend() {
            @Override
            public Map<String, ?> getAll() {
                return new HashMap<>(values);
            }

            @Override
            public boolean putString(String key, String value) {
                values.put(key, value);
                return true;
            }

            @Override
            public boolean remove(String key) {
                values.remove(key);
                return true;
            }
        });
    }

    @Test
    public void setGetRemove() throws CloudKVException {
        assertNull(store.get("a"));
        store.set("a", "");
        assertEquals("", store.get("a"));
        store.remove("a");
        assertNull(store.get("a"));
        store.remove("missing");
    }

    @Test
    public void rejectsInvalidKeysAndValues() throws CloudKVException {
        assertCode("INVALID_ARGUMENT", () -> store.get(null));
        assertCode("INVALID_ARGUMENT", () -> store.get(""));
        assertCode("INVALID_ARGUMENT", () -> store.set("a", null));
        // 22 three-byte characters exceed 64 UTF-8 bytes in 22 UTF-16 code units.
        assertCode("INVALID_ARGUMENT", () -> store.set(repeat("钥", 22), "v"));
        store.set(repeat("k", 64), "v");
    }

    @Test
    public void rejectsKeyCountOverflowWithoutWriting() throws CloudKVException {
        for (int index = 0; index < CloudKVStore.MAX_KEYS; index++) {
            values.put("k" + index, "");
        }
        store.set("k0", "replaced");
        assertCode("QUOTA_EXCEEDED", () -> store.set("extra", ""));
        assertFalse(values.containsKey("extra"));
    }

    @Test
    public void rejectsSizeOverflowAndCountsReplacementOnce() throws CloudKVException {
        String half = repeat("x", CloudKVStore.MAX_TOTAL_BYTES / 2 - 1);
        store.set("a", half);
        store.set("b", half);
        store.set("a", half);
        assertCode("QUOTA_EXCEEDED", () -> store.set("c", "x"));
    }

    @Test
    public void listFiltersPrefixSortsAndSkipsNonStrings() throws CloudKVException {
        store.set("sk/b", "2");
        store.set("sk/a", "1");
        store.set("other", "3");
        values.put("sk/number", 4);

        List<CloudKVStore.Entry> entries = store.list("sk/");
        assertEquals(2, entries.size());
        assertEquals("sk/a", entries.get(0).key);
        assertEquals("1", entries.get(0).value);
        assertEquals("sk/b", entries.get(1).key);
        assertEquals(3, store.list("").size());
    }

    private interface Action {
        void run() throws CloudKVException;
    }

    private static void assertCode(String code, Action action) {
        try {
            action.run();
            fail("Expected " + code);
        } catch (CloudKVException error) {
            assertEquals(code, error.code);
        }
    }

    private static String repeat(String text, int count) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < count; index++) {
            builder.append(text);
        }
        return builder.toString();
    }
}
