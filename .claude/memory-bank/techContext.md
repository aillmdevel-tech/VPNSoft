# techContext
- Ядро Go (stdlib), тесты: `go test main.go advanced.go proxy_listeners.go android_policy.go route_catalog.go *_test.go` (корень) и `cd profiletool && go test ./...`.
- Android без Gradle: build_android.zsh (javac/d8/aapt2), minSdk 30. Android SDK на этом Mac НЕ установлен.
- Сцена: WebView грузит file:///android_asset/journey/, macOS WKWebView loadFileURL. CSP: script-src 'self' file:, connect-src 'none' → без fetch/XHR/ES-модулей; модели только base64 в классических JS.
- Локализация: locales/build.py ищет кириллицу в index.html/journey.js/globe.js; переводы в locales/en.json, es.json.
- Мост: journey.js `send()` → RouteHost.post(action,value) / webkit.messageHandlers.route; нативное → window.routeState(obj), routeImportResult, routePaste, routeQR, routeBack. Фазы home/travel/connected/return, still.
- Веб-превью: `zsh tools/web-preview/serve.zsh 5180` → http://localhost:5180/ (mock-host.js заглушка моста, 4 фейк-профиля). Выход в build/web-preview (gitignored).
- Стек 3D: GameFactory THREEJS_STACK.md (three 0.187, postprocessing, three.quarks, gsap, Rapier) → бандл Vite в IIFE.
