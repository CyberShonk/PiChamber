package com.pichamber.app;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.Display;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.util.function.Consumer;

/** Local shared UI only: no Capacitor injection, host client, network, or text input. */
final class CompanionPresentation extends Presentation {
    private final Bridge bridge;
    private final Consumer<JSObject> action;
    private final JSONObject positions;
    private WebView web;
    private JSObject latest;
    private boolean loaded;
    private String loadedDocument;

    CompanionPresentation(Context context, Display display, Bridge bridge, JSONObject positions, Consumer<JSObject> action) {
        super(context, display);
        this.bridge = bridge;
        this.positions = positions;
        this.action = action;
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (getWindow() != null) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
            getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        }
        web = new WebView(getContext());
        web.setFocusable(false);
        web.setFocusableInTouchMode(false);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setDomStorageEnabled(false);
        web.getSettings().setBlockNetworkLoads(true);
        web.getSettings().setSupportZoom(false);
        web.addJavascriptInterface(new Actions(), "CompanionActions");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                String path = uri.getPath();
                if ("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && path != null && path.startsWith("/assets/")
                    && (path.endsWith(".css") || path.endsWith(".woff2") || path.endsWith(".woff") || path.endsWith(".ttf"))) {
                    WebResourceResponse response = bridge.getLocalServer().shouldInterceptRequest(request);
                    if (response != null) return response;
                }
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageFinished(WebView view, String url) { loaded = true; publish(); }
        });
        setContentView(web);
    }

    void render(JSObject frame) {
        latest = frame;
        if (web == null) return;
        try {
            int background = Color.parseColor(frame.optString("background"));
            web.setBackgroundColor(background);
            if (getWindow() != null) getWindow().setBackgroundDrawable(new ColorDrawable(background));
        } catch (IllegalArgumentException ignored) { /* CSS remains the authoritative theme. */ }
        String document = frame.optString("document");
        if (!document.equals(loadedDocument)) {
            loadedDocument = document;
            loaded = false;
            web.loadDataWithBaseURL("https://localhost/", document, "text/html", "UTF-8", null);
        } else publish();
    }

    @Override protected void onStart() {
        super.onStart();
        if (getWindow() != null) getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
    }

    private void publish() {
        if (!loaded || latest == null || web == null) return;
        web.evaluateJavascript("window.companionRender(" + JSONObject.quote(latest.optString("html")) + "," + latest.optLong("scope") + "," + latest.optLong("workspaceScope") + "," + positions.toString() + ")", null);
    }

    private final class Actions {
        @JavascriptInterface public void post(String payload) {
            if (payload == null || payload.length() > 1024) return;
            try {
                JSObject event = new JSObject(payload);
                web.post(() -> { if (web != null && latest != null && event.optLong("scope", -1) == latest.optLong("scope", -2)) action.accept(event); });
            } catch (Exception ignored) { /* Reject malformed local actions. */ }
        }
        @JavascriptInterface public void scroll(String payload) {
            if (payload == null || payload.length() > 4096) return;
            try {
                JSONObject next = new JSONObject(payload);
                web.post(() -> {
                    if (web == null) return;
                    java.util.Iterator<String> keys = next.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        org.json.JSONArray value = next.optJSONArray(key);
                        if (key.matches("[a-z0-9-]{1,40}") && value != null && value.length() == 2) {
                            try { positions.put(key, new org.json.JSONArray().put(Math.max(0, Math.min(1000000, value.optInt(0)))).put(Math.max(0, Math.min(1000000, value.optInt(1))))); } catch (Exception ignored) { }
                        }
                    }
                });
            } catch (Exception ignored) { }
        }
    }
    @Override protected void onStop() {
        super.onStop();
        if (web != null) {
            web.removeJavascriptInterface("CompanionActions");
            web.stopLoading();
            web.destroy();
            web = null;
        }
        latest = null;
    }
}
