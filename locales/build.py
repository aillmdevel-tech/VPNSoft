"""Build localized WebView pages and native string tables from the same catalog."""
import html
import json
import re
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
assets = Path(sys.argv[1])
native = Path(sys.argv[2]) if len(sys.argv) > 2 else None
source = here.parent / "android/assets/journey"
cyrillic = re.compile("[А-Яа-яЁё]")
literal = re.compile(r'"(?:\\.|[^"\\\n])*"')


def translate_page(page, strings, lang):
    def text(match):
        value = match[1]
        key = html.unescape(value.strip())
        if not cyrillic.search(key):
            return match[0]
        return ">" + value.replace(value.strip(), html.escape(strings[key])) + "<"

    page = re.sub(r">([^<>]+)<", text, page)
    def attr(match):
        name, value = match.groups()
        return name + '="' + html.escape(strings.get(value, value), quote=True) + '"'
    page = re.sub(r'(alt|aria-label|placeholder|title)="([^"]*)"', attr, page)
    return (page.replace('lang="ru"', f'lang="{lang}"')
                .replace('src="journey.js"', f'src="journey-{lang}.js"')
                .replace('src="globe.js"', f'src="globe-{lang}.js"'))


for lang in ("en", "es"):
    strings = json.loads((here / f"{lang}.json").read_text())
    (assets / f"index-{lang}.html").write_text(translate_page((source/"index.html").read_text(), strings, lang))
    for stem in ("journey", "globe"):
        def localize(match):
            if not cyrillic.search(match[0]):
                return match[0]
            return json.dumps(strings[json.loads(match[0])], ensure_ascii=False)
        js = literal.sub(localize, (source / f"{stem}.js").read_text())
        js = js.replace('new Intl.PluralRules("ru")', f'new Intl.PluralRules("{lang}")')
        (assets / f"{stem}-{lang}.js").write_text(js)
    if native is None:
        (assets / f"strings-{lang}.json").write_text(json.dumps(strings, ensure_ascii=False))
    else:
        folder = native / f"{lang}.lproj"
        folder.mkdir(exist_ok=True)
        def table(data):
            return "".join(f"{json.dumps(k,ensure_ascii=False)} = {json.dumps(v,ensure_ascii=False)};\n" for k,v in data.items())
        (folder / "Localizable.strings").write_text(table(strings))
        (folder / "InfoPlist.strings").write_text(table({
            "CFBundleDisplayName": strings["Маршрут"], "CFBundleName": strings["Маршрут"],
            "NSCameraUsageDescription": strings["Сканирование QR-кода профиля"],
        }))
if native is not None:
    (native/"ru.lproj").mkdir(exist_ok=True)
    (native/"ru.lproj"/"Localizable.strings").write_text("/* Russian strings are the source keys. */\n")
    (native/"ru.lproj"/"InfoPlist.strings").write_text('"CFBundleDisplayName" = "Маршрут";\n"CFBundleName" = "Маршрут";\n"NSCameraUsageDescription" = "Сканирование QR-кода профиля";\n')
