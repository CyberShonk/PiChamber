package com.pichamber.app;

import android.app.AlertDialog;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/** One non-focusable Presentation, no WebView, host client or stored credentials. */
@CapacitorPlugin(name = "AndroidCompanion")
public class AndroidCompanionPlugin extends Plugin implements DisplayManager.DisplayListener {
    private DisplayManager displays;
    private CompanionPresentation presentation;
    private JSObject snapshot;
    private boolean enabled;
    private boolean resumed;
    private boolean keyboardVisible;
    private boolean listening;
    private boolean failed;
    private int selectedDisplayId = -1;
    private AlertDialog displayPicker;

    @Override
    public void load() {
        displays = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
    }

    private int primaryId() {
        Display display = Build.VERSION.SDK_INT >= 30 ? getActivity().getDisplay()
            : getActivity().getWindowManager().getDefaultDisplay();
        return display == null ? Display.DEFAULT_DISPLAY : display.getDisplayId();
    }

    private List<Display> eligibleDisplays() {
        List<Display> result = new ArrayList<>();
        if (displays == null) return result;
        int primary = primaryId();
        for (Display display : displays.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)) {
            if (display.isValid() && display.getDisplayId() != primary && display.getState() != Display.STATE_OFF) result.add(display);
        }
        return result;
    }

    private Display selectedDisplay() {
        List<Display> eligible = eligibleDisplays();
        for (Display display : eligible) if (display.getDisplayId() == selectedDisplayId) return display;
        if (eligible.isEmpty()) return null;
        Display display = eligible.get(0);
        selectedDisplayId = display.getDisplayId();
        return display;
    }

    private JSObject state() {
        List<Display> eligible = eligibleDisplays();
        JSObject result = new JSObject();
        String status = !enabled ? "off" : !resumed ? "paused" : keyboardVisible ? "keyboard"
            : eligible.isEmpty() ? "unavailable" : failed ? "error" : presentation == null ? "paused" : "active";
        result.put("status", status);
        result.put("displayCount", eligible.size());
        if (enabled) {
            Display selected = selectedDisplay();
            if (selected != null) result.put("displayName", selected.getName());
        }
        return result;
    }

    private void closePresentation() {
        CompanionPresentation old = presentation;
        presentation = null;
        if (old != null) old.dismiss();
    }

    private void reconcile() {
        Display selected = enabled ? selectedDisplay() : null;
        if (!enabled || !resumed || keyboardVisible || selected == null || getActivity().isFinishing() || getActivity().isDestroyed()) {
            closePresentation();
        } else {
            if (presentation != null && presentation.getDisplay().getDisplayId() != selected.getDisplayId()) closePresentation();
            if (presentation == null) {
                CompanionPresentation next = new CompanionPresentation(getActivity(), selected, (action) -> {
                    // Enforce ownership here too, before sending an action to JavaScript.
                    if (!enabled || !resumed || keyboardVisible || snapshot == null
                        || action.optLong("scope", -1) != snapshot.optLong("scope", -2)) return;
                    notifyListeners("action", action);
                });
                next.setOnDismissListener(dialog -> {
                    if (presentation == next) {
                        presentation = null;
                        notifyListeners("state", state());
                    }
                });
                try {
                    next.show();
                    presentation = next;
                    failed = false;
                } catch (WindowManager.InvalidDisplayException | WindowManager.BadTokenException | SecurityException unavailable) {
                    failed = true;
                    next.dismiss();
                }
            }
            if (presentation != null && snapshot != null) presentation.render(snapshot);
        }
        notifyListeners("state", state());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(state()));
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            enabled = call.getBoolean("enabled", false);
            keyboardVisible = call.getBoolean("keyboardVisible", keyboardVisible);
            failed = false;
            if (enabled && !listening && displays != null) {
                displays.registerDisplayListener(this, new Handler(Looper.getMainLooper()));
                listening = true;
            }
            if (!enabled) {
                if (listening) displays.unregisterDisplayListener(this);
                listening = false;
                snapshot = null;
                keyboardVisible = false;
                if (displayPicker != null) displayPicker.cancel();
            }
            reconcile();
            call.resolve(state());
        });
    }

    @PluginMethod
    public void setKeyboardVisible(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean next = call.getBoolean("visible", false);
            if (next != keyboardVisible) { keyboardVisible = next; reconcile(); }
            call.resolve();
        });
    }

    @PluginMethod
    public void publish(PluginCall call) {
        JSObject next = call.getObject("snapshot");
        if (next == null || next.toString().length() > 100000 || next.optLong("scope", -1) < 0 || next.optLong("workspaceScope", -1) < 0
            || next.optJSONObject("colors") == null || next.optJSONArray("files") == null
            || next.optJSONArray("files").length() > 50) {
            call.reject("Invalid companion snapshot");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (!enabled) { call.reject("Companion is disabled"); return; }
            // Older queued snapshots cannot replace a newer workspace owner.
            if (snapshot != null && next.optLong("scope") < snapshot.optLong("scope")) { call.resolve(); return; }
            snapshot = next;
            if (presentation != null) presentation.render(next);
            call.resolve();
        });
    }

    @PluginMethod
    public void chooseDisplay(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            List<Display> eligible = eligibleDisplays();
            if (getActivity().isFinishing() || getActivity().isDestroyed()) { call.reject("Activity is unavailable"); return; }
            if (displayPicker != null) { call.reject("Close the display chooser first"); return; }
            if (eligible.size() <= 1) { failed = false; reconcile(); call.resolve(state()); return; }
            String[] labels = new String[eligible.size()];
            for (int i = 0; i < eligible.size(); i++) labels[i] = eligible.get(i).getName();
            displayPicker = new AlertDialog.Builder(getActivity()).setTitle("Companion display")
                .setItems(labels, (dialog, index) -> {
                    selectedDisplayId = eligible.get(index).getDisplayId();
                    failed = false;
                    reconcile();
                    call.resolve(state());
                }).setNegativeButton("Cancel", (dialog, which) -> call.resolve(state()))
                .setOnCancelListener(dialog -> call.resolve(state())).create();
            displayPicker.setOnDismissListener(dialog -> displayPicker = null);
            displayPicker.show();
        });
    }

    @Override public void onDisplayAdded(int id) { failed = false; reconcile(); }
    @Override public void onDisplayRemoved(int id) { failed = false; reconcile(); }
    @Override public void onDisplayChanged(int id) { failed = false; reconcile(); }
    @Override protected void handleOnResume() { resumed = true; reconcile(); }
    @Override protected void handleOnPause() {
        resumed = false;
        if (displayPicker != null) displayPicker.cancel();
        reconcile();
    }
    @Override protected void handleOnDestroy() {
        enabled = false;
        snapshot = null;
        if (displayPicker != null) displayPicker.cancel();
        closePresentation();
        if (listening && displays != null) displays.unregisterDisplayListener(this);
        listening = false;
    }
}
