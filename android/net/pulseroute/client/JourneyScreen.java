package net.pulseroute.client;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.graphics.Color;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

final class JourneyScreen extends FrameLayout {
    static final int PICK_QR = 46;
    private final MainActivity activity;
    private final WebView browser;
    private boolean diagnostics,checking;
    private final String version;
    private ValueCallback<Uri[]> picked;
    private android.webkit.PermissionRequest camera;
    static final int REQUEST_CAMERA = 47;
    void cameraResult(boolean allowed) {
        if (camera != null) {
            if (allowed) camera.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else camera.deny();
            camera=null;
        }
    }
    private boolean loaded;
    private String last = "";
    private boolean busy;
    private long catalogModified = -1;
    private JSONArray catalog = new JSONArray();

    JourneyScreen(MainActivity app) {
        super(app);
        activity = app;
        String installed="";
        try { installed=app.getPackageManager().getPackageInfo(app.getPackageName(),0).versionName; } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
        version=installed;
        setBackgroundColor(Color.rgb(16,51,50));
        browser = new WebView(app);
        browser.setBackgroundColor(Color.rgb(16,51,50));
        WebSettings web = browser.getSettings();
        web.setJavaScriptEnabled(true);
        web.setAllowFileAccess(false);
        web.setBlockNetworkLoads(true);
        web.setAllowFileAccessFromFileURLs(false);
        web.setAllowUniversalAccessFromFileURLs(false);
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(android.webkit.PermissionRequest request) {
                if (!"file".equals(request.getOrigin().getScheme()) ||
                    !java.util.Arrays.asList(request.getResources()).contains(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    request.deny();return;
                }
                cameraResult(false);camera=request;
                if(activity.checkSelfPermission(android.Manifest.permission.CAMERA)==android.content.pm.PackageManager.PERMISSION_GRANTED) cameraResult(true);
                else activity.requestPermissions(new String[]{android.Manifest.permission.CAMERA},REQUEST_CAMERA);
            }
            @Override public void onPermissionRequestCanceled(android.webkit.PermissionRequest request) {
                if(camera==request)camera=null;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picked != null) picked.onReceiveValue(null);
                picked = callback;
                try {
                    activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), PICK_QR);
                } catch (android.content.ActivityNotFoundException error) { finishPicker(null); }
                return true;
            }
        });
        browser.addJavascriptInterface(new Commands(),"RouteHost");
        addView(browser,new LayoutParams(-1,-1));
        setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                int types = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                    | WindowInsets.Type.ime();
                android.graphics.Insets safe = insets.getInsets(types);
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        browser.loadUrl("file:///android_asset/journey/"+RouteLanguage.page());
    }
    private void qrResult(String revision,String png,String message){
        activity.runOnUiThread(()->{if(!activity.isDestroyed())browser.evaluateJavascript("window.routeQR("+JSONObject.quote(revision)+","+JSONObject.quote(png)+","+JSONObject.quote(message==null?RouteLanguage.text("Не удалось создать QR-код"):RouteLanguage.text(message))+")",null);});
    }
    final class Commands {
        @JavascriptInterface public void post(String name, String value) {
            activity.runOnUiThread(() -> {
                if (activity.isDestroyed()) return;
                switch (name) {
                    case "ready": loaded=true;last="";update();break;
                    case "connect": if(!busy) activity.connect();break;
                    case "select": activity.selectProfile(value, catalog);break;
                    case "priority": activity.saveProfilePriority(value, catalog);break;
                    case "connect-server": activity.connectServer(value,catalog);break;
                    case "connect-priority": activity.connectPrioritized(value, catalog);break;
                    case "disconnect": activity.disconnect();break;
                    case "share": case "delete": activity.manageProfiles(name,value);break;
                    case "encrypted-subscription":
                        if(value.length()>65536 || !value.matches("(?i)happ://crypt[0-9]*/[^\\s]+"))break;
                        new android.app.AlertDialog.Builder(activity).setTitle(RouteLanguage.text("Зашифрованная подписка Happ"))
                            .setMessage(RouteLanguage.text("Эту подписку расшифровывает приложение Happ. Открыть её в Happ?"))
                            .setNegativeButton(RouteLanguage.text("Отмена"),null).setPositiveButton(RouteLanguage.text("Открыть"),(d,w)->{
                                try{activity.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(value)).setPackage("com.happproxy"));}
                                catch(android.content.ActivityNotFoundException e){result(false,RouteLanguage.text("Happ не установлен"));}
                            }).show();break;
                    case "paste-link": case "paste-json":
                        android.content.ClipboardManager clipboard=activity.getSystemService(android.content.ClipboardManager.class);
                        android.content.ClipData clip=clipboard.getPrimaryClip();
                        CharSequence text=clip!=null && clip.getItemCount()>0?clip.getItemAt(0).getText():null;
                        if(text==null || text.length()>1048576){result(false,RouteLanguage.text("В буфере нет текста профиля до 1 МБ."));break;}
                        browser.evaluateJavascript("window.routePaste("+JSONObject.quote(text.toString())+","+name.equals("paste-json")+")",null);
                        break;
                    case "profile-qr": case "share-qr-image":
                        new Thread(()->{
                            String revision="";
                            try{
                                boolean sharing=name.equals("share-qr-image");
                                org.json.JSONArray request=sharing?null:new org.json.JSONArray(value);
                                String id=sharing?value:request.getString(1);
                                revision=sharing?"":request.getString(0);
                                String png=tool(activity,null,"qr",new File(activity.getFilesDir(),"profiles").getPath(),id);
                                if(sharing){
                                    File file=SharedProfile.fresh(activity,".png");
                                    java.nio.file.Files.write(file.toPath(),android.util.Base64.decode(png,android.util.Base64.DEFAULT));
                                    Uri uri=new Uri.Builder().scheme("content").authority("net.pulseroute.client.share").appendPath(file.getName()).build();
                                    Intent intent=new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM,uri);
                                    intent.setClipData(android.content.ClipData.newRawUri("QR",uri));
                                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                    activity.runOnUiThread(()->{if(!activity.isDestroyed())activity.startActivity(Intent.createChooser(intent,RouteLanguage.text("Поделиться QR-кодом")));});
                                }else qrResult(revision,png,"");
                            }catch(Exception e){if(name.equals("profile-qr"))qrResult(revision,"",e.getMessage());else activity.runOnUiThread(()->android.widget.Toast.makeText(activity,RouteLanguage.text("Не удалось отправить QR-код"),0).show());}
                        },"profile-qr").start();break;
                    case "copy-json":
                        new Thread(()->{
                            try {
                                String data=tool(activity,null,"copy-json",new File(activity.getFilesDir(),"profiles").getPath(),value);
                                activity.runOnUiThread(()->{
                                    if(activity.isDestroyed())return;
                                    android.content.ClipData entry=android.content.ClipData.newPlainText("JSON",data);
                                    android.os.PersistableBundle flags=new android.os.PersistableBundle();
                                    flags.putBoolean("android.content.extra.IS_SENSITIVE",true);entry.getDescription().setExtras(flags);
                                    activity.getSystemService(android.content.ClipboardManager.class).setPrimaryClip(entry);
                                    result(true,RouteLanguage.text("JSON скопирован"));
                                });
                            }catch(Exception e){activity.runOnUiThread(()->result(false,RouteLanguage.text("Не удалось скопировать JSON профиля.")));}
                        },"profile-copy").start();break;
                    case "zip": if(!busy) activity.importZip();break;
                    case "activate": activity.activate(value);break;
                    case "protection": activity.showProtection();break;
                    case "system-vpn":
                        android.content.Intent settings = new android.content.Intent(android.provider.Settings.ACTION_VPN_SETTINGS);
                        try { activity.startActivity(settings); }
                        catch (android.content.ActivityNotFoundException unavailable) {
                            android.widget.Toast.makeText(activity,RouteLanguage.text("Системные настройки VPN недоступны"),android.widget.Toast.LENGTH_SHORT).show();
                        }
                        break;
                    case "tunnel-options": TunnelOptions.save(activity,value);update();break;
                    case "motion": activity.getPreferences(0).edit().putBoolean("still","true".equals(value)).apply();update();break;
                    case "diagnostics": diagnostics="true".equals(value);update();break;
                    case "update":
                        if(!checking){checking=true;update();ReleaseUpdate.start(activity,()->{checking=false;update();});}
                        break;
                    case "import": case "subscribe": activity.importJourneyProfile(value,name.equals("subscribe")?"subscribe":"add");break;
                    default: break;
                }
            });
        }
    }
    void goBack(Runnable fallback) {
        if (!loaded) {
            fallback.run();
            return;
        }
        browser.evaluateJavascript("window.routeBack?.() || false", handled -> {
            if (!"true".equals(handled) && !activity.isDestroyed()) fallback.run();
        });
    }
    void finishPicker(Uri uri) {
        if(picked!=null){picked.onReceiveValue(uri==null?null:new Uri[]{uri});picked=null;}
    }
    void release() {
        cameraResult(false); finishPicker(null); browser.removeJavascriptInterface("RouteHost");
        removeView(browser);browser.destroy();
    }
    void status(boolean changing) { busy=changing; update(); }
    void result(boolean ok,String message) {
        if(!loaded || activity.isDestroyed())return;
        browser.evaluateJavascript("window.routeImportResult("+ok+","+JSONObject.quote(RouteLanguage.text(message))+")",null);
        update();
    }
    private JSONObject read(File file) throws Exception {
        return new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
    }
    private void update() {
        if(!loaded || activity.isDestroyed())return;
        try {
            JSONObject state=new JSONObject();int count=0;
            String active="", route="";
            JSONArray profiles=new JSONArray();
            File manifest=new File(activity.getFilesDir(),"profiles/profiles.json");
            if(manifest.isFile()){profiles=read(manifest).getJSONArray("profiles");count=profiles.length();}
            long modified = manifest.lastModified();
            if (modified != catalogModified) {
                catalog = modified == 0 ? new JSONArray() : readCatalog(manifest);
                catalogModified = modified;
            }
            boolean running=TunnelService.running();
            boolean healthKnown = false;
            if(running && TunnelService.summary.startsWith("Подключено")) {
                try {active=read(new File(activity.getFilesDir(),"health.json")).getJSONArray("Active").optString(0,""); healthKnown = true;} catch(Exception ignored){}
            }
            if(!active.isEmpty()){
                route=active;
                for(int i=0;i<profiles.length();i++){JSONObject p=profiles.getJSONObject(i);if(active.equals(p.optString("id"))){route=p.optString("name",active);break;}}
            }
            String phase=!running?"home":active.isEmpty()?"travel":"connected";
            String label=TunnelService.summary;
            if(phase.equals("connected"))label=TunnelService.inProxyMode()?RouteLanguage.text("Локальный прокси"):RouteLanguage.text("Подключено");
            else if(running && label.startsWith("Подключено"))label="Поиск маршрута";
            state.put("phase",phase);state.put("status",RouteLanguage.text(label));state.put("count",count);state.put("route",route);
            String selected = MainActivity.selectedProfile(activity);
            if (running && healthKnown && active.isEmpty() && !selected.isEmpty()) {
                state.put("status",MainActivity.selectedServer(activity).isEmpty() ? RouteLanguage.text("Профиль недоступен") : RouteLanguage.text("Ищем рабочий протокол"));
            }
            state.put("sharedAddress",TunnelService.sharedAddress());
            state.put("canExclude",Build.VERSION.SDK_INT>=33);
            state.put("tunnelOptions",TunnelOptions.load(activity).json());
            state.put("platform","android");state.put("version",version);state.put("checking",checking);
            if(diagnostics)state.put("diagnostics",activity.routeSummary());
            state.put("catalog", catalog);
            state.put("server",MainActivity.selectedServer(activity));
            state.put("selected", selected);
            state.put("priority", new JSONArray(activity.profilePriority()));
            state.put("active", active);
            
            state.put("busy",busy);state.put("still",activity.getPreferences(0).getBoolean("still",false));
            String payload=state.toString();
            if(!last.equals(payload)){last=payload;browser.evaluateJavascript("window.routeState("+payload+")",null);}
        } catch(Exception ignored){}
    }
    private JSONArray readCatalog(File manifest) {
        try {
            Process child = new ProcessBuilder(activity.getApplicationInfo().nativeLibraryDir
                + "/librouter.so", "-list-profiles", "-config", manifest.getPath())
                .redirectErrorStream(true).start();
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            try (InputStream in = child.getInputStream()) {
                byte[] bytes = new byte[4096];
                for (int n; (n = in.read(bytes)) != -1;) result.write(bytes, 0, n);
            }
            if (child.waitFor() == 0) return new JSONArray(result.toString("UTF-8"));
        } catch (Exception ignored) {}
        return new JSONArray();
    }

    static String tool(MainActivity app,String input,String... args) throws Exception {
        java.util.List<String> command=new java.util.ArrayList<>();
        command.add(app.getApplicationInfo().nativeLibraryDir+"/libprofiletool.so");
        java.util.Collections.addAll(command,args);
        Process child=new ProcessBuilder(command).redirectErrorStream(true).start();
        try(OutputStream out=child.getOutputStream()){if(input!=null)out.write(input.getBytes(StandardCharsets.UTF_8));}
        ByteArrayOutputStream result=new ByteArrayOutputStream();
        try(InputStream in=child.getInputStream()){byte[] buffer=new byte[512];for(int n;(n=in.read(buffer))!=-1;)result.write(buffer,0,n);}
        String message=result.toString("UTF-8").trim();
        if(child.waitFor()!=0)throw new IOException(message.isEmpty()?RouteLanguage.text("Не удалось импортировать профиль"):message);
        return message;
    }
}
