// Browser-only stand-in for the Android RouteHost bridge (JourneyScreen.java).
// Lets the WebView scene run on localhost with fake profiles. Not shipped in APK.
(function () {
  const catalog = [
    { id: "p1", name: "София", kind: "xhttp-tls", endpoint: "131.123.37.10", location: "sofia", protected: true },
    { id: "p2", name: "Цюрих", kind: "xhttp-reality", endpoint: "132.243.161.20", location: "zurich", protected: true },
    { id: "p3", name: "Кишинёв", kind: "amneziawg", endpoint: "176.123.5.30", location: "chisinau", protected: false },
    { id: "p4", name: "Личный", kind: "naive", endpoint: "example.net", location: "", protected: false },
  ];
  const state = {
    phase: "home", status: "Отключено", count: catalog.length, route: "",
    sharedAddress: "", canExclude: true,
    tunnelOptions: { socks: 17680, http: 0, lan: "off", sniff: "profile", mux: "profile", ip: "profile",
      engineDNS: "profile", fragment: "profile", method: "GET", timeout: 6, interval: 30, mode: "vpn" },
    platform: "android", version: "0.40-web", checking: false,
    catalog, server: "", selected: "", priority: catalog.map(p => p.id), active: [], busy: false, still: false,
  };
  let timer = 0;
  const push = () => setTimeout(() => window.routeState && window.routeState(JSON.parse(JSON.stringify(state))), 0);
  function connect(id) {
    const p = catalog.find(x => x.id === (id || state.selected)) || catalog.find(x => x.id === state.priority[0]);
    clearTimeout(timer);
    Object.assign(state, { phase: "travel", status: "Поиск маршрута", busy: false, active: [], server: p.id });
    push();
    timer = setTimeout(() => { Object.assign(state, { phase: "connected", status: "Подключено", active: [p.id], route: p.id }); push(); }, 3000);
  }
  window.RouteHost = {
    post(action, value) {
      console.log("[RouteHost]", action, value);
      switch (action) {
        case "ready": push(); break;
        case "connect": connect(); break;
        case "connect-server": case "connect-priority": connect(value && value.split(",")[0]); break;
        case "select": state.selected = value || ""; push(); break;
        case "priority": try { state.priority = JSON.parse(value); } catch { state.priority = String(value).split(","); } push(); break;
        case "disconnect": clearTimeout(timer); Object.assign(state, { phase: "home", status: "Отключено", active: [], route: "" }); push(); break;
        case "motion": state.still = value === "true" || value === true; push(); break;
        default: if (window.routeImportResult && /^(import|paste|link|manual|code)/.test(action)) window.routeImportResult(false, "Веб-превью: импорт недоступен");
      }
    },
  };
})();
