package com.pichamber.app;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/** Touch-only companion. Never hosts an EditText, keyboard, terminal or chat. */
final class CompanionPresentation extends Presentation {
    interface ActionListener { void onAction(JSObject action); }
    private final ActionListener actions;
    private LinearLayout root;
    private String lastRendered = "";
    private ScrollView fileScroll;
    private long workspaceScope = -1;
    private int foreground;
    private int muted;
    private int border;
    private int selection;
    private int selectionForeground;

    CompanionPresentation(Context context, Display display, ActionListener listener) {
        super(context, display, android.R.style.Theme_DeviceDefault_NoActionBar);
        actions = listener;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        if (window != null) {
            // Accept touches without moving input/IME focus from the main Activity.
            window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
            // Both flags keep this window below the IME, including cross-display IMEs.
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        }
        root = new LinearLayout(getContext());
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(16);
        root.setPadding(padding, padding, padding, padding);
        root.setFitsSystemWindows(true);
        setContentView(root);
    }

    private int dp(int value) { return Math.round(value * getContext().getResources().getDisplayMetrics().density); }
    private int color(JSONObject colors, String name) {
        String value = colors.optString(name);
        // Shared themes use #RRGGBBAA; Android uses #AARRGGBB.
        if (value.matches("#[0-9a-fA-F]{8}")) value = "#" + value.substring(7, 9) + value.substring(1, 7);
        try { return Color.parseColor(value); }
        catch (IllegalArgumentException invalid) { return name.equals("background") ? Color.BLACK : Color.WHITE; }
    }

    private TextView text(String value, int size, int ink) {
        TextView view = new TextView(getContext());
        view.setText(value.length() > 500 ? value.substring(0, 500) + "…" : value);
        view.setTextSize(size);
        view.setTextColor(ink);
        view.setMaxLines(2);
        view.setEllipsize(TextUtils.TruncateAt.END);
        view.setPadding(0, 0, 0, dp(8));
        return view;
    }

    private GradientDrawable fill(int ink) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(ink);
        drawable.setCornerRadius(dp(8));
        drawable.setStroke(dp(1), border);
        return drawable;
    }

    private Button button(String label, long scope, String type, int index) {
        Button button = new Button(getContext());
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTextColor(new android.content.res.ColorStateList(
            new int[][] { new int[] { android.R.attr.state_pressed }, new int[] {} },
            new int[] { selectionForeground, foreground }));
        button.setMinHeight(dp(48));
        button.setMaxLines(2);
        button.setEllipsize(TextUtils.TruncateAt.END);
        StateListDrawable backgrounds = new StateListDrawable();
        backgrounds.addState(new int[] { android.R.attr.state_pressed }, fill(selection));
        backgrounds.addState(new int[] {}, fill(Color.TRANSPARENT));
        button.setBackground(backgrounds);
        button.setPadding(dp(12), dp(8), dp(12), dp(8));
        button.setOnClickListener(view -> {
            JSObject action = new JSObject();
            action.put("scope", scope);
            action.put("type", type);
            if (index >= 0) action.put("index", index);
            actions.onAction(action);
        });
        return button;
    }

    void render(JSObject snapshot) {
        String serialized = snapshot.toString();
        if (serialized.equals(lastRendered)) return;
        lastRendered = serialized;
        JSONObject colors = snapshot.optJSONObject("colors");
        if (colors == null || root == null) return;
        foreground = color(colors, "foreground");
        muted = color(colors, "muted");
        border = color(colors, "border");
        selection = color(colors, "selection");
        selectionForeground = color(colors, "selectionForeground");
        int previousScroll = fileScroll != null && workspaceScope == snapshot.optLong("workspaceScope") ? fileScroll.getScrollY() : 0;
        workspaceScope = snapshot.optLong("workspaceScope");
        root.removeAllViews();
        root.setBackgroundColor(color(colors, "background"));
        long scope = snapshot.optLong("scope");
        TextView heading = text(snapshot.optString("workspace"), 20, foreground);
        heading.setTypeface(null, Typeface.BOLD);
        root.addView(heading);
        String branch = snapshot.optString("branch");
        if (!branch.isEmpty()) root.addView(text(branch, 14, muted));
        root.addView(text(snapshot.optString("summary"), 14, muted));
        LinearLayout shortcuts = new LinearLayout(getContext());
        String[] names = { "Changes", "Files", "App settings" };
        String[] types = { "changes", "files", "settings" };
        for (int i = 0; i < names.length; i++) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(56), 1);
            if (i > 0) params.setMarginStart(dp(8));
            shortcuts.addView(button(names[i], scope, types[i], -1), params);
        }
        root.addView(shortcuts);
        View divider = new View(getContext());
        divider.setBackgroundColor(border);
        LinearLayout.LayoutParams line = new LinearLayout.LayoutParams(-1, dp(1));
        line.setMargins(0, dp(12), 0, dp(12));
        root.addView(divider, line);
        ScrollView scroll = new ScrollView(getContext());
        fileScroll = scroll;
        LinearLayout files = new LinearLayout(getContext());
        files.setOrientation(LinearLayout.VERTICAL);
        JSONArray items = snapshot.optJSONArray("files");
        if (items != null) for (int i = 0; i < Math.min(50, items.length()); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            Button row = button(item.optString("label"), scope, "file", i);
            row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
            params.bottomMargin = dp(8);
            files.addView(row, params);
        }
        scroll.addView(files);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        scroll.post(() -> { if (fileScroll == scroll) scroll.scrollTo(0, previousScroll); });
        root.addView(text("Tap a file to open its diff on the main screen.", 12, muted));
    }
}
