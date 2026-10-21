package com.obiectstudy.hms;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.util.Locale;

/**
 * Single-activity shell that hosts the HMS PWA.
 *
 * The site is served from the packaged assets over a synthetic https origin instead of file://,
 * because ES modules are blocked by the module CORS rule on file:// (the page would stay blank).
 */
public class MainActivity extends Activity {

    /** Virtual origin handed out by {@link WebViewAssetLoader}. */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/assets/www/index.html";
    private static final int REQ_FILE_CHOOSER = 1001;

    private WebView webView;
    private HmsBridge bridge;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraOutputUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        // Matches the app background so the first frame does not flash white.
        webView.setBackgroundColor(Color.rgb(0xF6, 0xF8, 0xF7));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Nothing is loaded from the filesystem: every asset goes through the asset loader.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                fixMimeType(request.getUrl(), response);
                return response;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                return startFileChooser(callback, params);
            }
        });

        // window.HmsBridge: checkUpdate()/installUpdate(json)/version(). The object must be
        // registered before the first page load, otherwise the page sees an undefined global.
        bridge = new HmsBridge(this);
        webView.addJavascriptInterface(bridge, HmsBridge.JS_NAME);

        setContentView(webView);
        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /**
     * The platform mime table does not know every extension the site uses and falls back to
     * text/plain, which the strict "module script" mime check rejects. Override the few that matter.
     */
    private static void fixMimeType(Uri url, WebResourceResponse response) {
        if (response == null || url == null) {
            return;
        }
        String path = url.getPath();
        if (path == null) {
            return;
        }
        String ext = MimeTypeMap.getFileExtensionFromUrl(path).toLowerCase(Locale.US);
        String mime;
        switch (ext) {
            case "js":
            case "mjs":
                mime = "text/javascript";
                break;
            case "css":
                mime = "text/css";
                break;
            case "html":
                mime = "text/html";
                break;
            case "json":
                mime = "application/json";
                break;
            case "webmanifest":
                mime = "application/manifest+json";
                break;
            case "svg":
                mime = "image/svg+xml";
                break;
            default:
                return;
        }
        response.setMimeType(mime);
    }

    /** Camera + gallery chooser; both branches feed the same {@link #filePathCallback}. */
    private boolean startFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
        }
        filePathCallback = callback;

        File dir = new File(getCacheDir(), "camera");
        if (!dir.exists() && !dir.mkdirs()) {
            filePathCallback = null;
            callback.onReceiveValue(null);
            return false;
        }
        File photo = new File(dir, "capture-" + System.currentTimeMillis() + ".jpg");
        cameraOutputUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photo);

        Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        capture.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
        capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);

        String accept = "image/*";
        if (params != null) {
            String[] types = params.getAcceptTypes();
            if (types != null && types.length > 0 && types[0] != null && !types[0].isEmpty()) {
                accept = types[0];
            }
        }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType(accept);

        Intent chooser = Intent.createChooser(pick, getString(R.string.chooser_title));
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{capture});
        try {
            startActivityForResult(chooser, REQ_FILE_CHOOSER);
        } catch (ActivityNotFoundException e) {
            filePathCallback = null;
            cameraOutputUri = null;
            callback.onReceiveValue(null);
            return false;
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            Uri picked = data == null ? null : data.getData();
            if (picked != null) {
                result = new Uri[]{picked};
            } else if (cameraOutputUri != null) {
                // Camera app wrote to our FileProvider URI and returned no data.
                result = new Uri[]{cameraOutputUri};
            }
        }
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(result);
        }
        filePathCallback = null;
        cameraOutputUri = null;
    }

    /** {@link HmsBridge} needs the live view to deliver callbacks; null once onDestroy ran. */
    WebView getWebView() {
        return webView;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) {
            // Returning from the "install unknown apps" settings page: retry the pending install.
            bridge.onResume();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            // Cancels the manifest fetch / download and aborts a blocked socket read.
            bridge.shutdown();
            bridge = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
