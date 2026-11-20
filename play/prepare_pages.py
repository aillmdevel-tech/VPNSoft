from pathlib import Path
from html import escape
import sys

assets = Path(sys.argv[1])
policy = Path(__file__).with_name("privacy.html").read_text()
body = policy.split("<main>", 1)[1].split("</main>", 1)[0]
for filename, title, close in (
    ("index.html", "Конфиденциальность", "Закрыть"),
    ("index-en.html", "Privacy policy", "Close"),
    ("index-es.html", "Política de privacidad", "Cerrar"),
):
    page = assets / filename
    source = page.read_text()
    marker = '<button type="button" id="pref-archive"'
    if source.count(marker) != 1: raise ValueError(f"Missing settings row in {filename}")
    button = f'<button type="button" id="privacy-open" class="pref-row">{escape(title)}</button>'
    dialog = ('<dialog id="play-privacy" style="max-width:34rem;max-height:75vh;overflow:auto" lang="ru">'
              f'<form method="dialog"><button autofocus>{escape(close)}</button></form>{body}</dialog>')
    source = source.replace(marker, button + marker).replace("</body>", dialog + '<script src="privacy.js"></script></body>')
    page.write_text(source)
(assets/"privacy.js").write_text('''const privacyDialog = document.getElementById("play-privacy");
document.getElementById("privacy-open").onclick = () => privacyDialog.showModal();
const previousBack = window.routeBack;
window.routeBack = () => {
    if (privacyDialog.open) { privacyDialog.close(); return true; }
    return previousBack();
};
''')
