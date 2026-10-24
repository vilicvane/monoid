package app.monoid.plugins.cloudkv;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Map;

/**
 * Stores values in a SharedPreferences file. Android Auto Backup includes it while the
 * app allows backup; if the app adds backup rules, they must include
 * {@code sharedpref/app.monoid.cloud-kv.xml}. Values are restored on a new device but
 * are not synchronized between running devices.
 */
@CapacitorPlugin(name = "CloudKV")
public final class CloudKVPlugin extends Plugin {
    static final String PREFERENCES_NAME = "app.monoid.cloud-kv";

    private CloudKVStore store;

    @Override
    public void load() {
        SharedPreferences preferences = getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        store = new CloudKVStore(new CloudKVStore.Backend() {
            @Override
            public Map<String, ?> getAll() {
                return preferences.getAll();
            }

            @Override
            public boolean putString(String key, String value) {
                return preferences.edit().putString(key, value).commit();
            }

            @Override
            public boolean remove(String key) {
                return preferences.edit().remove(key).commit();
            }
        });
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("backend", "android-backup");
        result.put("liveSync", false);
        call.resolve(result);
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String value = store.get(call.getString("key"));
            JSObject result = new JSObject();
            result.put("value", value == null ? JSObject.NULL : value);
            call.resolve(result);
        } catch (CloudKVException error) {
            call.reject(error.getMessage(), error.code);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            store.set(call.getString("key"), call.getString("value"));
            call.resolve();
        } catch (CloudKVException error) {
            call.reject(error.getMessage(), error.code);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            store.remove(call.getString("key"));
            call.resolve();
        } catch (CloudKVException error) {
            call.reject(error.getMessage(), error.code);
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray entries = new JSArray();
        for (CloudKVStore.Entry entry : store.list(call.getString("prefix", ""))) {
            JSObject item = new JSObject();
            item.put("key", entry.key);
            item.put("value", entry.value);
            entries.put(item);
        }
        JSObject result = new JSObject();
        result.put("entries", entries);
        call.resolve(result);
    }

    @PluginMethod
    public void synchronize(PluginCall call) {
        call.resolve();
    }
}
