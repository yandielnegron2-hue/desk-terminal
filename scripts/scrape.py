import re, html, json, urllib.request, datetime
CH = ["PumpPillSignals", "SmugCalls", "bitconggems"]
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read().decode("utf-8", "ignore")
def num(s):
    m = re.match(r"([\d.,]+)\s*([KkMm]?)", s.replace(",", ""))
    if not m: return None
    v = float(m.group(1)); u = m.group(2).lower()
    return v * (1e3 if u == "k" else 1e6 if u == "m" else 1)
calls = []
for ch in CH:
    try: d = get(f"https://t.me/s/{ch}")
    except Exception as e:
        print("fail", ch, e); continue
    for block in d.split('class="tgme_widget_message_wrap')[1:]:
        pm = re.search(r'data-post="([^"]+)"', block)
        tm = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', block, re.S)
        ts = re.search(r'datetime="([^"]+)"', block)
        if not (pm and tm and ts): continue
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<br\s*/?>", " ", re.sub(r"<(?!br)[^>]+>", "", tm.group(1))))).strip()
        sym = re.search(r"\$([^\d\s$·(.,][^\s$·(.,]{0,19})", text)
        ca = re.search(r"\b([1-9A-HJ-NP-Za-km-z]{32,44})\b", text)
        mc = re.search(r"MC ~?\$([\d.,]+\s*[KkMm]?)", text) or re.search(r"\$[^\s$]+ · \$([\d.,]+[KkMm])", text)
        liq = re.search(r"Liq \$([\d.,]+\s*[KkMm]?)", text)
        calls.append({"channel": ch, "time": ts.group(1), "link": "https://t.me/" + pm.group(1),
            "symbol": sym.group(1) if sym else None, "ca": ca.group(1) if ca else None,
            "callMc": num(mc.group(1)) if mc else None, "callLiq": num(liq.group(1)) if liq else None,
            "text": text[:400]})
calls.sort(key=lambda c: c["time"], reverse=True)
old = None
try: old = json.load(open("data/calls.json"))
except Exception: pass
if old and old.get("calls") == calls:
    print("unchanged"); raise SystemExit
json.dump({"scrapedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "calls": calls}, open("data/calls.json", "w"), ensure_ascii=False, indent=1)
print("wrote", len(calls))
