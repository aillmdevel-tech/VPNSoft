# activeContext (2026-11-20)
- Ветка `redesign/journey-3d`, запушена в aillmdevel-tech/VPNSoft (2026-11-20). Клон привязан к aillmdevel-tech.
- Редизайн сделан целиком (3D-сцена, игрушки/VFX, UI theme.css, паспорт, нативное хранилище) — детали в docs/PROJECT_STATE.md.
- Сборка бандла: `cd web && zsh ../tools/rr.zsh ../build-web.log npm run build` (tsc + vite). Превью: `zsh tools/web-preview/sync.zsh` (сервер 5180 уже крутится через serve.zsh).
- Снимки: `CHROME=<chromium-1248> PLAYWRIGHT="<…/Survive Your Ideas/node_modules/playwright>" node tools/web-preview/capture.cjs http://localhost:5180 build/captures`.
- Отладка: `window.RouteGlobe3D.debug` (scene, planet, toys, decor).
- Следующий шаг: проверка на Android-устройстве, по команде Alex — PR.
- .gitignore: добавлены /art/out/ (Blender-вывод, 6 МБ) и /build-*.log; ART_SPEC.md дополнен отступлениями от стека.
- 2026-11-20 вечер: собран пакет «день/ночь»: Принц светлее (emissive .34, рост .36), небесный свет по солнцу (ночь тёмно-синяя), множитель день/ночь в шейдерах суши/океана (uSunLocal), огни домов кластерами (~1100 точек, мерцание), облака emissive .42. Проверено: tsc+vite, снимки build/captures/dn-{day,dusk,night}.png (подмена Date), полный capture.cjs — 60 fps, ~156 draw calls/кадр, ошибок нет (404 только favicon в превью).
- 2026-11-20 поздний вечер (НЕ закоммичено): (1) зум без обрезки — #globe-map выходит за .scene (CSS bleed: 74px вверх, 150px вниз, по бокам до края экрана, маска-затухание), камера setViewOffset, все u/v по-прежнему в координатах .scene (vp/toCanvas в globe.ts), холст pointer-events:none, жесты ловит .scene. (2) Герои: Принц / Мишка / Хрюша / Автодом. Исходники Alex — art/characters/source (git-ignored) → art/blender/build_characters.py → web/assets/characters.glb (свинья упрощена 27k→4.2k, текстуры 512 JPEG); портреты art/blender/render_heroes.py → journey/art/hero_*.webp. Кнопка «Герой» слева в сцене, диалог #heroes, localStorage route.hero, API RouteGlobe3D.active.setHero/getHero (pop-анимация, конфетти, звук). GLTF-текстуры грузятся через <img> (CSP connect-src 'none' блокирует ImageBitmapLoader). normalize() теперь умножает масштаб корня.
- Проверено: tsc+vite, Playwright — выбор, сохранение после перезагрузки, en, подключение, полный capture.cjs: 60 fps, ~156 draw calls, ошибок нет. Бандл 2.58 МБ (gzip 728 КБ, было 467).
- Лицензии моделей (медведь, свинья, автодом по мотивам Breaking Bad) неизвестны — уточнить у Alex до пуша в публичный репо.

- Герои и зум запушены в redesign/journey-3d (Alex разрешил пуш моделей). Следующий шаг: проверка на Android.
