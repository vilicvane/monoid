package com.capacitorjs.plugins.keyboard;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Keyboard")
public class KeyboardPlugin extends Plugin {

    private Keyboard implementation;
    private boolean stopped;
    private boolean destroyed;

    @Override
    public void load() {
        bridge.executeOnMainThread(
            () -> {
                if (destroyed) return;
                boolean resizeOnFullScreen = getConfig().getBoolean("resizeOnFullScreen", false);
                implementation = new Keyboard(getActivity(), resizeOnFullScreen);

                implementation.setKeyboardEventListener(this::onKeyboardEvent);
            }
        );
    }

    @PluginMethod
    public void show(final PluginCall call) {
        bridge.executeOnMainThread(
            () -> {
                if (implementation == null || stopped || destroyed) {
                    call.resolve();
                } else {
                    implementation.show(call::resolve);
                }
            }
        );
    }

    @PluginMethod
    public void hide(final PluginCall call) {
        bridge.executeOnMainThread(
            () -> {
                if (implementation != null && !implementation.hide()) {
                    call.reject("Can't close keyboard, not currently focused");
                } else {
                    call.resolve();
                }
            }
        );
    }

    @PluginMethod
    public void setAccessoryBarVisible(PluginCall call) {
        call.unimplemented();
    }

    @PluginMethod
    public void setStyle(PluginCall call) {
        call.unimplemented();
    }

    @PluginMethod
    public void setResizeMode(PluginCall call) {
        call.unimplemented();
    }

    @PluginMethod
    public void getResizeMode(PluginCall call) {
        call.unimplemented();
    }

    @PluginMethod
    public void setScroll(PluginCall call) {
        call.unimplemented();
    }

    void onKeyboardEvent(String event, int size) {
        JSObject kbData = new JSObject();
        switch (event) {
            case Keyboard.EVENT_KB_HEIGHT_CHANGED:
                kbData.put("keyboardHeight", size);
                notifyListeners(event, kbData, true);
                break;
            case Keyboard.EVENT_KB_WILL_SHOW:
            case Keyboard.EVENT_KB_DID_SHOW:
                String data = "{ 'keyboardHeight': " + size + " }";
                bridge.triggerWindowJSEvent(event, data);
                kbData.put("keyboardHeight", size);
                notifyListeners(event, kbData);
                break;
            case Keyboard.EVENT_KB_WILL_HIDE:
            case Keyboard.EVENT_KB_DID_HIDE:
                bridge.triggerWindowJSEvent(event);
                notifyListeners(event, kbData);
                break;
        }
    }

    @Override
    protected void handleOnStart() {
        stopped = false;
    }

    @Override
    protected void handleOnStop() {
        stopped = true;
        if (implementation != null) implementation.cancelShow();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        if (implementation != null) implementation.destroy();
    }
}
