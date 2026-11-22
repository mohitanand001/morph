#!/usr/bin/env python3
"""Format Bridge accessibility probe (read-only, prints to your terminal only).

Shows what the window in front exposes through Linux accessibility (AT-SPI):
the browser address bar, the page address, Slack/Jira/Confluence links, and
headings. Nothing is saved or sent anywhere.

  python3 tools/a11y-probe.py          # 5 s to switch to the window
  python3 tools/a11y-probe.py 8        # 8 s
"""
import re
import subprocess
import sys
import time

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as e:  # noqa: BLE001
    print('The accessibility library for Python is missing:', e)
    print('Install it with:  sudo apt install gir1.2-atspi-2.0 python3-gi')
    sys.exit(1)

DELAY = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 5
INTERESTING = re.compile(r'slack\.com/(archives|client)/|atlassian\.net/(browse|wiki)/|/browse/[A-Z][A-Z0-9_]+-\d+|docs\.google\.com/', re.I)
MAX_NODES = 40000
MAX_SECONDS = 8


def gsetting(schema, key):
    try:
        return subprocess.run(['gsettings', 'get', schema, key], capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception:  # noqa: BLE001
        return '?'


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def text_of(node):
    t = safe(lambda: node.get_text_iface())
    if t is None:
        return ''
    n = safe(lambda: Atspi.Text.get_character_count(node), 0) or 0
    return safe(lambda: Atspi.Text.get_text(node, 0, min(n, 2000)), '') or ''


def link_uri(node):
    h = safe(lambda: node.get_hyperlink())
    if h is None:
        return ''
    return safe(lambda: h.get_uri(0), '') or ''


def doc_url(node):
    for key in ('DocURL', 'URI', 'url'):
        v = safe(lambda: Atspi.Document.get_document_attribute_value(node, key), '')
        if v:
            return v
    attrs = safe(lambda: node.get_attributes(), {}) or {}
    return attrs.get('url') or attrs.get('URI') or ''


print('Accessibility setting (toolkit-accessibility):', gsetting('org.gnome.desktop.interface', 'toolkit-accessibility'))
print('Switch to the window to check (Slack, or Slack/Jira in Chrome). Reading in', DELAY, 'seconds…')
for i in range(DELAY, 0, -1):
    print(' ', i, end='\r', flush=True)
    time.sleep(1)
print()

desktop = Atspi.get_desktop(0)
active = None
apps = []
for i in range(safe(lambda: desktop.get_child_count(), 0) or 0):
    app = safe(lambda: desktop.get_child_at_index(i))
    if app is None:
        continue
    apps.append(safe(lambda: app.get_name(), '') or '?')
    for j in range(safe(lambda: app.get_child_count(), 0) or 0):
        w = safe(lambda: app.get_child_at_index(j))
        st = safe(lambda: w.get_state_set())
        if st is not None and safe(lambda: st.contains(Atspi.StateType.ACTIVE), False):
            active = (app, w)

print('Apps visible to accessibility:', ', '.join(sorted(set(apps))) or '(none)')
if not active:
    print('\nNo active window found through accessibility.')
    print('The app in front may not expose itself. Try turning accessibility on and restarting that app:')
    print('  gsettings set org.gnome.desktop.interface toolkit-accessibility true')
    sys.exit(0)

app, win = active
print('\nApp:   ', safe(lambda: app.get_name(), '?'))
print('Window:', (safe(lambda: win.get_name(), '') or '')[:120])

seen = 0
start = time.time()
address = []
docs = []
links = []
headings = []
stack = [(win, 0)]
while stack and seen < MAX_NODES and time.time() - start < MAX_SECONDS:
    node, depth = stack.pop()
    seen += 1
    role = safe(lambda: node.get_role_name(), '') or ''
    name = (safe(lambda: node.get_name(), '') or '').strip()
    if role in ('entry', 'text') and re.search(r'address|search bar|url', name, re.I):
        address.append(text_of(node)[:300])
    if role in ('document web', 'document frame'):
        u = doc_url(node)
        if u:
            docs.append(u[:300])
    if role == 'link':
        u = link_uri(node)
        if u and INTERESTING.search(u):
            links.append((name[:60], u[:300]))
    if role == 'heading' and name and len(headings) < 12:
        headings.append(name[:80])
    if depth < 80:
        n = safe(lambda: node.get_child_count(), 0) or 0
        for k in range(min(n, 400) - 1, -1, -1):
            c = safe(lambda: node.get_child_at_index(k))
            if c is not None:
                stack.append((c, depth + 1))

print('Elements read:', seen, '(in %.1f s)' % (time.time() - start))
print('\nAddress bar:', address[:2] or '(not found)')
print('Page address:', docs[:3] or '(not found)')
print('Slack/Jira/Confluence/Docs links (first 10):')
for n, u in links[:10]:
    print('   ', u, ' ←', repr(n))
if not links:
    print('    (none)')
print('Headings (first 12):', headings or '(none)')
if seen < 30:
    print('\nVery little was readable. The app probably needs accessibility switched on:')
    print('  gsettings set org.gnome.desktop.interface toolkit-accessibility true')
    print('then quit and reopen Slack / Chrome, and run this again.')
