package com.obiectstudy.hms;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * JS bridge exposed to the PWA as {@code window.HmsBridge}.
 *
 * Threading contract: every {@link JavascriptInterface} method here runs on the WebView's JS
 * bridge thread, i.e. never the UI thread. Nothing in this class touches the network on that
 * thread: all I/O is handed to a single background executor. Every callback into the page is
 * posted back to the UI thread, because {@code evaluateJavascript} is UI-thread only.
 *
 * The contract with the (frozen) web side:
 *   version()          -> JSON string {"versionCode":5,"versionName":"1.4.0"}
 *   checkUpdate()      -> async, answers via window.__hmsUpdate({ok:true,...} | {ok:false,error})
 *   installUpdate(json)-> async, reports via window.__hmsUpdateProgress({state,percent,message})
 */
public final class HmsBridge {

    /** Name the page sees: {@code window.HmsBridge}. */
    static final String JS_NAME = "HmsBridge";

    /** Fixed manifest URL; the page and the app must agree on it. */
    private static final String MANIFEST_URL = "https://obiectstudy.github.io/hms/version.json";

    private static final String CALLBACK_UPDATE = "__hmsUpdate";
    private static final String CALLBACK_PROGRESS = "__hmsUpdateProgress";

    private static final String MIME_APK = "application/vnd.android.package-archive";
    private static final String UPDATE_DIR = "update";

    private static final int TIMEOUT_MS = 10_000;
    private static final int BUFFER = 16 * 1024;
    private static final int MAX_MANIFEST_BYTES = 512 * 1024;
    /** Report progress at most once per this many percent (contract asks for >= every 10%). */
    private static final int PROGRESS_STEP = 10;

    private final MainActivity host;
    private final ExecutorService io;
    /** Set once the activity is gone; every background step checks it and bails out. */
    private final AtomicBoolean closed = new AtomicBoolean(false);

    /** Live connection so {@link #shutdown()} can abort a blocked socket read. */
    private volatile HttpURLConnection connection;
    /** APK that already passed both checks and waits for the user to allow unknown sources. */
    private volatile File pendingInstall;
    /** Last manifest handed to the page; fallback for installUpdate() argument conversion. */
    private volatile JSONObject advertised;

    HmsBridge(MainActivity host) {
        this.host = host;
        this.io = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "hms-update");
            thread.setDaemon(true);
            return thread;
        });
    }

    // ---------------------------------------------------------------- JS API

    /** Local build identity, as a JSON string so the page can JSON.parse it directly. */
    @JavascriptInterface
    public String version() {
        JSONObject out = new JSONObject();
        try {
            out.put("versionCode", BuildConfig.VERSION_CODE);
            out.put("versionName", BuildConfig.VERSION_NAME);
        } catch (JSONException ignored) {
            // put() of an int/String cannot fail; keep the compiler happy.
        }
        return out.toString();
    }

    @JavascriptInterface
    public void checkUpdate() {
        if (isCancelled()) {
            return;
        }
        io.execute(() -> {
            try {
                JSONObject manifest = fetchManifest();
                int remoteCode = manifest.optInt("versionCode", 0);
                if (remoteCode <= BuildConfig.VERSION_CODE) {
                    updateFailed("已是最新版本 " + BuildConfig.VERSION_NAME);
                    return;
                }
                String apkUrl = manifest.optString("apkUrl", "").trim();
                String sha256 = manifest.optString("sha256", "").trim().toLowerCase(Locale.US);
                if (apkUrl.isEmpty() || sha256.isEmpty()) {
                    updateFailed("版本清单缺少 apkUrl 或 sha256");
                    return;
                }
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("versionCode", remoteCode);
                out.put("versionName", manifest.optString("versionName", ""));
                out.put("notes", manifest.optString("notes", ""));
                out.put("url", apkUrl);
                out.put("sha256", sha256);
                out.put("size", manifest.optLong("size", 0L));
                // Remembered so installUpdate() still works when the bridge hands us the JS
                // object as the string "[object Object]" (see parseInstallSpec).
                advertised = out;
                postCallback(CALLBACK_UPDATE, out.toString());
            } catch (IOException | JSONException | RuntimeException e) {
                // Network or malformed manifest: stay silent per contract.
                updateFailed(messageOf(e));
            }
        });
    }

    @JavascriptInterface
    public void installUpdate(String payload) {
        if (isCancelled()) {
            return;
        }
        final JSONObject spec = parseInstallSpec(payload);
        if (spec == null) {
            progress("error", 0, "更新信息无效");
            return;
        }
        io.execute(() -> runInstall(spec));
    }

    /**
     * Accepts both shapes the page may send: the JSON string that came back through
     * {@code __hmsUpdate}, or the live object from {@code window.HmsBridge.installUpdate(obj)}.
     * The latter reaches Java as the string "[object Object]" because the WebView bridge cannot
     * carry structured values across, so fall back to the manifest we last advertised.
     */
    private JSONObject parseInstallSpec(String payload) {
        JSONObject parsed = null;
        if (payload != null && !payload.trim().isEmpty()) {
            try {
                parsed = new JSONObject(payload);
            } catch (JSONException ignored) {
                parsed = null;
            }
        }
        if (isInstallable(parsed)) {
            return parsed;
        }
        JSONObject cached = advertised;
        return isInstallable(cached) ? cached : null;
    }

    private static boolean isInstallable(JSONObject spec) {
        return spec != null
                && !spec.optString("url", "").trim().isEmpty()
                && !spec.optString("sha256", "").trim().isEmpty();
    }

    // ------------------------------------------------------------ install flow

    private void runInstall(JSONObject spec) {
        String url = spec.optString("url", "").trim();
        String sha256 = spec.optString("sha256", "").trim().toLowerCase(Locale.US);
        String versionName = spec.optString("versionName", "").trim();
        long size = spec.optLong("size", 0L);

        if (url.isEmpty() || sha256.isEmpty()) {
            progress("error", 0, "更新信息不完整");
            return;
        }

        File dir = new File(host.getCacheDir(), UPDATE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            progress("error", 0, "无法创建下载目录");
            return;
        }
        clearDir(dir);

        File part = new File(dir, "HMS-" + sanitize(versionName) + ".apk.part");
        File apk = new File(dir, "HMS-" + sanitize(versionName) + ".apk");

        try {
            progress("downloading", 0, "开始下载");
            String actualSha = download(url, part, size);
            if (isCancelled()) {
                return;
            }

            progress("verifying", 100, "正在校验安装包");
            if (!actualSha.equals(sha256)) {
                deleteQuietly(part);
                progress("error", 0, "安装包校验失败（SHA-256 不匹配）");
                return;
            }
            if (size > 0 && part.length() != size) {
                deleteQuietly(part);
                progress("error", 0, "安装包大小不符");
                return;
            }
            // Second gate: the downloaded APK must carry this app's own signing certificate.
            // A hijacked host that swaps the APK fails here even with a matching manifest.
            if (!signedBySameCertificate(part)) {
                deleteQuietly(part);
                progress("error", 0, "安装包签名与本应用不一致，已丢弃");
                return;
            }

            File ready = apk;
            if (apk.isFile()) {
                deleteQuietly(apk);
            }
            if (!part.renameTo(apk)) {
                ready = part;
            }

            if (needsUnknownSources()) {
                pendingInstall = ready;
                progress("opening", 100, "请在系统设置里允许安装未知应用");
                openUnknownSourcesSetting();
                return;
            }
            progress("opening", 100, "正在打开安装程序");
            launchInstaller(ready);
        } catch (IOException | RuntimeException e) {
            deleteQuietly(part);
            if (!isCancelled()) {
                progress("error", 0, "下载失败：" + messageOf(e));
            }
        }
    }

    /** Streams to {@code target} and returns the lower-case hex SHA-256 of the bytes written. */
    private String download(String url, File target, long expectedSize) throws IOException {
        MessageDigest digest = sha256Digest();
        long total = expectedSize;
        long done = 0L;
        int lastPercent = -PROGRESS_STEP;
        HttpURLConnection conn = null;
        OutputStream out = null;
        try {
            conn = openConnection(url);
            connection = conn;
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + code);
            }
            long declared = conn.getContentLengthLong();
            if (declared > 0) {
                total = declared;
            }
            InputStream in = new BufferedInputStream(conn.getInputStream(), BUFFER);
            out = new FileOutputStream(target);
            byte[] chunk = new byte[BUFFER];
            int read;
            while ((read = in.read(chunk)) != -1) {
                if (isCancelled()) {
                    throw new IOException("已取消");
                }
                out.write(chunk, 0, read);
                digest.update(chunk, 0, read);
                done += read;
                if (total > 0) {
                    int percent = (int) Math.min(100L, done * 100L / total);
                    if (percent >= lastPercent + PROGRESS_STEP) {
                        lastPercent = percent;
                        progress("downloading", percent, "已下载 " + percent + "%");
                    }
                }
            }
            out.flush();
            if (lastPercent < 100) {
                progress("downloading", 100, "下载完成");
            }
            return hex(digest.digest());
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // Best effort; the digest/size checks decide what happens next.
                }
            }
            if (conn != null) {
                conn.disconnect();
            }
            connection = null;
        }
    }

    /**
     * Compares the archive's signer certificates against the installed app's own, byte for byte.
     * Both sides are read with GET_SIGNING_CERTIFICATES (API 28+) / GET_SIGNATURES (API 24-27).
     */
    private boolean signedBySameCertificate(File archive) {
        try {
            PackageManager pm = host.getPackageManager();
            int flags = signaturesFlag();
            PackageInfo downloaded = pm.getPackageArchiveInfo(archive.getAbsolutePath(), flags);
            if (downloaded == null) {
                return false;
            }
            PackageInfo installed = pm.getPackageInfo(host.getPackageName(), flags);
            byte[][] theirs = signerCerts(downloaded);
            byte[][] ours = signerCerts(installed);
            if (theirs == null || ours == null || theirs.length == 0
                    || theirs.length != ours.length) {
                return false;
            }
            // Signer order is not significant; sort by digest so the pairwise compare is stable.
            Arrays.sort(theirs, BY_DIGEST);
            Arrays.sort(ours, BY_DIGEST);
            for (int i = 0; i < ours.length; i++) {
                if (!Arrays.equals(ours[i], theirs[i])) {
                    return false;
                }
            }
            return true;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return false;
        }
    }

    private static final Comparator<byte[]> BY_DIGEST = (a, b) -> hex(sha256Of(a)).compareTo(hex(sha256Of(b)));

    @SuppressWarnings("deprecation")
    private static byte[][] signerCerts(PackageInfo info) {
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            try {
                SigningInfo signingInfo = info.signingInfo;
                signatures = signingInfo.getApkContentsSigners();
            } catch (RuntimeException ignored) {
                signatures = null;
            }
        }
        if (signatures == null || signatures.length == 0) {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) {
            return null;
        }
        byte[][] certs = new byte[signatures.length][];
        for (int i = 0; i < signatures.length; i++) {
            if (signatures[i] == null) {
                return null;
            }
            certs[i] = signatures[i].toByteArray();
        }
        return certs;
    }

    private static int signaturesFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
    }

    // --------------------------------------------------------------- launching

    private boolean needsUnknownSources() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !host.getPackageManager().canRequestPackageInstalls();
    }

    private void openUnknownSourcesSetting() {
        host.runOnUiThread(() -> {
            if (!alive()) {
                return;
            }
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + host.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                host.startActivity(intent);
            } catch (ActivityNotFoundException e) {
                // Some OEM builds ship a reduced Settings app; fall back to the app info page.
                try {
                    host.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + host.getPackageName()))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException ignored) {
                    progress("error", 0, "无法打开系统设置");
                }
            }
        });
    }

    private void launchInstaller(File apk) {
        host.runOnUiThread(() -> {
            if (!alive()) {
                return;
            }
            try {
                Uri uri = FileProvider.getUriForFile(host, host.getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, MIME_APK);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                host.startActivity(intent);
            } catch (RuntimeException e) {
                progress("error", 0, "无法打开系统安装程序");
            }
        });
    }

    /** Called from {@link MainActivity#onResume()}: retry a launch that was waiting on the grant. */
    void onResume() {
        File apk = pendingInstall;
        if (apk == null || !apk.isFile()) {
            return;
        }
        if (needsUnknownSources()) {
            return;
        }
        pendingInstall = null;
        launchInstaller(apk);
    }

    /** Cancels in-flight work and aborts a blocked socket read. Called from Activity#onDestroy. */
    void shutdown() {
        closed.set(true);
        pendingInstall = null;
        io.shutdownNow();
        HttpURLConnection live = connection;
        if (live != null) {
            try {
                live.disconnect();
            } catch (RuntimeException ignored) {
                // Nothing useful to do while tearing the activity down.
            }
        }
        connection = null;
    }

    // ---------------------------------------------------------------- helpers

    private JSONObject fetchManifest() throws IOException, JSONException {
        HttpURLConnection conn = null;
        try {
            conn = openConnection(MANIFEST_URL);
            connection = conn;
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + code);
            }
            return new JSONObject(readAll(conn.getInputStream()));
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
            connection = null;
        }
    }

    private static HttpURLConnection openConnection(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept", "application/json, application/octet-stream");
        conn.setRequestProperty("Cache-Control", "no-cache");
        return conn;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        int total = 0;
        while ((read = in.read(chunk)) != -1) {
            total += read;
            if (total > MAX_MANIFEST_BYTES) {
                throw new IOException("版本清单过大");
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toString("UTF-8");
    }

    private void updateFailed(String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("error", message);
        } catch (JSONException ignored) {
            // Not reachable for these value types.
        }
        postCallback(CALLBACK_UPDATE, out.toString());
    }

    private void progress(String state, int percent, String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("state", state);
            out.put("percent", Math.max(0, Math.min(100, percent)));
            out.put("message", message == null ? "" : message);
        } catch (JSONException ignored) {
            // Not reachable for these value types.
        }
        postCallback(CALLBACK_PROGRESS, out.toString());
    }

    /** Marshals one callback onto the UI thread; the JSON is quoted, never hand-concatenated. */
    private void postCallback(String function, String json) {
        final String script = "window." + function + " && window." + function
                + "(" + JSONObject.quote(json) + ");";
        host.runOnUiThread(() -> {
            WebView view = host.getWebView();
            if (view == null || host.isFinishing() || host.isDestroyed()) {
                return;
            }
            try {
                view.evaluateJavascript(script, null);
            } catch (RuntimeException ignored) {
                // WebView already torn down; dropping the callback is the safe outcome.
            }
        });
    }

    private boolean alive() {
        return !closed.get() && !host.isFinishing() && !host.isDestroyed();
    }

    private boolean isCancelled() {
        return closed.get() || Thread.currentThread().isInterrupted();
    }

    private static void clearDir(File dir) {
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            deleteQuietly(child);
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.isFile()) {
            file.delete();
        }
    }

    private static String sanitize(String versionName) {
        String value = versionName == null ? "" : versionName.trim();
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length() && out.length() < 32; i++) {
            char c = value.charAt(i);
            boolean safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
            out.append(safe ? c : '_');
        }
        return out.length() == 0 ? "latest" : out.toString();
    }

    private static String messageOf(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static byte[] sha256Of(byte[] data) {
        return sha256Digest().digest(data);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xF, 16));
            out.append(Character.forDigit(b & 0xF, 16));
        }
        return out.toString();
    }
}
