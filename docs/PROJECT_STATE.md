# PROJECT_STATE

Актуально на 2026-11-20. Ветка `redesign/journey-3d` (запушена в aillmdevel-tech/VPNSoft). План: docs/plans/2026-11-20-journey-redesign.md.

## Сделано
- 3D-сцена Three.js вместо WebGL1-глобуса: `web/` (Vite + TS, three 0.187, postprocessing 6.39) → IIFE-бандл `android/assets/journey/globe3d.js` (~2 МБ, gzip 463 КБ, модели base64). API `RouteGlobe` сохранён 1:1; без WebGL2 или при ошибке — старый globe.js (`?legacy` для проверки).
- Планета: биомы по рельефу, океан с каустикой/пеной/волнами, атмосфера, ~900 деревьев (instancing), сезонный снег, облака-попкорн, ночные огни, сияния, реальное солнце. Модели из Blender (`art/blender/build_props.py` → props.glb): города-диорамы, 3D Принц (процедурная анимация), Лис (спрайт-лист 16 кадров), самолёт, кораблики, шар, кит, вулкан, метеорит.
- Физические игрушки (панель справа + жесты): метеорит (долгий тап/свайп в небе), гроза → радуга, смерч, снегопад, вулкан, кит, кратеры (двойной тап), всплески, «желе»-пружина, тряска. Звуки синтезируются WebAudio (тумблер в настройках).
- UI: `theme.css` поверх style.css (Nunito, небо день/сумерки/ночь по солнцу, лаймовая 3D-кнопка, кремовые карточки серверов с диорамами, пины с флагами, диалоги).
- Паспорт: штамп за первый коннект через город, дни в пути, метеориты; localStorage. Android `setDomStorageEnabled(true)`, macOS `websiteDataStore = .default()`.
- en/es: новые строки в locales/*.json.
- День/ночь (вечер 2026-11-20): Принц светлее и чуть крупнее (emissive), небесный свет повёрнут к солнцу (ночь тёмно-синяя), день/ночь-множитель в шейдерах суши/океана (`uSunLocal`), огни окон кластерами вокруг городов (~1100, ореол, мерцание), облака без свечения ночью.
- Зум без обрезки: WebGL-холст выходит за квадрат .scene (theme.css «zoom bleed»), камера `setViewOffset`, публичные координаты остаются в системе .scene.
- Герои на точке: Принц, Мишка, Хрюша, Автодом. Сборка `blender -b --factory-startup -P art/blender/build_characters.py` (исходники Alex в art/characters/source, не в git) и `render_heroes.py` для портретов. Кнопка «Герой» → диалог #heroes, выбор в localStorage `route.hero`, API `setHero/getHero`.

## Проверка (2026-11-20)
- Браузер (мок RouteHost) ru/en/es, Playwright 390×844 (`tools/web-preview/capture.cjs`): все игрушки, подключение → штамп, паспорт, настройки, «+», ночь, still-режим, `?legacy`. Ошибок JS нет (404 только favicon в Chrome).
- `go test` (корень и profiletool) — ok. `swiftc -typecheck -parse-as-library` — 1 ошибка в строке 443 (`guard let self` в concurrent-коде), была и до правок.
- Производительность: простой ~30 fps, ~300 draw calls/кадр (статичные модели слиты).
- День/ночь: снимки `build/captures/dn-{day,dusk,night}.png` (подмена Date), повторный capture.cjs — 60 fps, ~156 draw calls/кадр, ошибок нет.
- Герои и зум: Playwright (выбор, перезагрузка, en, подключение), capture.cjs — 60 fps, ~156 draw calls, ошибок нет. Бандл 2.58 МБ / gzip 728 КБ.
- Не проверено: реальное Android-устройство (SDK на Mac нет), сборка macOS-приложения.

## Дальше
- Проверить на телефоне (fps/нагрев), при необходимости слить меши Принца и облака в instancing.
- PR в основную ветку — по команде Alex.
