(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const preview = $("preview"), dialog = $("tools"), forms = ["link", "qr", "manual","activation","copy-json"];
  let info = {phase:"home", count:0, status:"Отключено", route:""};
  const locations = Object.fromEntries(Object.entries(window.RouteGlobe.locations).map(([key,place]) => [key,place.name]));
  const kinds = {
    "xhttp-tls": "VLESS XHTTP · HTTP/3",
    "xhttp-reality": "VLESS XHTTP · REALITY",
    naive: "NaiveProxy", trusttunnel: "TrustTunnel", amneziawg: "AmneziaWG 3.1", mieru: "Mieru v3",
  };
  let globe = null;
  let mapRenderKey = "";
  let phase = "", timer = 0, qrValue = "", qrEpoch = 0, importing = false, addPanel = "options";
  function send(action, value = "") {
    if (window.RouteHost) window.RouteHost.post(action, value);
    else if (window.webkit?.messageHandlers?.route) window.webkit.messageHandlers.route.postMessage({action,value});
  }
  function show(next) {
    phase = next;
    preview.dataset.phase = next;
    document.documentElement.dataset.journey = next;
    $("prince").disabled = next !== "home";
    $("action").hidden = next === "connected" || next === "travel";
    $("action").disabled = next === "return" || info.busy;
    $("cancel").hidden = next !== "connected" && next !== "travel";
    $("action").textContent = next === "return" ? "Возвращаемся…" : "Подключить";
    $("state").textContent = info.status;
    $("state").title = info.status;
    const selected = (info.catalog || []).find(profile => profile.id === info.selected);
    const live=(info.catalog || []).find(p=>p.id===info.active);
    const pinned=info.server ? (groupedServers(orderedProfiles()).find(item=>item.endpoint===info.server)?.title || info.server) : "";
    $("scene-note").textContent = info.server ? (live && live.endpoint===info.server ? profileDescription(live) : pinned+" · Автовыбор протокола") : selected ? profileDescription(selected)
      : info.selected ? "Выбранный профиль отсутствует"
      : info.route || (info.count ? "Профили · " + info.count : "Добавьте профиль кнопкой «+».");
    renderMap();
    renderPriority();
  }
  window.routeState = obj => {
    info = obj;
    document.documentElement.dataset.platform=info.platform||"";
    if ($("preferences").open) refreshPreferences();
    document.documentElement.classList.toggle("still", !!info.still);
    if (info.phase !== "home") {
      clearTimeout(timer);
      show(info.phase);
    } else if ((phase === "connected" || phase === "travel") && !info.still && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      show("return"); timer = setTimeout(() => show(info.phase), 850);
    } else if (phase !== "return") show("home");
    if (info.phase === "connected") passportVisit();
  };
  function profileDescription(profile) {
    const place = locations[profile.location] || profile.endpoint;
    const protocol = kinds[profile.kind] || profile.kind;
    return place ? place + " · " + protocol : protocol;
  }
  const priorityRows = $("profile-rows");
  const plurals = new Intl.PluralRules("ru");
  let expandedServer = "";
  let priorityKey = "", drag = null, scrollFrame = 0;

  function orderedProfiles() {
    const remaining = new Map((info.catalog || []).map(profile => [profile.id, profile]));
    const ordered = [];
    for (const id of info.priority || []) {
      if (remaining.has(id)) {
        ordered.push(remaining.get(id));
        remaining.delete(id);
      }
    }
    return ordered.concat([...remaining.values()]);
  }
  function canConnect(profile) {
    return !info.protectedMode || profile.protected;
  }

  function groupedServers(ordered) {
    const groups = new Map();
    const profiles = [...ordered.filter(canConnect), ...ordered.filter(profile => !canConnect(profile))];
    for (const profile of profiles) {
      const key = profile.endpoint ? "host:" + profile.endpoint : "profile:" + profile.id;
      if (!groups.has(key)) {
        const place = locations[profile.location] ? profile.location : "";
        groups.set(key, {
          key, place, endpoint:profile.endpoint || "",
          title:locations[place] || profile.endpoint || profile.name || profile.id,
          profiles:[],
        });
      }
      groups.get(key).profiles.push(profile);
    }
    return [...groups.values()];
  }

  function profileCount(count, labels) {
    return count + " " + (labels[plurals.select(count)] || labels.many);
  }

  function replaceRows(root, rows) {
    const focus = root.contains(document.activeElement) ? document.activeElement.dataset.focus : "";
    root.replaceChildren(...rows);
    if (focus) {
      [...root.querySelectorAll("[data-focus]")].find(item => item.dataset.focus === focus)
        ?.focus({preventScroll:true});
    }
  }

  function serverRow(server, index, options = {}) {
    const {movable, top} = options;
    const expanded = expandedServer === server.key;
    const row = document.createElement("li");
    row.className = "server-row";
    row.dataset.id = server.key;
    if (server.place) row.dataset.place = server.place;
    row.style.setProperty("--i", String(index));
    const active = server.profiles.some(profile => profile.id === info.active);
    const selected = info.server ? server.endpoint===info.server : server.profiles.some(profile => profile.id === info.selected);
    const unavailable = !server.profiles.some(canConnect);
    if (unavailable) row.dataset.unavailable = "";
    row.classList.toggle("active", active);
    row.classList.toggle("first", !!top && server.profiles.includes(top));

    const header = document.createElement("div");
    header.className = "server-head";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "server-toggle";
    toggle.dataset.focus = "server:" + server.key;
    toggle.setAttribute("aria-expanded", String(expanded));
    const panelId = "server-protocols-" + index;
    toggle.setAttribute("aria-controls", panelId);
    const copy = document.createElement("span");
    copy.className = "server-copy";
    const title = document.createElement("strong");
    title.textContent = server.title;
    const count = new Set(server.profiles.map(profile => profile.kind)).size;
    const detail = count === server.profiles.length
      ? profileCount(count, {one:"протокол",few:"протокола",many:"протоколов"})
      : profileCount(server.profiles.length, {one:"профиль",few:"профиля",many:"профилей"});
    const meta = document.createElement("small");
    meta.textContent = [server.title === server.endpoint ? "" : server.endpoint, detail].filter(Boolean).join(" · ");
    copy.append(title, meta);
    toggle.append(copy);
    if (active || selected || unavailable) {
      const status = document.createElement("span");
      status.className = "server-status";
      status.textContent = active ? "Активен" : unavailable ? "Недоступен" : "Выбран";
      toggle.append(status);
    }
    toggle.onclick = () => {
      expandedServer = expanded ? "" : server.key;
      renderPriority();
    };
    header.append(toggle);
    if (movable && !unavailable) header.append(priorityGrip(server.key, server.title));
    const ids = server.profiles.map(profile => profile.id);
    const shell = document.createElement("div");
    shell.className = "swipe-shell";
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const menu = document.createElement("button");
    menu.className = "row-more";
    menu.textContent = "⋯";
    menu.setAttribute("aria-label", "Действия · " + server.title);
    let start, suppress = false;
    const reveal = open => {
      document.querySelectorAll(".swipe-shell.open").forEach(other => {
        if (open && other !== shell) other.querySelector(".row-more").click();
      });
      shell.classList.toggle("open",open);
      actions.inert = !open;
      menu.setAttribute("aria-expanded",String(open));
      header.style.removeProperty("transform");
    };
    for (const [label,action] of [["Поделиться","share"],["Удалить","delete"]]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => {
        reveal(false);
        if(action==="share") openShare(server);
        else {
          const box = $("remove-dialog");
          $("remove-text").textContent = "Удалить «" + server.title + "» и все его профили с этого устройства?";
          $("remove-confirm").onclick = () => { box.close(); send("delete",JSON.stringify(ids)); };
          box.showModal();
        }
      };
      actions.append(button);
    }
    actions.inert = true;
    menu.setAttribute("aria-expanded","false");
    menu.onclick = () => reveal(!shell.classList.contains("open"));
    header.insertBefore(menu,header.querySelector(".priority-grip"));
    header.addEventListener("pointerdown",e=>{
      if (!e.isPrimary || e.button!==0 || e.target.closest(".priority-grip")) return;
      suppress=false;
      start={id:e.pointerId,x:e.clientX,y:e.clientY,open:shell.classList.contains("open"),moving:false};
    });
    header.addEventListener("pointermove",e=>{
      if (!start || e.pointerId!==start.id) return;
      const dx=e.clientX-start.x,dy=e.clientY-start.y;
      if(!start.moving){
        if(Math.abs(dy)>8 && Math.abs(dy)>=Math.abs(dx)){start=null;return}
        if(Math.abs(dx)<8)return;
        header.setPointerCapture(e.pointerId); start.moving=true; suppress=true;
        header.classList.add("swiping");
      }
      const width=actions.offsetWidth;
      header.style.transform="translateX("+Math.max(-width,Math.min(0,(start.open?-width:0)+dx))+"px)";
    });
    for(const event of ["pointerup","pointercancel","lostpointercapture"])header.addEventListener(event,e=>{
      if(event==="lostpointercapture" && e.target!==header)return;
      if(!start || e.pointerId!==start.id)return;
      const gesture=start;start=null;
      if(!gesture.moving)return;
      header.classList.remove("swiping");
      const delta=e.clientX-gesture.x;
      reveal(event==="pointerup" && Math.abs(delta)>28 ? delta<0 : gesture.open);
    });
    header.addEventListener("click",e=>{
      if(suppress){suppress=false;e.stopImmediatePropagation();return}
      if(shell.classList.contains("open") && !e.target.closest(".row-more")){reveal(false);e.stopImmediatePropagation()}
    },true);
    shell.append(actions,header);row.append(shell);


    const panel = document.createElement("ol");
    panel.id = panelId;
    panel.className = "protocol-list";
    panel.dataset.server = server.key;
    panel.hidden = !expanded;
    if (expanded) {
      const reorderable = server.profiles.filter(canConnect).length > 1;
      for (const profile of server.profiles) {
        const protocol = document.createElement("li");
        protocol.className = "protocol-row";
        protocol.dataset.id = profile.id;
        const eligible = canConnect(profile);
        if (!eligible) protocol.dataset.unavailable = "";
        const label = kinds[profile.kind] || profile.kind;
        const duplicate = server.profiles.some(other => other !== profile && other.kind === profile.kind);
        const name = profile.name === server.title || profile.name === server.endpoint ? "" : profile.name;
        protocol.append(profileOption(label, name || (duplicate ? profile.id : ""), profile.id, !eligible));
        if (reorderable && eligible) protocol.append(priorityGrip(profile.id, label));
        panel.append(protocol);
      }
    }
    row.append(panel);
    return row;
  }

  const heroKey = "route.hero";
  const heroes = [["prince", "Принц"], ["bear", "Мишка"], ["pig", "Хрюша"], ["rv", "Автодом"]];
  let hero = "prince";
  try { const saved = localStorage.getItem(heroKey); if (heroes.some(([id]) => id === saved)) hero = saved; } catch {}
  const heroName = () => (heroes.find(([id]) => id === hero) || heroes[0])[1];

  function renderPriority() {
    const ordered = orderedProfiles();
    const top = ordered.find(canConnect);
    $("profile-table").hidden = !ordered.length;
    $("prince").disabled = phase!=="home" || !!info.busy || (ordered.length > 0 && !top);
    $("prince").setAttribute("aria-label", heroName() + ". " + (top
      ? "Подключить " + profileDescription(top)
      : "Начать подключение"));
    const key = JSON.stringify([ordered, info.server, info.selected, info.active, info.busy, info.protectedMode, expandedServer]);
    if (drag || key === priorityKey) return;
    priorityKey = key;
    const servers = groupedServers(ordered);
    const movable = servers.filter(server => server.profiles.some(canConnect)).length > 1;
    replaceRows($("auto-route"), [profileOption("Автоматический выбор", "", "", !top)]);
    replaceRows(priorityRows, servers.map((server,index) => serverRow(server,index,{movable,top})));
  }

  function priorityGrip(key, label) {
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "priority-grip";
    grip.disabled = !!info.busy;
    grip.dataset.focus = "priority:" + key;
    grip.setAttribute("aria-label", "Изменить приоритет: " + label);
    grip.title = "Перетащите или используйте ↑ и ↓";
    grip.onkeydown = event => keyMove(event, grip.closest("li"));
    return grip;
  }

  function movableRows(parent) {
    return [...parent.children].filter(row => !("unavailable" in row.dataset));
  }

  function savePriority(parent, keys, moved) {
    const profiles = orderedProfiles();
    const servers = new Map(groupedServers(profiles).map(server => [server.key, server.profiles]));
    const ids = parent === priorityRows
      ? keys.flatMap(key => (servers.get(key) || []).filter(canConnect).map(profile => profile.id))
      : keys;
    // Reordering only replaces slots that belong to the moved server or to eligible servers.
    const eligible = new Set(ids);
    let next = 0;
    const original = profiles.map(profile => profile.id);
    const order = original.map(id => eligible.has(id) ? ids[next++] : id);
    if (order.some((id,i) => id !== original[i])) {
      info.priority = order;
      send("priority", JSON.stringify(order));
      const pinnedTitle = parent === priorityRows && info.server ? groupedServers(profiles).find(item=>item.endpoint===info.server)?.title : "";
      $("priority-feedback").textContent = "Новая позиция: " + (keys.indexOf(moved) + 1) + (pinnedTitle ? ". «Подключить» ведёт в «" + pinnedTitle + "», Принц — по списку" : "");
    }
    priorityKey = "";
    renderPriority();
  }

  function keyMove(event, row) {
    const parent = row.parentElement;
    const ids = movableRows(parent).map(item => item.dataset.id);
    const id = row.dataset.id, old = ids.indexOf(id);
    const position = {ArrowUp:old - 1, ArrowDown:old + 1, Home:0, End:ids.length - 1}[event.key];
    if (position === undefined) return;
    event.preventDefault();
    if (position < 0 || position >= ids.length || position === old) return;
    ids.splice(old, 1);
    ids.splice(position, 0, id);
    savePriority(parent, ids, id);
  }

  function moveDrag(y) {
    const {row, parent} = drag;
    const candidates = movableRows(parent);
    const before = candidates.find(item => {
      if (item === row) return false;
      const {top, height} = (item.querySelector(":scope > .swipe-shell > .server-head") || item).getBoundingClientRect();
      return y < top + height / 2;
    }) || candidates.at(-1)?.nextElementSibling || null;
    if (row.nextElementSibling !== before) parent.insertBefore(row, before);
  }

  function dragScroll() {
    if (!drag?.moved) return;
    const y = drag.y;
    const delta = y < 65 ? Math.max(-18, (y - 65) / 4)
      : y > innerHeight - 65 ? Math.min(18, (y - innerHeight + 65) / 4) : 0;
    if (delta) {
      window.scrollBy(0, delta);
      moveDrag(y);
    }
    scrollFrame = requestAnimationFrame(dragScroll);
  }

  priorityRows.addEventListener("pointerdown", event => {
    const grip = event.target.closest(".priority-grip");
    if (!grip || grip.disabled || drag || event.button !== 0 || !event.isPrimary) return;
    const row = grip.closest("li");
    const parent = row.parentElement;
    drag = {row,parent,pointer:event.pointerId,y:event.clientY,start:event.clientY,moved:false,
      original:movableRows(parent).map(item => item.dataset.id)};
    priorityRows.setPointerCapture(event.pointerId);
  });

  priorityRows.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.y = event.clientY;
    if (!drag.moved && Math.abs(drag.y - drag.start) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.row.classList.add("dragging");
      document.documentElement.classList.add("reordering");
      scrollFrame = requestAnimationFrame(dragScroll);
    }
    moveDrag(drag.y);
  });

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const {row,parent,moved,original} = drag;
    drag = null;
    cancelAnimationFrame(scrollFrame);
    row.classList.remove("dragging");
    document.documentElement.classList.remove("reordering");
    if (!moved) {
      renderPriority();
      return;
    }
    const ids = movableRows(parent).map(item => item.dataset.id);
    if (event.type === "pointerup" && ids.some((id,i) => id !== original[i])) savePriority(parent, ids, row.dataset.id);
    else {
      priorityKey = "";
      renderPriority();
    }
  }

  for (const type of ["pointerup","pointercancel","lostpointercapture"]) {
    priorityRows.addEventListener(type, finishDrag);
  }
  let actorPlace="", actorAt=null, hop=null, landTimer=0;
  const calmMotion=matchMedia("(prefers-reduced-motion: reduce)");
  function positionActors(project,zoom){
    const target=window.RouteGlobe.locations[actorPlace],el=$("prince-anchor"),piece=$("prince");
    if(!target){el.hidden=true;actorAt=null;hop=null;if(globe)globe.stage({phase,place:"",prince:null});return}
    // The Prince hops along the surface when the focused city changes.
    if(actorAt && actorAt.place!==actorPlace){
      const still=calmMotion.matches || document.documentElement.classList.contains("still");
      const span=Math.hypot(target.lat-actorAt.lat,(target.lon-actorAt.lon)*Math.cos(target.lat*Math.PI/180));
      hop=still || span<.5 ? null : {lat:actorAt.lat,lon:actorAt.lon,start:performance.now(),ms:Math.min(1350,640+span*26),height:Math.min(1,.45+span/40)};
    }
    let prince={lat:target.lat,lon:target.lon},lift=0,sx=1,sy=1,lean=0,energy=0,crouched=0,air=0;
    if(hop){
      const t=(performance.now()-hop.start)/hop.ms, crouch=.17;
      if(t>=1){
        hop=null;
        piece.classList.remove("landing");void piece.offsetWidth;piece.classList.add("landing");
        clearTimeout(landTimer);landTimer=setTimeout(()=>piece.classList.remove("landing"),460);
      }else{
        if(t<crouch){
          // Anticipation: he gathers himself before leaving the ground.
          const k=Math.sin(Math.PI*.5*t/crouch);
          sy=1-.07*k;sx=1+.04*k;crouched=k;
          prince={lat:hop.lat,lon:hop.lon};
        }else{
          const u=(t-crouch)/(1-crouch), ease=u*u*(3-2*u);
          prince={lat:hop.lat+(target.lat-hop.lat)*ease,lon:hop.lon+(target.lon-hop.lon)*ease};
          lift=Math.sin(Math.PI*u)*hop.height;
          sy=u<.12 ? .93+.12*u/.12 : 1+.05*Math.cos(Math.PI*(u-.12)/.88);
          sx=2-sy;
          const side=Math.sign(project(target.lat,target.lon)[0]-project(hop.lat,hop.lon)[0]) || 1;
          lean=side*9*Math.sin(Math.PI*u)*(1-.3*u);
          energy=air=Math.sin(Math.PI*u);
        }
        requestAnimationFrame(()=>globe && globe.refresh());
      }
    }
    actorAt={place:actorPlace,lat:prince.lat,lon:prince.lon};
    el.style.setProperty("--hop",lift.toFixed(3));
    piece.style.setProperty("--sx",sx.toFixed(3));
    piece.style.setProperty("--sy",sy.toFixed(3));
    piece.style.setProperty("--lean",lean.toFixed(2));
    window.RouteMotion.energy(energy);
    window.RouteMotion.pose({crouch:crouched,air,eager:phase==="travel"});
    if(globe)globe.stage({phase,place:actorPlace,prince:{lat:prince.lat,lon:prince.lon,lift}});
    const [x,y,z]=project(prince.lat,prince.lon);
    el.hidden=z<.045 || x<-.04 || y<-.04 || x>1.04 || y>1.12;
    const north=project(prince.lat+.025,prince.lon);
    el.style.transform="rotate("+Math.atan2(north[0]-x,y-north[1])*180/Math.PI+"deg)";
    el.style.zIndex=String(2+Math.round(z*4));
    el.style.left=x*100+"%";el.style.top=y*100+"%";
    el.style.setProperty("--piece-scale",String(Math.min(1.45,Math.sqrt(zoom))*(.76+.24*Math.max(0,z))));
    el.style.opacity=String(Math.min(1,Math.max(0,(z-.045)/.12)));
  }
  function renderMap() {
    $("planet-map").hidden = false;
    window.RouteMotion.show("home", !!info.still);
    $("planet-map").classList.add("map-open");
    const places = new Set(groupedServers(orderedProfiles()).map(server => server.place).filter(Boolean));
    const ordered=orderedProfiles();
    const focus=ordered.find(p=>p.id===info.active) || ordered.find(p=>p.id===info.selected) || ordered.find(canConnect);
    actorPlace=focus?.location || "";
    const key = JSON.stringify([[...places],actorPlace,phase,info.busy,info.protectedMode,ordered.map(p=>[p.id,p.protected])]);
    if (key !== mapRenderKey) {
      mapRenderKey = key;
      const pins = [];
      for (const place of places) {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "planet-pin";
        pin.dataset.place = place;
        pin.textContent = locations[place];
        pin.classList.toggle("chosen", focus?.location === place);
        const available=()=>groupedServers(orderedProfiles()).find(s=>s.place===place && s.profiles.some(canConnect));
        pin.disabled=!!info.busy || !available();
        pin.setAttribute("aria-label","Подключиться · "+locations[place]);
        pin.onclick=()=>{
          const profile=available()?.profiles.find(canConnect);
          if(profile && !info.busy)send("connect-server",profile.id);
        };
        pins.push(pin);
      }
      $("pins").replaceChildren(...pins);
      {
        globe ||= window.RouteGlobe.create($("globe-map"), $("globe-markers"),positionActors);
        applyHero();
        globe.markers(pins);
        $("pins").hidden=false;
      }
    }
  }
  function selectRoute(id) {
    if (info.server || id !== (info.selected || "")) send("select", id);
    renderMap();
  }

  function profileOption(title, detail, id, blocked = false) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "profile-choice";
    option.dataset.focus = "profile:" + id;
    option.disabled = !!info.busy || blocked;
    const selected = !info.server && (info.selected || "") === id;
    option.setAttribute("aria-pressed", String(selected));
    const copy = document.createElement("span");
    copy.textContent = title;
    if (detail || blocked) {
      const subtitle = document.createElement("small");
      subtitle.textContent = blocked ? "Недоступно при привязке приложений" : detail;
      copy.append(subtitle);
    }
    option.append(copy);
    if (selected || id && info.active === id) {
      const status = document.createElement("span");
      status.className = "profile-choice-status";
      status.textContent = id && info.active === id ? "Активен" : "Выбран";
      option.append(status);
    }
    option.onclick = () => selectRoute(id);
    return option;
  }
  const scene = document.querySelector(".scene");
  let spinning = null, coastFrame=0;
  function stopCoasting(){cancelAnimationFrame(coastFrame);coastFrame=0;}
  function coast(vx,vy){
    if(info.still || matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    let last=performance.now();
    const step=now=>{
      const dt=Math.min(32,now-last);last=now;
      if(document.hidden || Math.hypot(vx,vy)<.00004)return;
      globe.rotate(vx*dt,vy*dt);
      const decay=Math.exp(-dt/135);vx*=decay;vy*=decay;
      coastFrame=requestAnimationFrame(step);
    };
    coastFrame=requestAnimationFrame(step);
  }
  const fingers=new Map();
  let pinch=null, zoomGesture=false, swallow=false;
  const spacing=()=>{const [a,b]=[...fingers.values()];return Math.hypot(a.x-b.x,a.y-b.y)};
  scene.addEventListener("pointerdown", event => {
    if(event.button!==0 || event.target.closest(".planet-pin"))return;
    swallow=false;
    fingers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(fingers.size===2 && globe){
      stopCoasting();spinning=null;zoomGesture=true;swallow=true;
      pinch={distance:Math.max(1,spacing()),zoom:globe.getZoom()};
      for(const id of fingers.keys())scene.setPointerCapture(id);
      return;
    }
    if (spinning || !event.isPrimary || zoomGesture) return;
    stopCoasting();
    spinning = {last:event.timeStamp,px:event.clientX,py:event.clientY,vx:0,vy:0,id:event.pointerId, x:event.clientX, y:event.clientY, drag:null};

  });
  scene.addEventListener("pointermove", event => {
    if(fingers.has(event.pointerId))fingers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pinch && fingers.size===2){globe.setZoom(pinch.zoom*spacing()/pinch.distance);return}
    if (!spinning || event.pointerId !== spinning.id) return;
    const {left,top,width,height}=scene.getBoundingClientRect();
    if (!width || !height) return;
    if (!spinning.drag) {
      const dx=event.clientX-spinning.x, dy=event.clientY-spinning.y;
      if (Math.hypot(dx,dy)<8) return;
      swallow=true;scene.setPointerCapture(event.pointerId);
      if (!globe) return;
      spinning.drag=globe.beginDrag((spinning.x-left)/width,(spinning.y-top)/height);
      scene.classList.add("spinning");
    }
    const dt=Math.max(8,event.timeStamp-spinning.last);
    spinning.vx=Math.max(-.0015,Math.min(.0015,(event.clientX-spinning.px)/width/dt));
    spinning.vy=Math.max(-.0015,Math.min(.0015,(event.clientY-spinning.py)/height/dt));
    spinning.px=event.clientX;spinning.py=event.clientY;spinning.last=event.timeStamp;
    spinning.drag((event.clientX-left)/width,(event.clientY-top)/height);
  });
  for (const event of ["pointerup","pointercancel","lostpointercapture"]) {
    scene.addEventListener(event, e => {
      if(event==="lostpointercapture" && e.target!==scene)return;
      fingers.delete(e.pointerId);pinch=null;
      if(!fingers.size)zoomGesture=false;
      if (!spinning || spinning.id !== e.pointerId) return;
      if(event==="pointerup" && spinning.drag && e.timeStamp-spinning.last<80)coast(spinning.vx,spinning.vy);
      spinning=null;
      scene.classList.remove("spinning");
    });
  }
  scene.addEventListener("click",e=>{if(swallow && !e.target.closest(".planet-pin") && e.detail!==0)e.stopImmediatePropagation();swallow=false},true);
  scene.addEventListener("click",e=>{
    if(e.detail===0 || e.target.closest("button") || !globe)return;
    const box=scene.getBoundingClientRect();
    globe.surfaceTap((e.clientX-box.left)/box.width,(e.clientY-box.top)/box.height);
  });
  scene.addEventListener("wheel",e=>{if(!globe)return;e.preventDefault();stopCoasting();globe.setZoom(globe.getZoom()*Math.exp(-e.deltaY*.002));},{passive:false});
  scene.addEventListener("keydown", event => {
    if (event.target.id !== "globe-map") return;
    if(["+","=","-"].includes(event.key)){event.preventDefault();globe.setZoom(globe.getZoom()*(event.key==="-"?.8:1.25));return}
    const axes={ArrowLeft:[-.08,0],ArrowRight:[.08,0],ArrowUp:[0,-.08],ArrowDown:[0,.08]};
    if (!axes[event.key]) return;
    event.preventDefault();
    globe?.rotate(...axes[event.key]);
  });
  function panel(tab) {
    stopCamera();
    addPanel = tab;dialog.classList.toggle("add-menu",tab==="options");
    if(tab==="link"){
      const saved=$("saved-sources");saved.replaceChildren();const seen=new Set();
      for(const p of info.catalog||[]){
        if(!p.subscriptionID||seen.has(p.subscriptionID))continue;seen.add(p.subscriptionID);
        const b=document.createElement("button");b.type="button";b.className="choice";b.textContent="Обновить · "+p.subscriptionName;
        b.onclick=()=>subscribe({id:p.subscriptionID});saved.append(b);
      }
    }
    if(tab==="copy-json"){
      const select=$("copy-profile");select.replaceChildren();
      for(const p of orderedProfiles().filter(p=>!p.hidden && !["naive","trusttunnel","mieru","amneziawg"].includes(p.kind))){
        select.add(new Option([p.name||p.id,profileDescription(p)].filter(Boolean).join(" · "),p.id));
      }
      const preferred=info.selected||info.active;
      if([...select.options].some(o=>o.value===preferred))select.value=preferred;
      $("copy-json").querySelector("button").disabled=!select.length;
    }
    qrEpoch++; qrValue = "";
    $("qr-file").value = ""; $("qr").querySelector(".save").disabled = true;
    $("feedback").textContent = "";
    $("options").hidden = tab !== "options"; $("back").hidden = tab === "options";
    for (const id of forms) $(id).hidden = tab !== id;
    $("tools-title").textContent = ({activation:"Код доступа",link:"Добавить подписку",qr:"QR-код",manual:"Ручной ввод","copy-json":"Копировать JSON"})[tab] || "Добавить профиль";
    dialog.scrollTop = 0;
    if (dialog.open) $("tools-title").focus();
  }
  const shareBox=$("share-dialog"), shareSelect=$("share-profile"), shareImage=$("share-img");
  let sharedIds=[],shareRevision=0;
  function requestQR(){
    shareImage.hidden=true;shareImage.removeAttribute("src");$("share-image").disabled=true;
    $("share-status").textContent="Создаём QR-код…";
    send("profile-qr", JSON.stringify([String(++shareRevision),shareSelect.value]));
  }
  function openShare(server){
    sharedIds=server.profiles.map(p=>p.id);shareSelect.replaceChildren();
    for(const p of server.profiles.filter(p=>!p.hidden)){
      shareSelect.add(new Option((kinds[p.kind]||p.kind)+" · "+(p.name||p.id),p.id));
    }
    shareBox.showModal();
    if(shareSelect.length)requestQR();else $("share-status").textContent="Экспорт профилей скрыт.";
    $("share-zip").disabled=server.profiles.some(p=>p.hidden);
  }
  window.routeQR=(revision,png,message)=>{
    if(!shareBox.open || revision!==String(shareRevision))return;
    if(png){shareImage.src="data:image/png;base64,"+png;shareImage.hidden=false;$("share-image").disabled=false;}
    $("share-status").textContent=png?"Код содержит данные доступа. Передавайте его доверенному получателю.":message;
  };
  shareSelect.onchange=requestQR;
  $("share-close").onclick=()=>shareBox.close();
  $("share-zip").onclick=()=>send("share",JSON.stringify(sharedIds));
  $("share-image").onclick=()=>send("share-qr-image",shareSelect.value);
  shareBox.onclose=()=>{shareRevision++;sharedIds=[];shareImage.removeAttribute("src");shareImage.hidden=true;$("share-image").disabled=true;};
  window.routeBack = () => {
    if(shareBox.open){shareBox.close();return true;}
    if ($("preferences").open) { $("preferences").close();return true; }
    if ($("remove-dialog").open) { $("remove-dialog").close();return true; }
    if (dialog.open) {
      if (addPanel === "options") dialog.close();
      else panel("options");
      return true;
    }
    return false;
  };
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && window.routeBack()) event.preventDefault();
  });
  function openAdd() { panel("options"); dialog.showModal(); }
  function start() { if (info.count) send("connect"); else openAdd(); }
  $("action").onclick = start;
  $("prince").onclick = () => {
    const top = orderedProfiles().find(canConnect);
    if (top) send("connect-priority", top.id);
    else if (!info.count) openAdd();
  };
  function disconnect() {
    renderMap();
    send("disconnect");
  }
  $("cancel").onclick = disconnect;
  const preferences=$("preferences"),details=$("pref-details");
  const tunnelDefaults={mode:"vpn",mtu:1500,dns:"auto",cache:4096,tcp:0,udp:0,socks:17680,http:0,lan:"off",sniff:"profile",mux:"profile",ip:"profile",fragment:"profile",method:"GET",timeout:6,interval:15,exclude:"none",routes:"",engineDNS:"profile"};
  function displayTunnel(values){
    for(const key of Object.keys(tunnelDefaults)){
      const control=$("tun-"+key);
      if(key==="dns"){
        if(document.activeElement===$("tun-custom"))continue;
        const custom=![...control.options].some(o=>o.value===values.dns);
        control.value=custom?"custom":values.dns;
        $("tun-custom-row").hidden=!custom;
        $("tun-custom").value=custom?values.dns:"";
        continue;
      }
      if(control!==document.activeElement || control.tagName!=="INPUT")control.value=String(values[key]);
    }
  }
  function saveTunnel(values){
    info.tunnelOptions=values;
    displayTunnel(values);
    send("tunnel-options",JSON.stringify(values));
  }
  $("pref-tunnel").onchange=()=>{
    const values={};
    for(const [key,fallback] of Object.entries(tunnelDefaults)){
      const selected=$("tun-"+key).value;
      values[key]=typeof fallback==="number"?Number(selected):selected;
    }
    if(values.dns==="custom"){
      $("tun-custom-row").hidden=false;
      const field=$("tun-custom"),host=field.value.trim();
      if(!host){field.focus();return}
      let numeric=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host.split(".").every(n=>Number(n)<=255);
      if(host.includes(":")){try{numeric=/^[0-9a-f:.]+$/i.test(host)&&new URL("http://["+host+"]/").hostname.startsWith("[")}catch{numeric=false}}
      field.setCustomValidity(numeric?"":"Введите IP-адрес DNS-сервера");
      if(!numeric){field.reportValidity();return}
      values.dns=host;
    }
    const routes=values.routes.trim()?values.routes.trim().split(/[,\s]+/):[];
    const valid=routes.length<=32 && routes.every(cidr=>{
      const [host,bits,...rest]=cidr.split("/");
      if(rest.length || !/^\d{1,3}$/.test(bits)||Number(bits)<1)return false;
      if(host.includes(":")){try{return !host.includes("%") && new URL("http://["+host+"]/").hostname.startsWith("[") && Number(bits)<=128}catch{return false}}
      return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host.split(".").every(n=>Number(n)<=255)&&Number(bits)<=32;
    });
    $("tun-routes").setCustomValidity(valid?"":"Проверьте адрес сети и длину префикса");
    if(!valid){$("tun-routes").reportValidity();return}
    saveTunnel(values);
  };
  $("tun-reset").onclick=()=>{
    $("tun-custom").setCustomValidity("");$("tun-routes").setCustomValidity("");$("tun-routes").value="";
    saveTunnel({...tunnelDefaults});
  };
  function refreshPreferences(){
    $("pref-tunnel").hidden=false;
    document.querySelectorAll(".android-tun").forEach(group=>group.hidden=info.platform!=="android");
    $("tun-address").textContent=info.sharedAddress?"SOCKS5 · "+info.sharedAddress:"";
    $("tun-exclusions").hidden=!info.canExclude;
    displayTunnel({...tunnelDefaults,...info.tunnelOptions});
    $("language-row").hidden=info.platform!=="macos";
    $("pref-language").value=info.language||"system";
    $("pref-motion").checked=!info.still;
    $("pref-system").hidden=info.platform!=="android";
    $("pref-system").closest("section").hidden=info.platform!=="android";
    $("pref-protection").hidden=info.platform!=="android";
    $("pref-update").disabled=!!info.checking;
    $("pref-update").querySelector("span").textContent=info.checking?"Проверяем…":"Проверить обновления";
    $("pref-version").textContent=info.version||"";
    if(details.open){
      const active=(info.catalog||[]).find(p=>p.id===info.active);
      const lines=[info.status,active && profileDescription(active)];
      if(info.platform==="android")lines.push(info.diagnostics);
      if(info.platform==="macos" && ["connected","travel"].includes(info.phase))lines.push("SOCKS5 · 127.0.0.1:"+(info.activeSocks||17680));
      const text=lines.filter(Boolean).join("\n");
      if($("pref-info").textContent!==text)$("pref-info").textContent=text;
    }
  }
  $("fox").onclick=()=>{
    refreshPreferences();
    preferences.showModal();
    window.RouteMotion.settings(true);
  };
  $("pref-language").onchange=e=>send("language",e.target.value);
  window.routeOpenLanguageSettings=()=>{
    if(!preferences.open)$("fox").click();
    $("pref-language").focus();
  };
  $("pref-close").onclick=()=>preferences.close();
  preferences.onclose=()=>{
    details.open=false;
    $("pref-tunnel").open=false;
    window.RouteMotion.settings(false);
    if(!dialog.open)$("fox").focus({preventScroll:true});
  };
  details.ontoggle=()=>{
    if(info.platform==="android")send("diagnostics",String(details.open && preferences.open));
    refreshPreferences();
  };
  $("pref-system").onclick=()=>send("system-vpn");
  $("pref-motion").onchange=e=>{
    info.still=!e.target.checked;
    document.documentElement.classList.toggle("still",info.still);
    window.RouteMotion.show("home",info.still);
    send("motion",String(info.still));
  };
  $("pref-archive").onclick=()=>{preferences.close();send("zip")};
  $("pref-code").onclick=()=>{
    preferences.close();
    panel("activation");dialog.showModal();$("access-digits").focus();
    if(info.phase!=="home")$("feedback").textContent="Для замены профилей отключите VPN.";
  };
  $("pref-update").onclick=()=>send("update");
  $("pref-protection").onclick=()=>send("protection");
  dialog.addEventListener("click",e=>{
    if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();
  });
  $("add").onclick = openAdd;
  $("close").onclick = () => dialog.close();
  $("back").onclick = () => panel("options");
  for (const button of dialog.querySelectorAll("[data-panel]")) button.onclick = () => panel(button.dataset.panel);
  $("paste-link").onclick=()=>send("paste-link");
  $("paste-json").onclick=()=>send("paste-json");
  $("copy-json").onsubmit=e=>{e.preventDefault();send("copy-json",$("copy-profile").value)};
  window.routePaste=(value,jsonOnly)=>{
    const text=value.trim();
    if(jsonOnly && !/^[{\[]/.test(text)){ $("feedback").textContent="В буфере нет JSON-конфигурации.";return; }
    add(text);
  };
  $("activation").onsubmit=e=>{
    e.preventDefault();
    if(importing || info.busy || info.phase!=="home"){$("feedback").textContent="Сначала завершите подключение или импорт.";return}
    importing=true;
    $("feedback").textContent="Получаем профили…";
    send("activate",$("access-digits").value);
  };
  dialog.addEventListener("close", () => {
    if(dialog.open)return;
    stopCamera(); qrEpoch++; qrValue = ""; for (const id of forms) $(id).reset(); manualFields();
  });
  function add(value) {
    if (importing) return;
    if (/^happ:\/\/crypt[0-9]*\//i.test(value)){send("encrypted-subscription",value);return;}
    if (info.busy) { $("feedback").textContent="Дождитесь окончания импорта.";return; }
    if (!value || value.length>1048576){$("feedback").textContent="Нужен профиль размером до 1 МБ.";return;}
    importing = true; $("feedback").textContent = "Добавляем профиль…"; send("import", value);
  }
  window.routeImportResult = (ok,message) => {
    importing = false;
    if (ok && dialog.open) dialog.close();
    (dialog.open ? $("feedback") : $("notice")).textContent = message;
  };
  function subscribe(source){if(importing||info.busy)return;importing=true;$("feedback").textContent="Загружаем подписку…";send("subscribe",JSON.stringify(source));}
  $("link").onsubmit=e=>{e.preventDefault();const value=$("link").elements.value.value.trim();
    if(!/^(?:https?:\/\/|happ:\/\/(?:crypt[0-9]*|add)\/)/i.test(value)){ $("feedback").textContent="Введите адрес подписки.";return; }if(/^happ:\/\/crypt/i.test(value)){add(value);return;}subscribe({url:value,name:$("link").elements.title.value.trim(),hidden:$("link").elements.hide.checked,allowInsecure:$("link").elements.insecure.checked,sendCookie:$("link").elements.cookie.checked});};
  const fields = $("manual").elements;
  const inputs=$("manual-fields");
  function control(key,label,options,initial=""){
    const wrap=document.createElement("label");wrap.className="field";wrap.textContent=label;
    const node=document.createElement(options?"select":"input");node.name=key;
    if(options)for(const option of options)node.add(new Option(option,option));
    else {node.autocomplete="off";node.spellcheck=false;}
    if(["host","port","uuid","privateKey","peerKey","local"].includes(key) || (key==="pass" && fields.protocol.value!=="Socks"))node.required=true;
    if(initial)node.value=initial;
    wrap.append(node);inputs.append(wrap);
  }
  function manualFields(){
    const p=fields.protocol.value;
    inputs.replaceChildren();fields.raw.value="";$("manual-advanced").open=p==="Custom";
    inputs.hidden=p==="Custom";
    if(p==="Custom")return;
    control("host","Адрес сервера");control("port","Порт",null,p==="Socks"?"1080":"443");
    fields.port.type="number";fields.port.min=1;fields.port.max=65535;
    if(["VMess","VLESS"].includes(p))control("uuid","UUID");
    if(p==="VLESS")control("flow","Поток",["","xtls-rprx-vision"]);
    if(["Trojan","Shadowsocks","Socks","Hysteria"].includes(p)){
      if(p==="Socks")control("user","Имя пользователя");
      if(p==="Shadowsocks")control("method","Шифр",["aes-256-gcm","aes-128-gcm","chacha20-ietf-poly1305","2022-blake3-aes-128-gcm","2022-blake3-aes-256-gcm","2022-blake3-chacha20-poly1305"]);
      control("pass","Пароль");fields.pass.type="password";
    }
    if(p==="WireGuard"){
      control("privateKey","Закрытый ключ");fields.privateKey.type="password";
      control("peerKey","Открытый ключ узла");control("local","Адрес интерфейса (CIDR)");return;
    }
    if(["VMess","VLESS","Trojan","Shadowsocks"].includes(p)){
      control("network","Транспорт",["tcp","ws","grpc","xhttp","httpupgrade","kcp"]);
      control("path","Путь / имя службы");
      control("security","Защита",["none","tls","reality"],p==="Trojan"?"tls":"none");
    }
    if(p!=="Socks"){control("sni","Имя сервера (SNI)");}
    if(fields.security){
      control("key","Открытый ключ REALITY");control("sid","Short ID");
      const visibility=()=>{for(const n of [fields.key,fields.sid])n.parentNode.hidden=fields.security.value!=="reality"};
      fields.security.onchange=visibility;visibility();
    }
  }
  function manualOutbound(){
    const v=k=>fields[k]?.value.trim()||"",p=v("protocol"),host=v("host"),port=Number(v("port"));
    const server={address:host,port};
    let settings,protocol=p.toLowerCase(),streamSettings;
    if(p==="Custom")return {outbounds:[]};
    if(p==="WireGuard"){
      settings={secretKey:v("privateKey"),address:v("local").split(",").map(a=>a.trim()),peers:[{publicKey:v("peerKey"),endpoint:(host.includes(":")&&!host.startsWith("[")?"["+host+"]":host)+":"+port}]};
    }else if(p==="Hysteria"){
      protocol="hysteria";settings={version:2,address:host,port};
      streamSettings={network:"hysteria",security:"tls",tlsSettings:{serverName:v("sni")||host},hysteriaSettings:{version:2,auth:v("pass")}};
    }else{
      if(p==="VMess"||p==="VLESS"){
        const user=p==="VMess"?{id:v("uuid"),security:"auto"}:{id:v("uuid"),encryption:"none",flow:v("flow")};
        settings={vnext:[{...server,users:[user]}]};
      }else{
        if(p==="Socks" && v("user"))server.users=[{user:v("user"),pass:v("pass")}];
        if(p==="Trojan"||p==="Shadowsocks")server.password=v("pass");
        if(p==="Shadowsocks")server.method=v("method");settings={servers:[server]};
      }
      if(fields.network){
        const net=v("network"),security=v("security");streamSettings={network:net,security};
        if(security==="tls")streamSettings.tlsSettings={serverName:v("sni")||host};
        if(security==="reality")streamSettings.realitySettings={serverName:v("sni"),fingerprint:"chrome",publicKey:v("key"),shortId:v("sid")};
        if(["xhttp","ws","httpupgrade"].includes(net))streamSettings[net+"Settings"]={path:v("path")||"/"};
        if(net==="grpc")streamSettings.grpcSettings={serviceName:v("path")};
      }
    }
    return {remarks:v("label"),outbounds:[{protocol,settings,streamSettings}]};
  }
  fields.raw.oninput=()=>{fields.raw.dataset.generated="false"};
  fields.protocol.onchange=manualFields;manualFields();
  $("manual-advanced").ontoggle=()=>{
    if($("manual-advanced").open && (!fields.raw.value || fields.protocol.value!=="Custom" && fields.raw.dataset.generated==="true")){
      fields.raw.value=JSON.stringify(manualOutbound(),null,2);fields.raw.dataset.generated="true";
    }
    inputs.hidden=$("manual-advanced").open;
    for(const input of inputs.querySelectorAll("input,select"))input.disabled=inputs.hidden;
  };
  $("manual").onsubmit=e=>{
    e.preventDefault();
    try{
      const config=$("manual-advanced").open?JSON.parse(fields.raw.value):manualOutbound();
      if(fields.label.value.trim())config.remarks=fields.label.value.trim();
      add(JSON.stringify(config));
    }catch{ $("feedback").textContent="Проверьте синтаксис JSON."; }
  };
  let cameraStream=null,frameTimer;
  function stopCamera(){
    clearTimeout(frameTimer);
    cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;
    const video=$("qr-camera");video.srcObject=null;video.hidden=true;
  }
  $("camera-start").onclick=async()=>{
    $("feedback").textContent="Открываем камеру…";
    stopCamera();const ticket=++qrEpoch,video=$("qr-camera");
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:960}},audio:false});
      if(ticket!==qrEpoch||!dialog.open){stream.getTracks().forEach(t=>t.stop());return;}
      cameraStream=stream;video.srcObject=stream;video.hidden=false;await video.play();$("feedback").textContent="Наведите камеру на QR-код.";
      const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});
      const scan=()=>{
        if(ticket!==qrEpoch||!cameraStream)return;
        if(video.videoWidth){
          canvas.width=Math.min(800,video.videoWidth);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);
          ctx.drawImage(video,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
          const decoded=window.jsQR(pixels.data,pixels.width,pixels.height);
          if(decoded){qrValue=decoded.data.trim();stopCamera();$("qr").querySelector(".save").disabled=!qrValue;$("feedback").textContent="QR-код распознан.";return;}
        }
        frameTimer=setTimeout(scan,200);
      };scan();
    }catch{if(ticket===qrEpoch){stopCamera();$("feedback").textContent="Камера недоступна. Разрешите доступ или выберите изображение.";}}
  };
  $("qr-file").onchange = async e => {
    stopCamera();
    const ticket = ++qrEpoch;
    const file = e.target.files[0]; qrValue="";
    $("qr").querySelector(".save").disabled=true;
    if (!file) return;
    if (file.size > 16*1024*1024) { $("feedback").textContent="Выберите изображение меньше 16 МБ.";return; }
    const url=URL.createObjectURL(file);
    try {
      const image=new Image(); image.src=url; await image.decode();
      if (ticket !== qrEpoch) return;
      const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.round(image.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext("2d",{willReadFrequently:true}); ctx.fillStyle="white"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
      qrValue=window.jsQR(pixels.data,pixels.width,pixels.height)?.data?.trim() || "";
      if (!qrValue) throw Error();
      $("qr").querySelector(".save").disabled=false;
      $("feedback").textContent="Ссылка распознана.";
    } catch { if(ticket===qrEpoch)$("feedback").textContent="Профиль в QR-коде не распознан."; }
    finally { URL.revokeObjectURL(url); }
  };
  $("qr").onsubmit = e => { e.preventDefault(); add(qrValue); };
  // Passport: a stamp for every city reached through its server, plus days on the road and meteors thrown.
  const stampLook = {
    sofia:{flag:"🇧🇬", country:"Болгария", color:"#e8483b", tilt:-6},
    zurich:{flag:"🇨🇭", country:"Швейцария", color:"#d62828", tilt:5},
    chisinau:{flag:"🇲🇩", country:"Молдова", color:"#2f6fd6", tilt:-3},
    vilnius:{flag:"🇱🇹", country:"Литва", color:"#2f9e44", tilt:7},
  };
  const passKey = "route.passport";
  let passport = {stamps:{}, days:[], meteors:0};
  try { passport = {...passport, ...JSON.parse(localStorage.getItem(passKey) || "{}")}; } catch {}
  let freshStamp = "";
  function savePassport() { try { localStorage.setItem(passKey, JSON.stringify(passport)); } catch {} }
  function connectedPlace() {
    const ids = [].concat(info.active || [], info.route || []);
    const live = (info.catalog || []).find(profile => ids.includes(profile.id));
    if (live && stampLook[live.location]) return live.location;
    const pinned = info.server && groupedServers(orderedProfiles()).find(item => item.endpoint === info.server || item.profiles.some(profile => profile.id === info.server));
    return pinned && stampLook[pinned.place] ? pinned.place : "";
  }
  function passportVisit() {
    const today = new Date().toISOString().slice(0, 10);
    let changed = false;
    if (!passport.days.includes(today)) { passport.days = passport.days.concat(today).slice(-400); changed = true; }
    const place = connectedPlace();
    if (place && !passport.stamps[place]) {
      passport.stamps[place] = today; changed = true; freshStamp = place;
      const look = stampLook[place], pop = document.createElement("div");
      pop.className = "stamp-pop"; pop.style.setProperty("--c", look.color); pop.setAttribute("role", "status");
      const icon = document.createElement("i"); icon.textContent = look.flag;
      const city = document.createElement("b"); city.textContent = locations[place];
      pop.append(icon, "Новый штамп", document.createElement("br"), city);
      document.body.append(pop); setTimeout(() => pop.remove(), 2600);
      window.RouteSound?.play("stamp"); setTimeout(() => window.RouteSound?.play("chime"), 380);
      $("pass-chip").classList.remove("bump"); void $("pass-chip").offsetWidth; $("pass-chip").classList.add("bump");
    }
    if (changed) { savePassport(); renderPassport(); }
  }
  function renderPassport() {
    const got = Object.keys(stampLook).filter(place => passport.stamps[place]);
    $("pass-count").textContent = got.length + " / " + Object.keys(stampLook).length;
    $("pass-stamps").textContent = String(got.length);
    $("pass-days").textContent = String(passport.days.length);
    $("pass-meteors").textContent = String(passport.meteors);
    const lang = document.documentElement.lang || "ru";
    $("stamps").replaceChildren(...Object.entries(stampLook).map(([place, look]) => {
      const card = document.createElement("div"), icon = document.createElement("i"), name = document.createElement("span"), note = document.createElement("small");
      const date = passport.stamps[place];
      card.className = "stamp" + (date ? " got" : "") + (place === freshStamp ? " fresh" : "");
      card.style.setProperty("--c", look.color); card.style.setProperty("--r", look.tilt + "deg");
      icon.textContent = date ? look.flag : "🔒";
      name.textContent = date ? locations[place] : look.country;
      note.textContent = date ? new Date(date + "T12:00:00").toLocaleDateString(lang, {day:"numeric", month:"short"}) : "Ещё не были";
      card.append(icon, name, note);
      return card;
    }));
    freshStamp = "";
  }
  addEventListener("route-toy", event => {
    if (event.detail === "meteor") { passport.meteors++; savePassport(); renderPassport(); }
  });
  $("pass-chip").onclick = () => { renderPassport(); $("passport").showModal(); window.RouteSound?.play("pop"); };
  $("passport-close").onclick = () => $("passport").close();
  $("passport").onclose = () => $("pass-chip").focus({preventScroll:true});
  renderPassport();

  // Hero picker: who stands on the focused city (3D scene only).
  function applyHero(pop) {
    const scene = window.RouteGlobe3D?.active;
    $("hero-chip").hidden = !scene?.setHero;
    $("hero-chip-img").src = "art/hero_" + hero + ".webp";
    if (!scene?.setHero || (!pop && scene.getHero() === hero)) return;
    scene.setHero(hero);
  }
  function renderHeroes() {
    $("hero-grid").replaceChildren(...heroes.map(([id, name]) => {
      const card = document.createElement("button");
      card.type = "button"; card.className = "hero-card"; card.dataset.hero = id;
      card.setAttribute("role", "radio"); card.setAttribute("aria-checked", String(id === hero));
      const img = document.createElement("img"); img.src = "art/hero_" + id + ".webp"; img.alt = "";
      const label = document.createElement("span"); label.textContent = name;
      card.append(img, label);
      card.onclick = () => {
        const changed = id !== hero;
        hero = id;
        try { localStorage.setItem(heroKey, id); } catch {}
        renderHeroes(); applyHero(changed); renderPriority();
        if (changed) { const chip = $("hero-chip"); chip.classList.remove("fired"); void chip.offsetWidth; chip.classList.add("fired"); setTimeout(() => chip.classList.remove("fired"), 700); }
        setTimeout(() => $("heroes").close(), changed ? 260 : 0);
      };
      return card;
    }));
  }
  $("hero-chip").onclick = () => { renderHeroes(); $("heroes").showModal(); window.RouteSound?.play("pop"); };
  $("heroes-close").onclick = () => $("heroes").close();
  $("heroes").onclose = () => $("hero-chip").focus({preventScroll:true});
  applyHero();

  // Toys bar: physical gags on the 3D planet.
  for (const button of document.querySelectorAll("#toys .toy")) {
    button.onclick = () => {
      const scene = window.RouteGlobe3D?.active;
      if (!scene || !scene.toy(button.dataset.toy)) return;
      button.classList.remove("fired"); void button.offsetWidth; button.classList.add("fired");
      setTimeout(() => button.classList.remove("fired"), 700);
    };
  }
  $("sound-row").hidden = !window.RouteSound;
  $("fox").addEventListener("click", () => { if (window.RouteSound) $("pref-sound").checked = window.RouteSound.enabled; });
  $("pref-sound").onchange = e => { window.RouteSound?.setEnabled(e.target.checked); if (e.target.checked) window.RouteSound?.play("chime"); };

  show("home"); send("ready");
})();
