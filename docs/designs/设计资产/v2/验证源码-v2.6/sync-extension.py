"""Refresh the integration script embedded in the current interactive prototype."""
from pathlib import Path

assets = Path(__file__).resolve().parent.parent
prototype = assets / "交互原型.html"
source = (Path(__file__).parent / "integrations-extension.js").read_text()
html = prototype.read_text()
marker = "/* V2.6 integrations extension */\n"
start = html.index(marker) + len(marker)
end = html.index("window.PAtrickPrototype={", start)
updated = html[:start] + source + "\n" + html[end:]
prototype.write_text(updated)
print("Integration script synchronized.")
