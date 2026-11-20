import AppKit
import Foundation
import SwiftUI
import Network
import WebKit
import UniformTypeIdentifiers

enum ActivationError: LocalizedError {
    case code, missing, limited, network, archive
    var errorDescription: String? {
        switch self {
        case .code: routeText("Введите шесть цифр")
        case .missing: routeText("Код доступа не принят")
        case .limited: routeText("Слишком много попыток. Повторите позже")
        case .network: routeText("Сервер выдачи временно недоступен")
        case .archive: routeText("Сервер вернул неверный архив")
        }
    }
}
final class Redirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
enum ReleaseUpdate {
    struct Version: Decodable {
        let version: String
        let build: Int

        var isValid: Bool {
            build > 0 && version.range(of: #"^[0-9]+(?:\.[0-9]+){1,2}$"#, options:.regularExpression) != nil
        }
    }

    private struct Manifest: Decodable { let macos: Version }
    static let version = Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? ""
    static let installedBuild = Int(Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "") ?? 0
    static let download = URL(string:"https://route.centv.ru/route-macos.zip")!

    static func check(currentBuild: Int = installedBuild) async throws -> Version? {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration:config, delegate:Redirects(), delegateQueue:nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url:URL(string:"https://route.centv.ru/version.json")!)
        request.setValue("application/json", forHTTPHeaderField:"Accept")
        let (bytes, response) = try await session.bytes(for:request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.expectedContentLength <= 4096 else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 4096 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        let release = try JSONDecoder().decode(Manifest.self, from:data).macos
        guard release.isValid else { throw URLError(.cannotParseResponse) }
        return release.build > currentBuild ? release : nil
    }
}

enum LocalProfiles {
    static let home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("RouteClient", isDirectory: true)
    static var directory: URL { home.appendingPathComponent("profiles", isDirectory: true) }

    static func privateDirectory(_ path: URL) throws {
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
    }

    @MainActor static func deviceInfo() -> [String:String] {
        let preferences = UserDefaults.standard
        let id = preferences.string(forKey:"installationID") ?? UUID().uuidString.lowercased()
        preferences.set(id, forKey:"installationID")
        let version = Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "unknown"
        return ["id":id,"version":version,"model":"Mac Apple Silicon"]
    }

    static func activate(_ code: String, into target: URL) async throws -> Int {
        guard code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { throw ActivationError.code }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config, delegate: Redirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: URL(string: "https://route.centv.ru/v1/profiles")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let device = await deviceInfo()
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code":code,"platform":"macos","device":device])
        let (contents,response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ActivationError.network }
        if http.statusCode == 401 { throw ActivationError.missing }
        if http.statusCode == 429 { throw ActivationError.limited }
        guard http.statusCode == 200 else { throw ActivationError.network }
        guard http.mimeType == "application/zip", contents.count < 1_048_576 else { throw ActivationError.archive }
        return try install(contents, into: target)
    }

    static func install(_ contents: Data, into target: URL) throws -> Int {
        guard contents.count <= 1_048_576 else { throw ActivationError.archive }
        let parent = target.deletingLastPathComponent()
        try privateDirectory(parent)
        let temp = parent.appendingPathComponent(".activation-" + UUID().uuidString, isDirectory: true)
        try privateDirectory(temp)
        let files = FileManager.default
        defer { try? files.removeItem(at: temp) }
        let zip = temp.appendingPathComponent("download.zip")
        try contents.write(to: zip)
        try files.setAttributes([.posixPermissions: 0o600],ofItemAtPath:zip.path)
        let output = temp.appendingPathComponent("profiles", isDirectory: true)
        try privateDirectory(output)
        let names = try unzip(["-Z1", zip.path]).split(separator: "\n").map(String.init)
        guard !names.isEmpty, names.count <= 64, Set(names).count == names.count, names.contains("profiles.json"),
            names.allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\\.(json|toml|conf|pem)$", options: .regularExpression) != nil })
        else { throw ActivationError.archive }
        var remaining = 1_048_576
        for name in names {
            let url = output.appendingPathComponent(name)
            let data = try readZip(["-p",zip.path,name],limit:remaining)
            remaining -= data.count
            try data.write(to:url,options:.withoutOverwriting)
            try files.setAttributes([.posixPermissions: 0o600],ofItemAtPath:url.path)
        }
        guard (1...32).contains(try profileCount(output)) else {throw ActivationError.archive}
        if files.fileExists(atPath: target.path) {
            _ = try profileTool(["preserve",target.path,output.path])
        }
        let count = try profileCount(output)
        guard (1...32).contains(count) else { throw ActivationError.archive }
        if files.fileExists(atPath: target.path) {
            _ = try files.replaceItemAt(target, withItemAt: output)
        } else {
            try files.moveItem(at: output, to: target)
        }
        return count
    }

    static func catalog() -> [[String:Any]] {
        guard let binary = Bundle.main.resourceURL?.appendingPathComponent("route-client") else { return [] }
        let child = Process()
        let output = Pipe()
        child.executableURL = binary
        child.arguments = ["-list-profiles","-config",directory.appendingPathComponent("profiles.json").path]
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        do { try child.run() } catch { return [] }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        child.waitUntilExit()
        guard child.terminationStatus == 0 else { return [] }
        return (try? JSONSerialization.jsonObject(with:data)) as? [[String:Any]] ?? []
    }

    static func profileCount(_ path: URL) throws -> Int {
        let body = try Data(contentsOf: path.appendingPathComponent("profiles.json"))
        guard let json = try JSONSerialization.jsonObject(with: body) as? [String:Any],
              let profiles = json["profiles"] as? [[String:Any]] else { throw ActivationError.archive }
        let extensions = ["xray":"json","vmess":"json","vless":"json","shadowsocks":"json","socks":"json","trojan":"json","wireguard":"json","hysteria":"json","xhttp-tls":"json","xhttp-reality":"json","naive":"json","mieru":"json",
                          "amneziawg":"conf","trusttunnel":"toml"]
        var ids = Set<String>(), ports = Set<Int>()
        for row in profiles {
            guard let id=row["id"] as? String, let kind=row["kind"] as? String, let ext=extensions[kind],
                  let port=row["port"] as? Int, (1024...65535).contains(port),
                  id.range(of:"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$",options:.regularExpression) != nil,
                  ids.insert(id).inserted, ports.insert(port).inserted,
                  FileManager.default.fileExists(atPath:path.appendingPathComponent(id+"."+ext).path)
            else {throw ActivationError.archive}
        }
        return profiles.count
    }

    static func profileTool(_ args: [String], value: String = "") throws -> String {
        guard let base = Bundle.main.resourceURL else { throw ActivationError.archive }
        let child = Process(), input = Pipe(), output = Pipe()
        child.executableURL = base.appendingPathComponent("profiletool")
        child.arguments = args
        child.standardInput = input
        child.standardOutput = output
        child.standardError = output
        try child.run()
        try input.fileHandleForWriting.write(contentsOf: Data(value.utf8))
        try input.fileHandleForWriting.close()
        let result = String(decoding:output.fileHandleForReading.readDataToEndOfFile(), as:UTF8.self)
            .trimmingCharacters(in:.whitespacesAndNewlines)
        child.waitUntilExit()
        guard child.terminationStatus == 0 else {
            throw NSError(domain:"RouteProfiles",code:1,userInfo:[NSLocalizedDescriptionKey:routeText(result)])
        }
        return result
    }

    static func unzip(_ options:[String]) throws -> String {
        String(decoding:try readZip(options,limit:8192),as:UTF8.self)
    }

    static func readZip(_ options:[String],limit:Int) throws -> Data {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath:"/usr/bin/unzip")
        process.arguments = options
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        var data = Data()
        while let chunk = try pipe.fileHandleForReading.read(upToCount:min(65536,limit-data.count+1)), !chunk.isEmpty {
            if data.count + chunk.count > limit {
                try? pipe.fileHandleForReading.close()
                if process.isRunning {process.terminate()}
                process.waitUntilExit()
                throw ActivationError.archive
            }
            data.append(chunk)
        }
        process.waitUntilExit()
        if process.terminationStatus != 0 { throw ActivationError.archive }
        return data
    }
}

@MainActor final class Model: ObservableObject {
    @Published private(set) var tunnelOptions = UserDefaults.standard.dictionary(forKey:"routeAdvanced") ?? [:]
    private(set) var activeSocks = 17680
    func saveTunnel(_ raw:String) {
        guard let values=(try? JSONSerialization.jsonObject(with:Data(raw.utf8))) as? [String:Any] else { return }
        let allowed:[String:Set<String>]=["engineDNS":["profile","cloudflare","google","quad9"],"sniff":["profile","on","off"],"mux":["profile","off","4","8","16"],"ip":["profile","UseIPv4","UseIPv6"],"fragment":["profile","tlshello"],"method":["GET","HEAD"]]
        let numbers:[String:Set<Int>]=["http":[0,10809,8080],"socks":[1080,10808,17680],"timeout":[5,6,10,15],"interval":[15,30,60]]
        var result:[String:Any]=[:]
        for (key,choices) in allowed { guard let v=values[key] as? String,choices.contains(v) else{return};result[key]=v }
        for (key,choices) in numbers { guard let v=values[key] as? Int,choices.contains(v) else{return};result[key]=v }
        UserDefaults.standard.set(result,forKey:"routeAdvanced")
        tunnelOptions=result
    }
    @Published var checkingUpdate = false
    @Published var busy = false
    @Published var count = (try? LocalProfiles.profileCount(LocalProfiles.directory)) ?? 0
    @Published var message = "Отключено"
    @Published var running = false
    private var process: Process?
    private var switching = false
    @Published private(set) var catalog: [[String:Any]] = []
    @Published private(set) var selected = UserDefaults.standard.string(forKey:"selectedProfile") ?? ""
    @Published private(set) var server = UserDefaults.standard.string(forKey:"selectedServer") ?? ""
    @Published private(set) var priority = UserDefaults.standard.stringArray(forKey:"profilePriority") ?? []
    @Published private(set) var active = ""
    @Published private(set) var healthKnown = false
    @Published var activeRoute = ""
    private var healthFile = LocalProfiles.home.appendingPathComponent(".journey-" + UUID().uuidString + ".json")
    init() {
        busy = true
        Task {
            catalog = await Task.detached { LocalProfiles.catalog() }.value
            reconcileSelection()
            busy = false
        }
    }

    private func reconcileSelection() {
        guard !catalog.isEmpty || count == 0 else { return }
        let ids = Set(catalog.compactMap { $0["id"] as? String })
        let kept = priority.filter(ids.contains)
        if kept != priority {
            priority = kept
            UserDefaults.standard.set(kept, forKey:"profilePriority")
        }
        let matching = catalog.filter { $0["endpoint"] as? String == server }
        if !server.isEmpty && !matching.contains(where: { $0["id"] as? String == selected }) {
            selected = matching.first?["id"] as? String ?? ""
            if selected.isEmpty { server = "" }
        } else if server.isEmpty && !ids.contains(selected) {
            selected = ""
        } else { return }
        UserDefaults.standard.set(selected, forKey:"selectedProfile")
        UserDefaults.standard.set(server, forKey:"selectedServer")
    }
    func refreshHealth() {
        guard running && !switching,
              let data = try? Data(contentsOf:healthFile),
              let json = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let ids = json["Active"] as? [String], let id = ids.first else { return }
        if !healthKnown { healthKnown = true }
        if active != id { active = id }
        let name = catalog.first(where:{ $0["id"] as? String == id })?["name"] as? String ?? id
        if activeRoute != name { activeRoute = name }
    }

    func saveProfilePriority(_ raw: String) {
        guard !busy, raw.utf8.count <= 2048, let data = raw.data(using:.utf8),
              let order = (try? JSONSerialization.jsonObject(with:data)) as? [String],
              order.count <= 32 else { return }
        let known = Set(catalog.compactMap { $0["id"] as? String })
        var seen = Set<String>()
        let filtered = order.filter { known.contains($0) && seen.insert($0).inserted }
        guard filtered != priority else { return }
        UserDefaults.standard.set(filtered, forKey:"profilePriority")
        priority = filtered
    }

    func connectPrioritized(_ id: String) {
        guard !running, !busy, !id.isEmpty,
              catalog.contains(where:{ $0["id"] as? String == id }) else { return }
        selectProfile(id)
        toggle()
    }

    func connectServer(_ id:String){
        guard !busy, let host=catalog.first(where:{$0["id"] as? String==id})?["endpoint"] as? String,!host.isEmpty else{return}
        selectProfile(id,server:host)
        if !running {toggle()}
    }
    func selectProfile(_ id: String, server host:String = "") {
        guard !busy, host != server || (host.isEmpty && id != selected), id.isEmpty || catalog.contains(where:{ $0["id"] as? String == id }) else { return }
        UserDefaults.standard.set(id, forKey:"selectedProfile")
        UserDefaults.standard.set(host,forKey:"selectedServer")
        server=host
        selected = id
        guard let child = process else { return }
        switching = true
        activeRoute = ""
        active = ""
        healthKnown = false
        if child.isRunning { child.terminate() }
    }

    func importLink(_ value:String, command:String="add") async -> (Bool,String) {
        guard !running && !busy else { return (false,routeText("Сначала отключите соединение или дождитесь окончания импорта.")) }
        busy = true
        defer { busy = false }
        do {
            try LocalProfiles.privateDirectory(LocalProfiles.home)
            let dir = LocalProfiles.directory
            let n = try await Task.detached { try LocalProfiles.profileTool([command,dir.path],value:value) }.value
            count = try LocalProfiles.profileCount(dir)
            catalog = LocalProfiles.catalog()
            reconcileSelection()
            return (true,n == "0" ? routeText("Этот профиль уже добавлен.") : routeText("Добавлено профилей · ") + n)
        } catch { return (false,error.localizedDescription) }
    }
    func manageProfiles(_ action:String, raw:String, view:NSView) {
        guard !busy, let data=raw.data(using:.utf8),
              let ids=try? JSONDecoder().decode([String].self,from:data), !ids.isEmpty else {return}
        let dir=LocalProfiles.directory
        do {
            if action=="share" {
                let folder=FileManager.default.temporaryDirectory.appendingPathComponent("RouteSharedProfiles",isDirectory:true)
                try LocalProfiles.privateDirectory(folder)
                for file in try FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:[.contentModificationDateKey]) {
                    if let date=try file.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate,
                       Date().timeIntervalSince(date)>86400 {try? FileManager.default.removeItem(at:file)}
                }
                let file=folder.appendingPathComponent("Route-"+UUID().uuidString+".zip")
                _=try LocalProfiles.profileTool(["export",dir.path,file.path]+ids)
                NSSharingServicePicker(items:[file]).show(relativeTo:NSRect(x:view.bounds.midX,y:view.bounds.midY,width:1,height:1),of:view,preferredEdge:.minY)
            } else {
                guard !running else {
                    let alert=NSAlert();alert.messageText=routeText("Отключите VPN перед удалением профилей");alert.runModal();return
                }
                _=try LocalProfiles.profileTool(["delete",dir.path]+ids)
                catalog=LocalProfiles.catalog()
                count=try LocalProfiles.profileCount(dir)
                if ids.contains(selected){selectProfile("")}
                saveProfilePriority(String(decoding:try JSONEncoder().encode(priority.filter{!ids.contains($0)}),as:UTF8.self))
            }
        }catch{let alert=NSAlert(error:error);alert.runModal()}
    }
    func importArchive() {
        guard !running && !busy else { message = "Сначала отключите соединение."; return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let size = try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? Int.max
            guard size <= 1_048_576 else { throw ActivationError.archive }
            count = try LocalProfiles.install(Data(contentsOf:url),into:LocalProfiles.directory)
            catalog = LocalProfiles.catalog()
            reconcileSelection()
            message = "Профили импортированы"
        } catch { message = error.localizedDescription }
    }

    func activate(_ code:String) async -> (Bool,String) {
        guard !running && !busy else {return (false,routeText("Сначала отключите соединение."))}
        busy=true
        defer {busy=false}
        do {
            count=try await LocalProfiles.activate(code,into:LocalProfiles.directory)
            catalog=LocalProfiles.catalog()
            reconcileSelection()
            return (true,routeText("Профили получены"))
        } catch {return (false,error.localizedDescription)}
    }

    func checkUpdate() async {
        guard !checkingUpdate else{return}
        checkingUpdate=true
        defer {checkingUpdate=false}
        let alert=NSAlert()
        do {
            if let release=try await ReleaseUpdate.check(){
                alert.messageText=routeText("Доступен «Маршрут» ")+release.version
                alert.informativeText=routeText("Распакуйте ZIP и замените приложение в папке программ.")
                alert.addButton(withTitle:routeText("Скачать ZIP"))
                alert.addButton(withTitle:routeText("Позже"))
                if alert.runModal() == .alertFirstButtonReturn {NSWorkspace.shared.open(ReleaseUpdate.download)}
                return
            }
            alert.messageText=routeText("Установлена актуальная версия")
            alert.informativeText=routeText("Маршрут ")+ReleaseUpdate.version
        } catch {
            alert.messageText=routeText("Не удалось проверить обновления")
            alert.informativeText=routeText("Повторите проверку, когда появится связь с сервером.")
        }
        alert.addButton(withTitle:"OK");alert.runModal()
    }

    func toggle() {
        if running { stop(); return }
        guard !busy, count>0, let tools = Bundle.main.resourceURL else { return }
        healthFile = LocalProfiles.home.appendingPathComponent(".journey-" + UUID().uuidString + ".json")
        let sessionHealth = healthFile
        activeRoute = ""
        active = ""
        healthKnown = false
        let child = Process()
        child.executableURL = tools.appendingPathComponent("route-client")
        child.arguments = ["-config",LocalProfiles.directory.appendingPathComponent("profiles.json").path,
                           "-engines",tools.appendingPathComponent("engines").path,"-status",healthFile.path]
        if let data=try? JSONSerialization.data(withJSONObject:tunnelOptions){
            child.arguments?.append(contentsOf:["-advanced",String(decoding:data,as:UTF8.self)])
        }
        activeSocks=tunnelOptions["socks"] as? Int ?? 17680
        if !server.isEmpty {child.arguments?.append(contentsOf:["-server",server,"-order",priority.joined(separator:",")])}
        else if !selected.isEmpty { child.arguments?.append(contentsOf:["-profile",selected]) }
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] _ in
            try? FileManager.default.removeItem(at:sessionHealth)
            Task { @MainActor in
                guard let self, self.process === child else { return }
                self.process = nil
                self.running = false
                if self.switching {
                    self.switching = false
                    self.toggle()
                } else {
                    self.message = "Прокси завершил работу"
                }
            }
        }
        do {
            try child.run()
            process=child
            running=true
            message="Локальный SOCKS5 запущен"
        } catch { message="Не удалось запустить прокси" }
    }

    func stop() {
        if process?.isRunning == true { process?.terminate() }
        process=nil
        switching=false
        running=false
        active=""
        healthKnown=false
        activeRoute=""
        message="Отключено"
    }
}

struct JourneyContent: View {
    @StateObject private var model = Model()
    @AppStorage("reduceJourneyMotion") private var still = false
    private let ticks = Timer.publish(every:1.2,on:.main,in:.common).autoconnect()
    var body: some View {
        JourneyBrowser(model:model, still:$still)
            .frame(minWidth:375,idealWidth:435,maxWidth:600,minHeight:500,idealHeight:620,maxHeight:850)
            .onReceive(ticks) { _ in model.refreshHealth() }
            .onDisappear { model.stop() }
    }
}

private enum InterfaceLanguage: String {
    case system, ru, en, es
    static let key = "interfaceLanguage"
    static var current: Self {
        Self(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .system
    }
    var resolved: String {
        self == .system ? Bundle.main.preferredLocalizations.first ?? "en" : rawValue
    }
}

private func routeText(_ source: String) -> String {
    let language = InterfaceLanguage.current.resolved
    guard language != "ru",
          let url = Bundle.main.url(forResource: language, withExtension: "lproj"),
          let bundle = Bundle(url: url) else { return source }
    return bundle.localizedString(forKey: source, value: source, table: nil)
}

private var routePage: String {
    switch InterfaceLanguage.current.resolved {
    case "en": return "index-en.html"
    case "es": return "index-es.html"
    default: return "index.html"
    }
}

struct JourneyBrowser: NSViewRepresentable {
    @ObservedObject var model: Model
    @Binding var still: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator,name:"route")
        let view = WKWebView(frame:.zero,configuration:config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        if let root = Bundle.main.resourceURL?.appendingPathComponent("journey",isDirectory:true) {
            view.loadFileURL(root.appendingPathComponent(routePage),allowingReadAccessTo:root)
        }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update(view)
    }
    static func dismantleNSView(_ view:WKWebView, coordinator:Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName:"route")
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var parent: JourneyBrowser
        var reopenSettings = false
        var loaded = false
        var last = Data()
        init(_ parent: JourneyBrowser) {self.parent = parent}
        func update(_ view:WKWebView) {
            guard loaded else {return}
            let model = parent.model
            let phase = model.running ? (model.activeRoute.isEmpty ? "travel" : "connected") : "home"
            var status = model.running ? (model.activeRoute.isEmpty ? routeText("Поиск маршрута") : routeText("SOCKS5 подключён")) : routeText(model.message)
            if model.running && model.healthKnown && model.active.isEmpty && !model.selected.isEmpty {
                status = model.server.isEmpty ? routeText("Профиль недоступен") : routeText("Ищем рабочий протокол")
            }
            let state: [String:Any] = ["phase":phase,"status":status,"count":model.count,
                "platform":"macos","language":InterfaceLanguage.current.rawValue,"tunnelOptions":model.tunnelOptions,"activeSocks":model.activeSocks,"version":ReleaseUpdate.version,"checking":model.checkingUpdate,
                "route":model.activeRoute,"busy":model.busy,"still":parent.still,
                "catalog":model.catalog,"active":model.active,"selected":model.selected,"server":model.server,"priority":model.priority]
            guard let data = try? JSONSerialization.data(withJSONObject:state,options:.sortedKeys), data != last else {return}
            last = data
            view.callAsyncJavaScript("window.routeState(s)",arguments:["s":state],in:nil,in:.page,completionHandler:nil)
        }
        func webView(_ webView:WKWebView, decidePolicyFor action:WKNavigationAction,
                     decisionHandler:@escaping (WKNavigationActionPolicy)->Void) {
            let page = Bundle.main.resourceURL?.appendingPathComponent("journey").appendingPathComponent(routePage).standardizedFileURL
            decisionHandler(action.request.url?.isFileURL == true && action.request.url?.standardizedFileURL == page ? .allow : .cancel)
        }
        func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
            guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
                  let view=message.webView,let body=message.body as? [String:String],let action=body["action"] else{return}
            let model=parent.model
            switch action {
            case "ready":
                loaded=true;last=Data();update(view)
                if reopenSettings {
                    reopenSettings=false
                    view.evaluateJavaScript("window.routeOpenLanguageSettings()",completionHandler:nil)
                }
            case "language":
                guard let value=body["value"],let choice=InterfaceLanguage(rawValue:value),
                      let root=Bundle.main.resourceURL?.appendingPathComponent("journey") else {return}
                let previousPage=routePage
                UserDefaults.standard.set(choice.rawValue,forKey:InterfaceLanguage.key)
                if previousPage == routePage {update(view);return}
                loaded=false;reopenSettings=true
                view.loadFileURL(root.appendingPathComponent(routePage),allowingReadAccessTo:root)
            case "select": model.selectProfile(body["value"] ?? "")
            case "tunnel-options": model.saveTunnel(body["value"] ?? "")
            case "priority": model.saveProfilePriority(body["value"] ?? "")
            case "connect-server": model.connectServer(body["value"] ?? "")
            case "connect-priority": model.connectPrioritized(body["value"] ?? "")
            case "connect": if !model.running {model.toggle()}
            case "disconnect": if model.running {model.stop()}
            case "motion": parent.still=body["value"]=="true"
            case "update": Task {await model.checkUpdate()}
            case "activate":
                Task {let (ok,info)=await model.activate(body["value"] ?? "")
                    view.callAsyncJavaScript("window.routeImportResult(ok,info)",arguments:["ok":ok,"info":info],in:nil,in:.page,completionHandler:nil)}

            case "share","delete": model.manageProfiles(action,raw:body["value"] ?? "",view:view)
            case "encrypted-subscription":
                guard let value=body["value"],value.range(of:"^happ://crypt[0-9]*/",options:.regularExpression) != nil,let url=URL(string:value) else{break}
                let prompt=NSAlert();prompt.messageText=routeText("Открыть зашифрованную подписку в Happ?")
                prompt.addButton(withTitle:routeText("Открыть"));prompt.addButton(withTitle:routeText("Отмена"))
                if prompt.runModal() == .alertFirstButtonReturn {NSWorkspace.shared.open(url)}
            case "paste-link","paste-json":
                let value=NSPasteboard.general.string(forType:.string) ?? ""
                guard value.utf8.count<=1048576 else {break}
                view.callAsyncJavaScript("window.routePaste(value,jsonOnly)",arguments:["value":value,"jsonOnly":action=="paste-json"],in:nil,in:.page,completionHandler:nil)
            case "profile-qr","share-qr-image":
                let sharing=action=="share-qr-image", raw=body["value"] ?? ""
                let request=(try? JSONDecoder().decode([String].self,from:Data(raw.utf8))) ?? []
                guard sharing || request.count==2 else {break}
                let id=sharing ? raw : request[1]
                Task {
                    do {
                        let png=try await Task.detached {try LocalProfiles.profileTool(["qr",LocalProfiles.directory.path,id])}.value
                        if sharing {
                            guard let bytes=Data(base64Encoded:png),let image=NSImage(data:bytes) else {throw ActivationError.archive}
                            NSSharingServicePicker(items:[image]).show(relativeTo:view.bounds,of:view,preferredEdge:.minY)
                        } else {view.callAsyncJavaScript("window.routeQR(rev,png,'')",arguments:["rev":request[0],"png":png],in:nil,in:.page,completionHandler:nil)}
                    } catch {
                        if sharing {NSAlert(error:error).runModal()}
                        else {view.callAsyncJavaScript("window.routeQR(rev,'',msg)",arguments:["rev":request[0],"msg":error.localizedDescription],in:nil,in:.page,completionHandler:nil)}
                    }
                }
            case "copy-json":
                let id=body["value"] ?? ""
                Task {
                    do {
                        let json=try await Task.detached {try LocalProfiles.profileTool(["copy-json",LocalProfiles.directory.path,id])}.value
                        NSPasteboard.general.clearContents();NSPasteboard.general.setString(json,forType:.string)
                        view.callAsyncJavaScript("window.routeImportResult(true,msg)",arguments:["msg":routeText("JSON скопирован")],in:nil,in:.page,completionHandler:nil)
                    } catch {view.callAsyncJavaScript("window.routeImportResult(false,msg)",arguments:["msg":routeText("Не удалось скопировать JSON профиля.")],in:nil,in:.page,completionHandler:nil)}
                }
            case "zip": model.importArchive()
            case "import","subscribe":
                let value=body["value"] ?? ""
                Task { let (ok,info) = await model.importLink(value,command:action=="subscribe" ? "subscribe":"add")
                    view.callAsyncJavaScript("window.routeImportResult(ok,info)",arguments:["ok":ok,"info":info],
                                             in:nil,in:.page,completionHandler:nil)
                }
            default: break
            }
        }
        func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,
                     initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping ([URL]?)->Void) {
            guard frame.isMainFrame else {completionHandler(nil);return}
            let panel = NSOpenPanel()
            panel.allowedContentTypes=[.image]
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }
}

struct RouteWindow: App {
    @AppStorage(InterfaceLanguage.key) private var language = InterfaceLanguage.system.rawValue
    var body: some Scene {
        Window(Text(verbatim: (InterfaceLanguage(rawValue: language)?.resolved == "ru") ? "Маршрут" : routeText("Маршрут")), id:"journey") { JourneyContent() }
            .windowResizability(.contentSize)
    }
}
@main struct RouteProgram {
    static func main() async {
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--activate" {
            do {
                guard let code = readLine() else { throw ActivationError.code }
                let count = try await LocalProfiles.activate(code,into:LocalProfiles.directory)
                print("Profiles imported: \(count)")
            } catch {
                fputs(error.localizedDescription+"\n",stderr)
                exit(1)
            }
        } else {
            await MainActor.run { RouteWindow.main() }
        }
    }
}
