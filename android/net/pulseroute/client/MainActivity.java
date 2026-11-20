package net.pulseroute.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.VpnService;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.provider.Settings;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URL;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int IMPORT = 1;
    private static final int VPN = 2;
    private final Handler handler = new Handler();
    private boolean activating;
    private JourneyScreen journey;
    private Runnable unregisterBack;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (journey != null) journey.status(activating);
            handler.postDelayed(this, 1200);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if(state!=null && state.containsKey("pending-protection"))
            pendingProtection=new HashSet<>(state.getStringArrayList("pending-protection"));
        journey = new JourneyScreen(this);
        setContentView(journey);
        if (Build.VERSION.SDK_INT >= 33) {
            android.window.OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
            android.window.OnBackInvokedCallback callback = this::handleBack;
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            unregisterBack = () -> dispatcher.unregisterOnBackInvokedCallback(callback);
        }
    }

    private void handleBack() {
        if (journey == null) super.onBackPressed();
        else journey.goBack(() -> super.onBackPressed());
    }

    @Override public void onBackPressed() {
        handleBack();
    }

    @Override protected void onDestroy() {
        if (unregisterBack != null) unregisterBack.run();
        if (journey != null) journey.release();
        super.onDestroy();
    }

    void manageProfiles(String action,String value) {
        boolean share = action.equals("share");
        if (activating || (!share && TunnelService.running())) {
            Toast.makeText(this, activating ? RouteLanguage.text("Дождитесь окончания операции") : RouteLanguage.text("Отключите VPN перед удалением профилей"),Toast.LENGTH_LONG).show();
            return;
        }
        try {
            JSONArray ids=new JSONArray(value);
            java.util.List<String> args=new java.util.ArrayList<>();
            args.add(share?"export":"delete");
            args.add(new File(getFilesDir(),"profiles").getPath());
            File file=share?SharedProfile.fresh(this):null;
            if(share)args.add(file.getPath());
            boolean clear=false;
            for(int i=0;i<ids.length();i++){
                String id=ids.getString(i); args.add(id);
                clear |= id.equals(selectedProfile(this));
            }
            JourneyScreen.tool(this,null,args.toArray(new String[0]));
            if(share){
                android.net.Uri uri=new android.net.Uri.Builder().scheme("content").authority("net.pulseroute.client.share").appendPath(file.getName()).build();
                Intent intent=new Intent(Intent.ACTION_SEND).setType("application/zip");
                intent.putExtra(Intent.EXTRA_STREAM,uri);
                intent.setClipData(android.content.ClipData.newRawUri("ZIP",uri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent,RouteLanguage.text("Поделиться профилями")));
            }else{
                if(clear)getSharedPreferences("route-selection",MODE_PRIVATE).edit().remove("profile").remove("server").apply();
                journey.status(false);
                Toast.makeText(this,RouteLanguage.text("Профили удалены"),Toast.LENGTH_SHORT).show();
            }
        }catch(Exception error){Toast.makeText(this,RouteLanguage.text("Не удалось выполнить действие с профилями"),Toast.LENGTH_LONG).show();}
    }

    void importJourneyProfile(String value, String command) {
        if (activating) {
            journey.result(false, RouteLanguage.text("Завершите текущее соединение или импорт."));
            return;
        }
        activating = true;
        new Thread(() -> {
            String message;
            boolean ok = false;
            boolean changed = false;
            try {
                String count = JourneyScreen.tool(this, value, command, new File(getFilesDir(), "profiles").getPath());
                changed = !count.equals("0");
                message = count.equals("0") ? RouteLanguage.text("Этот профиль уже добавлен.") : RouteLanguage.text("Добавлено профилей · ") + count;
                ok = true;
            } catch (Exception error) { message = error.getMessage(); }
            final String result = message == null ? RouteLanguage.text("Не удалось добавить профиль") : message;
            final boolean success = ok;
            final boolean reload = changed;
            runOnUiThread(() -> {
                activating = false;
                if (!isDestroyed()) {
                    if (reload && TunnelService.running()) startForegroundService(new Intent(this,TunnelService.class).setAction(TunnelService.RELOAD_ROUTE));
                    journey.result(success,result);
                }
            });
        }, "profile-import").start();
    }

    void disconnect() {
        if (!TunnelService.running()) return;
        if (!TunnelService.disconnect() && TunnelService.systemAlwaysOn()) {
            startActivity(new Intent(Settings.ACTION_VPN_SETTINGS));
            return;
        }
        if (journey != null) journey.status(activating);
    }

    void showProtection() {
        Set<String> selected = AppProtection.packages(this);
        Map<String,String> installed = new LinkedHashMap<>();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo entry : getPackageManager().queryIntentActivities(launcher, 0)) {
            String pkg = entry.activityInfo.packageName;
            if (!pkg.equals(getPackageName())) installed.put(pkg,entry.loadLabel(getPackageManager()).toString());
        }
        for (String pkg : selected) if (!installed.containsKey(pkg)) installed.put(pkg,pkg);
        List<String> packages = new ArrayList<>(installed.keySet());
        packages.sort((one,two)->{
            int checked=Boolean.compare(selected.contains(two),selected.contains(one));
            return checked!=0?checked:installed.get(one).compareToIgnoreCase(installed.get(two));
        });
        String[] labels=new String[packages.size()];
        boolean[] checked=new boolean[packages.size()];
        for(int i=0;i<packages.size();i++){
            labels[i]=installed.get(packages.get(i));checked[i]=selected.contains(packages.get(i));
        }
        android.widget.TextView intro=new android.widget.TextView(this);
        int pad=(int)(20*getResources().getDisplayMetrics().density);
        intro.setPadding(pad,pad,pad,pad/2);
        intro.setText(RouteLanguage.text("Только через VPN\n\nВыбранные приложения используют текущий сервер. При отключении «Маршрут» блокирует их трафик. Остальные приложения используют обычную сеть. С пустым списком VPN работает для всего телефона.\n\nДля защиты при остановке самого «Маршрута» включите системную блокировку Android. Она действует на весь телефон."));
        new AlertDialog.Builder(this).setCustomTitle(intro)
            .setMultiChoiceItems(labels,checked,(dialog,index,on)->{
                if(on)selected.add(packages.get(index));else selected.remove(packages.get(index));
            })
            .setPositiveButton(RouteLanguage.text("Сохранить"),(d,w)->{
                if(selected.equals(AppProtection.packages(this)))return;
                if(selected.isEmpty()) {applyProtection(selected);return;}
                discloseVpn(() -> {
                    Intent consent=VpnService.prepare(this);
                    if(consent!=null){pendingProtection=new HashSet<>(selected);startActivityForResult(consent,PROTECT);}
                    else applyProtection(selected);
                });
            })
            .setNeutralButton("VPN Android",(d,w)->startActivity(new Intent(Settings.ACTION_VPN_SETTINGS)))
            .setNegativeButton(RouteLanguage.text("Отмена"),null).show();
    }

    private static final int PROTECT=48;
    private Set<String> pendingProtection;
    private void applyProtection(Set<String> selected){
        if(!AppProtection.save(this,selected)){
            Toast.makeText(this,RouteLanguage.text("Не удалось сохранить список"),Toast.LENGTH_SHORT).show();return;
        }
        if(!selected.isEmpty() || TunnelService.hasInterface())
            startForegroundService(new Intent(this,TunnelService.class).setAction(TunnelService.APPLY_PROTECTION));
        journey.status(activating);
    }

    void importZip() {
        if (activating || TunnelService.running()) {
            Toast.makeText(this, RouteLanguage.text("Сначала отключите VPN"), Toast.LENGTH_SHORT).show();
            return;
        }
        startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip"), IMPORT);
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if(pendingProtection!=null)state.putStringArrayList("pending-protection",new ArrayList<>(pendingProtection));
    }

    @Override protected void onResume() {
        super.onResume();
        if(!TunnelService.hasInterface() && AppProtection.configured(this) && VpnService.prepare(this)==null)
            startForegroundService(new Intent(this,TunnelService.class).setAction(TunnelService.APPLY_PROTECTION));
        handler.post(refresh);
    }

    @Override protected void onPause() {
        handler.removeCallbacks(refresh);
        super.onPause();
    }

    static String selectedProfile(android.content.Context context) {
        return context.getSharedPreferences("route-selection", MODE_PRIVATE)
            .getString("profile", "");
    }

    String profilePriority() {
        return getSharedPreferences("route-selection", MODE_PRIVATE).getString("priority", "[]");
    }

    void saveProfilePriority(String raw, JSONArray catalog) {
        if (activating || raw == null || raw.length() > 2048) return;
        try {
            JSONArray candidates = new JSONArray(raw);
            if (candidates.length() > 32) return;
            java.util.Set<String> known = new java.util.HashSet<>();
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (int index = 0; index < catalog.length(); index++) {
                JSONObject item = catalog.optJSONObject(index);
                if (item != null) known.add(item.optString("id"));
            }
            JSONArray order = new JSONArray();
            for (int index = 0; index < candidates.length(); index++) {
                String id = candidates.optString(index);
                if (known.contains(id) && seen.add(id)) order.put(id);
            }
            getSharedPreferences("route-selection", MODE_PRIVATE).edit()
                .putString("priority", order.toString()).apply();
            journey.status(activating);
        } catch (org.json.JSONException ignored) {}
    }

    void connectPrioritized(String id, JSONArray catalog) {
        if (!TunnelService.running() && id != null && !id.isEmpty() && selectProfile(id, catalog)) {
            connect();
        }
    }

    static String selectedServer(android.content.Context context) {
        return context.getSharedPreferences("route-selection", MODE_PRIVATE).getString("server","");
    }
    void connectServer(String id,JSONArray catalog) {
        for(int i=0;i<catalog.length();i++){
            JSONObject p=catalog.optJSONObject(i);
            if(p==null || !id.equals(p.optString("id")))continue;
            String host=p.optString("endpoint");
            if(!host.isEmpty() && selectProfile(id,catalog,host) && !TunnelService.running())connect();
            return;
        }
    }
    boolean selectProfile(String id, JSONArray catalog) {return selectProfile(id,catalog,"");}
    private boolean selectProfile(String id, JSONArray catalog,String host) {
        if (activating || id == null) return false;
        boolean valid = id.isEmpty();
        for (int index = 0; !valid && index < catalog.length(); index++) {
            JSONObject profile = catalog.optJSONObject(index);
            valid = profile != null && id.equals(profile.optString("id"));
        }
        if (!valid) return false;
        if (host.equals(selectedServer(this)) && (!host.isEmpty() || id.equals(selectedProfile(this)))) return true;
        getSharedPreferences("route-selection", MODE_PRIVATE).edit().putString("profile", id).putString("server",host).apply();
        if (TunnelService.running()) {
            TunnelService.summary = RouteLanguage.text("Переключаем профиль");
            startForegroundService(new Intent(this, TunnelService.class)
                .setAction(TunnelService.RELOAD_ROUTE));
        }
        journey.status(activating);
        return true;
    }

    void connect() {
        if (activating || !new File(getFilesDir(), "profiles/profiles.json").isFile()) {
            Toast.makeText(this, RouteLanguage.text("Импортируйте профили"), Toast.LENGTH_SHORT).show();
            return;
        }
        boolean proxy=TunnelOptions.load(this).proxyOnly && !AppProtection.configured(this) && !TunnelService.systemAlwaysOn();
        if (proxy) {startForegroundService(new Intent(this, TunnelService.class));return;}
        discloseVpn(this::requestTunnel);
    }

    private void discloseVpn(Runnable accepted) {
        if(getPreferences(MODE_PRIVATE).getBoolean("vpnDisclosure1",false)){accepted.run();return;}
        new AlertDialog.Builder(this)
            .setTitle(RouteLanguage.text("Подключение VPN"))
            .setMessage(RouteLanguage.text("Маршрут использует Android VpnService для обработки трафика выбранных приложений. Сервер выбранного профиля получает адреса назначений и передаваемый через него трафик. Российские адреса могут открываться напрямую. Для выбора доступного маршрута клиент проверяет соединение с Telegram и ChatGPT."))
            .setNegativeButton(android.R.string.cancel,null)
            .setPositiveButton(RouteLanguage.text("Разрешить и продолжить"),(dialog,which)->{
                getPreferences(MODE_PRIVATE).edit().putBoolean("vpnDisclosure1",true).apply();
                accepted.run();
            }).show();
    }
    private void requestTunnel() {
        Intent consent = VpnService.prepare(this);
        if (consent == null) startForegroundService(new Intent(this, TunnelService.class));
        else startActivityForResult(consent, VPN);
    }

    void activate(String code) {
        if (!Provisioning.ENABLED) return;
        if(activating || TunnelService.running() || !code.matches("[0-9]{6}")){
            journey.result(false, RouteLanguage.text("Введите шесть цифр при отключённом VPN."));
            return;
        }
        activating = true;
        new Thread(() -> {
            String message;
            boolean success = false;
            HttpsURLConnection connection = null;
            try {
                connection = Provisioning.request(this, code);
                int result = connection.getResponseCode();
                switch (result) {
                    case 200:
                        if (!"application/zip".equals(connection.getContentType())) {
                            throw new IOException("Unexpected reply type");
                        }
                        try (InputStream in = connection.getInputStream()) { install(in,true); }
                        message = RouteLanguage.text("Профили получены");
                        success = true;
                        break;
                    case 401: message = RouteLanguage.text("Код доступа не принят"); break;
                    case 429: message = RouteLanguage.text("Слишком много попыток. Повторите позже"); break;
                    default: message = RouteLanguage.text("Сервер выдачи временно недоступен");
                }
            } catch (Exception error) {
                message = RouteLanguage.text("Не удалось получить профили");
            } finally {
                if (connection != null) connection.disconnect();
            }
            String feedback = message;
            boolean imported = success;
            runOnUiThread(() -> {
                activating = false;
                if (!isDestroyed()) journey.result(imported,feedback);
            });
        }, "profile-download").start();
    }

    String routeSummary() {
        File manifest = new File(getFilesDir(), "profiles/profiles.json");
        if (!manifest.isFile()) return RouteLanguage.text("Профили ещё не импортированы");
        String summary;
        try {
            int count = read(manifest).getJSONArray("profiles").length();
            summary = RouteLanguage.text("Профили: ") + count + RouteLanguage.text("\nДомены .ru, .su, .рф и сети RU идут напрямую для обычных приложений");
            if (AppProtection.configured(this)) {
                summary += RouteLanguage.text("\nВыбранные приложения используют только VPN любого сервера");
                if (!TunnelService.systemLockdown()) summary += RouteLanguage.text("\nБлокировка Android при остановке VPN выключена");
            }
        } catch (Exception error) { return RouteLanguage.text("Ошибка чтения профилей"); }
        if (!TunnelService.summary.startsWith("Подключено")) return summary;
        try {
            JSONArray active = read(new File(getFilesDir(), "health.json")).getJSONArray("Active");
            return summary + "\n\nTelegram: " + path(active, 1) + "\nChatGPT: " + path(active, 2);
        } catch (Exception error) { return summary; }
    }

    private static String path(JSONArray active, int index) {
        String value = active.optString(index, "");
        return value.isEmpty() ? RouteLanguage.text("нет доступного маршрута") : value;
    }

    private static JSONObject read(File file) throws Exception {
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
    }

    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(request,permissions,results);
        if(request==JourneyScreen.REQUEST_CAMERA && journey!=null)journey.cameraResult(results.length>0 && results[0]==android.content.pm.PackageManager.PERMISSION_GRANTED);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if(request==PROTECT){
            if(result==RESULT_OK && pendingProtection!=null)applyProtection(pendingProtection);
            pendingProtection=null;return;
        }
        if (request == JourneyScreen.PICK_QR) {
            journey.finishPicker(result == RESULT_OK && data != null ? data.getData() : null);
            return;
        }
        if (result != RESULT_OK) return;
        if (request == VPN) startForegroundService(new Intent(this, TunnelService.class));
        if (request == IMPORT && data != null && data.getData() != null) {
            try (InputStream in = getContentResolver().openInputStream(data.getData())) {
                install(in,false);
                Toast.makeText(this, RouteLanguage.text("Профили импортированы"), Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, RouteLanguage.text("Не удалось импортировать ZIP"), Toast.LENGTH_LONG).show();
            }
        }
    }

    private void install(InputStream in,boolean refresh) throws Exception {
        File stage = Files.createTempDirectory(getFilesDir().toPath(), "profiles-").toFile();
        boolean committed = false;
        try {
            Set<String> names = new HashSet<>();
            int total = 0;
            try (ZipInputStream zip = new ZipInputStream(in)) {
                for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                    String name = entry.getName();
                    if (!name.matches("[A-Za-z0-9_-]{1,40}\\.(json|conf|toml|pem)") || !names.add(name) || names.size() > 64) {
                        throw new IOException("Invalid archive member");
                    }
                    try (FileOutputStream out = new FileOutputStream(new File(stage, name))) {
                        byte[] buffer = new byte[4096];
                        for (int count; (count = zip.read(buffer)) != -1; ) {
                            if ((total += count) > 1_048_576) throw new IOException("Archive too large");
                            out.write(buffer, 0, count);
                        }
                    }
                }
            }
            JSONArray profiles = read(new File(stage, "profiles.json")).getJSONArray("profiles");
            if (profiles.length() < 1 || profiles.length() > 32) throw new IOException("Invalid manifest");
            for (int index = 0; index < profiles.length(); index++) {
                JSONObject entry = profiles.getJSONObject(index);
                String id = entry.getString("id");
                String kind = entry.getString("kind");
                String ext;
                switch (kind) {
                    case "trusttunnel": ext = ".toml"; break;
                    case "amneziawg": ext = ".conf"; break;
                    case "xray": case "vmess": case "vless": case "shadowsocks": case "socks": case "trojan": case "wireguard": case "hysteria": case "xhttp-tls": case "xhttp-reality": case "naive": case "mieru": ext = ".json"; break;
                    default: throw new IOException("Unsupported profile");
                }
                if (!id.matches("[A-Za-z0-9_-]{1,40}") || !names.contains(id + ext)) {
                    throw new IOException("Profile file missing");
                }
            }
            File target = new File(getFilesDir(), "profiles");
            if(refresh && target.isDirectory()) preserveExtraServers(target,stage,profiles);
            if (target.isDirectory()) JourneyScreen.tool(this, null, "preserve", target.getPath(), stage.getPath());
            File retired = new File(getFilesDir(), "profiles.previous");
            remove(retired);
            if (target.exists() && !target.renameTo(retired)) throw new IOException("Previous profile storage unavailable");
            if (!stage.renameTo(target)) {
                if (retired.exists()) retired.renameTo(target);
                throw new IOException("Profile storage unavailable");
            }
            committed = true;
            remove(retired);
        } finally {
            if (!committed) remove(stage);
        }
    }

    // A refresh for the same client updates the issued bundle. Keep separately imported servers.
    private static void preserveExtraServers(File old,File stage,JSONArray incoming) throws Exception {
        JSONArray existing=read(new File(old,"profiles.json")).getJSONArray("profiles");
        Set<String> ids=new HashSet<>(),nodes=new HashSet<>();
        Set<Integer> ports=new HashSet<>();
        String client=null;
        for(int i=0;i<incoming.length();i++){
            JSONObject p=incoming.getJSONObject(i);String id=p.getString("id");
            if(!id.matches("[0-9]+-[A-Za-z0-9_-]+-[0-9]{2}"))return;
            String number=id.substring(id.length()-2);
            if(client!=null && !client.equals(number))return;
            client=number;ids.add(id);nodes.add(id.split("-",2)[0]);ports.add(p.getInt("port"));
        }
        boolean same=false;
        for(int i=0;i<existing.length();i++)same|=ids.contains(existing.getJSONObject(i).getString("id"));
        if(!same)return;
        int original=incoming.length();
        for(int i=0;i<existing.length();i++){
            JSONObject p=existing.getJSONObject(i);String id=p.getString("id");
            if(!id.matches("[A-Za-z0-9_-]{1,40}") || !id.endsWith("-"+client) || nodes.contains(id.split("-",2)[0]))continue;
            if(incoming.length()>=32 || !ports.add(p.getInt("port")))throw new IOException("Local profiles conflict");
            String kind=p.getString("kind"), ext=kind.equals("trusttunnel")?".toml":kind.equals("amneziawg")?".conf":".json";
            Files.copy(new File(old,id+ext).toPath(),new File(stage,id+ext).toPath());
            File pem=new File(old,id+".pem");
            if(pem.isFile())Files.copy(pem.toPath(),new File(stage,pem.getName()).toPath());
            incoming.put(p);
        }
        if(incoming.length()!=original)Files.write(new File(stage,"profiles.json").toPath(),
            new JSONObject().put("profiles",incoming).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void remove(File dir) {
        File[] contents = dir.listFiles();
        if (contents != null) for (File file : contents) file.delete();
        dir.delete();
    }
}
