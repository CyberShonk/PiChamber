package com.pichamber.app;

import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Device conveniences only. Android exports remain owned by PiChamberFiles. */
@CapacitorPlugin(name = "NativeApp")
public class NativeAppPlugin extends Plugin {
    private static final String TEST_CHANNEL = "pichamber-device-test";
    private static final int TEST_ID = 7341;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable pendingTest;
    private AlertDialog pasteDialog;

    @PluginMethod
    public void haptic(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String kind = call.getString("kind", "selection");
            int feedback = HapticFeedbackConstants.CLOCK_TICK;
            if ("impact".equals(kind)) feedback = HapticFeedbackConstants.CONTEXT_CLICK;
            if (Build.VERSION.SDK_INT >= 30) {
                if ("success".equals(kind)) feedback = HapticFeedbackConstants.CONFIRM;
                if ("error".equals(kind)) feedback = HapticFeedbackConstants.REJECT;
            }
            // No ignore-setting flags: Android owns the user's feedback policy.
            getBridge().getWebView().performHapticFeedback(feedback);
            call.resolve();
        });
    }

    @PluginMethod
    public void confirmTerminalPaste(PluginCall call) {
        String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> {
            if (getActivity().isFinishing() || getActivity().isDestroyed() || pasteDialog != null) {
                call.reject("Close the current paste confirmation first");
                return;
            }
            String preview = text.length() > 600 ? text.substring(0, 600) + "…" : text;
            pasteDialog = new AlertDialog.Builder(getActivity())
                .setTitle("Paste into terminal?")
                .setMessage("Newlines may run commands.\n\n" + preview)
                .setNegativeButton("Cancel", (dialog, which) -> resolvePaste(call, false))
                .setPositiveButton("Paste", (dialog, which) -> resolvePaste(call, true))
                .setOnCancelListener(dialog -> resolvePaste(call, false))
                .create();
            pasteDialog.setOnDismissListener(dialog -> pasteDialog = null);
            pasteDialog.show();
        });
    }

    private void resolvePaste(PluginCall call, boolean confirmed) {
        JSObject result = new JSObject();
        result.put("confirmed", confirmed);
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                if (Build.VERSION.SDK_INT < 26) {
                    intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getContext().getPackageName()));
                }
                getActivity().startActivity(intent);
                call.resolve();
            } catch (RuntimeException unavailable) {
                call.reject("Android notification settings could not be opened");
            }
        });
    }

    @PluginMethod
    public void testNotification(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (manager == null || !NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
                call.reject("Enable notifications in Android Settings first");
                return;
            }
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(new NotificationChannel(TEST_CHANNEL,
                    "Device notification tests", NotificationManager.IMPORTANCE_DEFAULT));
                NotificationChannel channel = manager.getNotificationChannel(TEST_CHANNEL);
                if (channel == null || channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                    call.reject("Enable the device test notification channel in Android Settings");
                    return;
                }
            }
            if (pendingTest != null) handler.removeCallbacks(pendingTest);
            pendingTest = () -> {
                pendingTest = null;
                Intent launch = new Intent(getContext(), MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent tap = PendingIntent.getActivity(getContext(), TEST_ID, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                try {
                    NotificationManagerCompat.from(getContext()).notify(TEST_ID,
                        new NotificationCompat.Builder(getContext(), TEST_CHANNEL)
                            .setSmallIcon(R.drawable.ic_stat_notify).setContentTitle("PiChamber")
                            .setContentText("Device notifications are working.")
                            .setContentIntent(tap).setAutoCancel(true).build());
                } catch (SecurityException permissionChanged) {
                    // Permission may have been revoked during the five-second delay.
                }
            };
            handler.postDelayed(pendingTest, 5000);
            call.resolve();
        });
    }

    @Override
    protected void handleOnStop() {
        if (pasteDialog != null) pasteDialog.cancel();
    }

    @Override
    protected void handleOnDestroy() {
        if (pasteDialog != null) pasteDialog.cancel();
        if (pendingTest != null) handler.removeCallbacks(pendingTest);
        pendingTest = null;
    }
}
