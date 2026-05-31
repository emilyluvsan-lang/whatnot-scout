import { useState, useRef, useCallback } from "react";

const SYSTEM_PROMPT = `You are a professional resale pricing expert who helps Whatnot live sellers make fast, accurate buy decisions.

You will receive product photos AND optional seller notes. Use BOTH to identify the item accurately.

PRICING RULES — THIS IS CRITICAL:
- Use ONLY eBay SOLD/COMPLETED listings as your price source (not active listings, not asking prices)
- Find the LAST 30 DAYS of sold comps for the most accurate current market price
- Remove outliers (ignore top 10% and bottom 10% of sales)
- If item has size/color variants, price for the SPECIFIC variant shown
- Account for condition: deduct 20-30% from avg for Poor, 10-15% for Fair, 0-5% for Good, premium for NWT
- fastSellPrice = realistic price to sell within 7 days on eBay (NOT the highest possible price)
- whatnotStartingBid = price that creates bidding competition (low enough to attract multiple bidders)
- NEVER inflate prices to make the seller feel good — accuracy protects their business

DECISION RULES:
- BUY: demandScore 7-10 AND ebayComps.avg >= $15 AND sells regularly
- MAYBE: demandScore 5-6 OR low comp data OR seasonal
- PASS: demandScore 1-4 OR avg < $8 OR market saturated OR hard to sell

Return ONLY valid JSON, no markdown, no explanation:
{
  "itemName": "Full descriptive name: Brand + Type + Model/Style + Size + Color",
  "brand": "Brand name or UNKNOWN",
  "category": "Clothing | Shoes | Bags | Accessories | Jewelry | Other",
  "size": "Size or N/A",
  "color": "Primary color",
  "condition": "New with tags | Like new | Good | Fair | Poor",
  "conditionNotes": "Specific flaws or positives noticed from photos and seller notes",
  "decision": "BUY | PASS | MAYBE",
  "decisionReason": "Specific reason based on actual comps and demand",
  "demandScore": 7,
  "howFastItSells": "Sells in 1-3 days | 1-2 weeks | 1-3 months | Hard to sell",
  "ebayComps": {
    "low": 12,
    "avg": 28,
    "high": 45,
    "recentSalesCount": 8,
    "confidence": "HIGH | MEDIUM | LOW | NO DATA",
    "confidenceReason": "Why this confidence level — e.g. 12 sales in 30 days vs only 2 sales found"
  },
  "priceBreakdown": {
    "msrp": 0,
    "ebayFastSell": 0,
    "ebayMaxList": 0,
    "whatnotStartingBid": 0,
    "whatnotEstimatedSell": 0
  },
  "seoTitle": "Keyword-rich title under 80 chars for eBay/Whatnot",
  "keywords": ["keyword1","keyword2","keyword3","keyword4","keyword5","keyword6","keyword7","keyword8"],
  "whatnotHook": "Punchy 1-sentence live selling hook. Include MSRP if known. Create urgency.",
  "riskFlags": ["specific risk flag if any"],
  "sellerTip": "One practical tip specific to selling THIS item on Whatnot"
}`;

const DC = {
  BUY:   { color: "#00e676", glow: "#00e67640", label: "BUY IT", emoji: "✅" },
  PASS:  { color: "#ff1744", glow: "#ff174440", label: "PASS",   emoji: "❌" },
  MAYBE: { color: "#ffc400", glow: "#ffc40040", label: "MAYBE",  emoji: "🤔" },
};
const CC = { HIGH: "#00e676", MEDIUM: "#ffc400", LOW: "#ff6d00", "NO DATA": "#ff1744" };
const SPEED_COLOR = (s) => s?.includes("1-3 days") ? "#00e676" : s?.includes("1-2 weeks") ? "#ffc400" : "#ff6d00";

function Pill({ children, color = "#333", bg = "#111", border = "#222" }) {
  return <span style={{ background: bg, border: `1px solid ${border}`, color, borderRadius: 20, padding: "3px 10px", fontSize: 11, whiteSpace: "nowrap" }}>{children}</span>;
}

function CopyBtn({ text }) {
  const [c, setC] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 1200); }}
      style={{ background: c ? "#00e67620" : "transparent", border: `1px solid ${c ? "#00e676" : "#2a2a2a"}`, color: c ? "#00e676" : "#444", borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
      {c ? "✓ copied" : "copy"}
    </button>
  );
}

function PriceCard({ label, value, color = "#ccc", sub }) {
  return (
    <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: "12px 10px", textAlign: "center", flex: 1 }}>
      <div style={{ color: "#3a3a3a", fontSize: 9, letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>{label}</div>
      <div style={{ color, fontSize: 19, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: "#3a3a3a", fontSize: 9, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function WhatnotScout() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("ws_key") || "");
  const [images, setImages] = useState([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [savedItems, setSavedItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ws_saved") || "[]"); } catch { return []; }
  });
  const [tab, setTab] = useState("scan"); // scan | list
  const [showKeyInput, setShowKeyInput] = useState(false);
  const fileRef = useRef();

  function saveItems(items) {
    setSavedItems(items);
    localStorage.setItem("ws_saved", JSON.stringify(items));
  }

  function handleFiles(files) {
    const newImgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    setImages(prev => {
      const combined = [...prev, ...newImgs.map(f => ({ file: f, url: URL.createObjectURL(f) }))].slice(0, 10);
      return combined;
    });
  }

  const onDrop = useCallback((e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, []);

  function removeImage(idx) {
    setImages(prev => prev.filter((_, i) => i !== idx));
  }

  async function analyze() {
    if (!apiKey.trim()) { setError("Add your API key first (tap the key icon)"); return; }
    if (images.length === 0) { setError("Add at least one photo first"); return; }
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const imageContents = await Promise.all(images.map(async ({ file }) => {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        return { type: "image", source: { type: "base64", media_type: file.type, data: b64 } };
      }));

      const userMsg = [
        ...imageContents,
        {
          type: "text",
          text: notes.trim()
            ? `Analyze this item. Seller notes: "${notes.trim()}"\n\nReturn only the JSON.`
            : "Analyze this item from all photos. Return only the JSON."
        }
      ];

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-allow-browser": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }]
        })
      });

      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const raw = data.content?.find(b => b.type === "text")?.text || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult({ ...parsed, _imgs: images.map(i => i.url), _names: images.map(i => i.file.name) });
    } catch (e) {
      setError("Something went wrong. Check your API key or try again.\n" + e.message);
    }
    setLoading(false);
  }

  function addToList() {
    if (!result) return;
    const updated = [{ ...result, _id: Date.now() }, ...savedItems];
    saveItems(updated);
    setResult(null);
    setImages([]);
    setNotes("");
    setTab("list");
  }

  function skipItem() {
    setResult(null);
    setImages([]);
    setNotes("");
  }

  function removeItem(id) {
    saveItems(savedItems.filter(i => i._id !== id));
  }

  function downloadCSV() {
    if (!savedItems.length) return;
    const headers = [
      "Photo Files","Item Name","Brand","Category","Size","Color","Condition","Condition Notes",
      "Decision","Decision Reason","Demand Score","How Fast It Sells",
      "eBay Low","eBay Avg","eBay High","Recent Sales Count","Comp Confidence",
      "MSRP","eBay Fast Sell","eBay Max List","Whatnot Starting Bid","Whatnot Est. Sell",
      "SEO Title","Keywords","Whatnot Hook","Risk Flags","Seller Tip"
    ];
    const rows = savedItems.map(i => [
      (i._names||[]).join("|"),
      i.itemName||"", i.brand||"", i.category||"", i.size||"", i.color||"",
      i.condition||"", i.conditionNotes||"",
      i.decision||"", i.decisionReason||"",
      i.demandScore||"", i.howFastItSells||"",
      i.ebayComps?.low ? `$${i.ebayComps.low}` : "",
      i.ebayComps?.avg ? `$${i.ebayComps.avg}` : "",
      i.ebayComps?.high ? `$${i.ebayComps.high}` : "",
      i.ebayComps?.recentSalesCount||"",
      i.ebayComps?.confidence||"",
      i.priceBreakdown?.msrp ? `$${i.priceBreakdown.msrp}` : "",
      i.priceBreakdown?.ebayFastSell ? `$${i.priceBreakdown.ebayFastSell}` : "",
      i.priceBreakdown?.ebayMaxList ? `$${i.priceBreakdown.ebayMaxList}` : "",
      i.priceBreakdown?.whatnotStartingBid ? `$${i.priceBreakdown.whatnotStartingBid}` : "",
      i.priceBreakdown?.whatnotEstimatedSell ? `$${i.priceBreakdown.whatnotEstimatedSell}` : "",
      i.seoTitle||"",
      (i.keywords||[]).join(", "),
      i.whatnotHook||"",
      (i.riskFlags||[]).join(", "),
      i.sellerTip||""
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
      download: `whatnot-haul-${new Date().toISOString().slice(0,10)}.csv`
    });
    a.click();
  }

  const res = result;
  const dc = res ? (DC[res.decision] || DC.MAYBE) : null;

  return (
    <div style={{ minHeight:"100vh", background:"#060606", color:"#e0e0e0", fontFamily:"'DM Mono','Courier New',monospace", maxWidth: 480, margin:"0 auto" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Bebas+Neue&display=swap');
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        body{margin:0;background:#060606}
        textarea{resize:none}
        .fade{animation:fadeUp .35s ease}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .spin{animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#222}
        input[type=file]{display:none}
      `}</style>

      {/* HEADER */}
      <div style={{ background:"#060606", borderBottom:"1px solid #141414", padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:200 }}>
        <div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:3, color:"#fff", lineHeight:1 }}>WHATNOT SCOUT</div>
          <div style={{ fontSize:8, color:"#333", letterSpacing:2 }}>RESALE RESEARCH TOOL</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* key icon */}
          <button onClick={() => setShowKeyInput(s=>!s)} style={{ background: apiKey ? "#00e67615" : "#1a0a0a", border:`1px solid ${apiKey?"#00e67640":"#ff174440"}`, borderRadius:8, padding:"7px 10px", cursor:"pointer", fontSize:14, color: apiKey?"#00e676":"#ff1744" }} title="API Key">🔑</button>
          {/* tabs */}
          {["scan","list"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ background: tab===t ? (t==="list"?"#00e676":"#fff") : "transparent", color: tab===t ? "#000" : "#444", border:`1px solid ${tab===t?(t==="list"?"#00e676":"#fff"):"#1e1e1e"}`, borderRadius:8, padding:"7px 14px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", letterSpacing:1, textTransform:"uppercase" }}>
              {t==="list" ? `LIST ${savedItems.length>0?`(${savedItems.length})`:""}` : "SCAN"}
            </button>
          ))}
        </div>
      </div>

      {/* API KEY DRAWER */}
      {showKeyInput && (
        <div style={{ background:"#0d0d0d", borderBottom:"1px solid #1a1a1a", padding:"12px 16px" }}>
          <div style={{ color:"#444", fontSize:10, letterSpacing:1, marginBottom:6 }}>ANTHROPIC API KEY (saved to your browser)</div>
          <input
            type="password" placeholder="sk-ant-..." value={apiKey}
            onChange={e => { setApiKey(e.target.value); localStorage.setItem("ws_key", e.target.value); }}
            style={{ width:"100%", background:"#111", border:"1px solid #222", borderRadius:8, color:"#e0e0e0", fontSize:13, padding:"10px 12px", fontFamily:"inherit", outline:"none" }}
          />
          <div style={{ color:"#2a2a2a", fontSize:10, marginTop:6 }}>Get yours at console.anthropic.com → API Keys</div>
        </div>
      )}

      {/* ═══════════════════════════════ SCAN TAB ═══════════════════════════════ */}
      {tab === "scan" && (
        <div style={{ padding:"16px" }}>

          {/* PHOTO SECTION */}
          <div style={{ marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontSize:10, color:"#444", letterSpacing:2, textTransform:"uppercase" }}>
                Photos {images.length > 0 && <span style={{ color:"#00e676" }}>({images.length}/10)</span>}
              </div>
              {images.length > 0 && (
                <button onClick={() => fileRef.current?.click()} style={{ background:"transparent", border:"1px solid #1e1e1e", color:"#555", borderRadius:6, padding:"4px 10px", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>+ Add more</button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={e => handleFiles(e.target.files)} capture="environment" />

            {images.length === 0 ? (
              /* Big drop zone */
              <div
                onDragOver={e=>e.preventDefault()} onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                style={{ border:"2px dashed #1e1e1e", borderRadius:14, padding:"40px 20px", textAlign:"center", cursor:"pointer", background:"#0a0a0a" }}
              >
                <div style={{ fontSize:36, marginBottom:10 }}>📸</div>
                <div style={{ color:"#444", fontSize:14, fontWeight:500, marginBottom:4 }}>Add photos of the item</div>
                <div style={{ color:"#2a2a2a", fontSize:11 }}>Tap to open camera or gallery</div>
                <div style={{ color:"#222", fontSize:11, marginTop:2 }}>Add all angles before hitting search</div>
              </div>
            ) : (
              /* Photo grid */
              <div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:6, marginBottom:8 }}>
                  {images.map((img, i) => (
                    <div key={i} style={{ position:"relative", aspectRatio:"1", borderRadius:8, overflow:"hidden", border:"1px solid #1e1e1e" }}>
                      <img src={img.url} style={{ width:"100%", height:"100%", objectFit:"cover" }} alt="" />
                      <button onClick={() => removeImage(i)} style={{ position:"absolute", top:2, right:2, background:"#000000cc", border:"none", color:"#fff", borderRadius:"50%", width:18, height:18, fontSize:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", padding:0 }}>✕</button>
                    </div>
                  ))}
                  {images.length < 10 && (
                    <div onClick={() => fileRef.current?.click()} style={{ aspectRatio:"1", borderRadius:8, border:"1px dashed #1e1e1e", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#2a2a2a", fontSize:20 }}>+</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* NOTES */}
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, color:"#444", letterSpacing:2, marginBottom:6, textTransform:"uppercase" }}>Your Notes (optional but helps accuracy)</div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={"What you see that camera might miss:\n• \"No tags, slight fading on knees\"\n• \"Size 8.5, box included\"\n• \"Coach serial number visible\"\n• \"Minor pilling on sleeves\""}
              rows={4}
              style={{ width:"100%", background:"#0d0d0d", border:"1px solid #1e1e1e", borderRadius:10, color:"#ccc", fontSize:12, padding:"12px 14px", fontFamily:"inherit", outline:"none", lineHeight:1.6 }}
            />
          </div>

          {/* SEARCH BUTTON */}
          <button
            onClick={analyze}
            disabled={loading || images.length === 0}
            style={{ width:"100%", padding:"17px", background: images.length===0 ? "#0d0d0d" : loading ? "#0d0d0d" : "linear-gradient(135deg,#00c853,#00b0ff)", border:`1px solid ${images.length===0?"#1a1a1a":"transparent"}`, borderRadius:12, color: (loading||images.length===0) ? "#333" : "#000", fontSize:16, fontWeight:700, letterSpacing:3, cursor:(loading||images.length===0)?"not-allowed":"pointer", fontFamily:"'Bebas Neue',sans-serif", transition:"all .2s", display:"flex", alignItems:"center", justifyContent:"center", gap:10, marginBottom:16 }}
          >
            {loading ? (
              <>
                <div className="spin" style={{ width:18, height:18, border:"2px solid #333", borderTop:"2px solid #00e676", borderRadius:"50%" }} />
                RESEARCHING COMPS...
              </>
            ) : images.length === 0 ? "ADD PHOTOS FIRST" : "⚡ RESEARCH THIS ITEM"}
          </button>

          {error && (
            <div style={{ background:"#110808", border:"1px solid #ff174430", borderRadius:10, padding:"12px 14px", color:"#ff6b6b", fontSize:12, marginBottom:16, whiteSpace:"pre-wrap", lineHeight:1.5 }}>{error}</div>
          )}

          {/* ═══ RESULT ═══ */}
          {res && dc && (
            <div className="fade" style={{ border:`1px solid ${dc.color}30`, borderRadius:14, overflow:"hidden", boxShadow:`0 0 30px ${dc.glow}` }}>

              {/* Decision */}
              <div style={{ background:`linear-gradient(135deg,${dc.color}18,${dc.color}08)`, borderBottom:`1px solid ${dc.color}25`, padding:"16px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                  <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:42, color:dc.color, letterSpacing:4, lineHeight:1 }}>{dc.label}</div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:9, color:"#333", letterSpacing:1, marginBottom:4 }}>DEMAND</div>
                    <div style={{ fontSize:28, fontWeight:700, color: res.demandScore>=7?"#00e676":res.demandScore>=5?"#ffc400":"#ff1744", lineHeight:1 }}>{res.demandScore}<span style={{ fontSize:13, color:"#333" }}>/10</span></div>
                  </div>
                </div>
                <div style={{ color:"#ccc", fontSize:14, fontWeight:500, marginBottom:4 }}>{res.itemName}</div>
                <div style={{ color:"#555", fontSize:12, marginBottom:8, fontStyle:"italic" }}>{res.decisionReason}</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  <Pill color={SPEED_COLOR(res.howFastItSells)} border={SPEED_COLOR(res.howFastItSells)+"44"} bg={SPEED_COLOR(res.howFastItSells)+"10"}>⏱ {res.howFastItSells}</Pill>
                  <Pill color="#888">{res.condition}</Pill>
                  {res.size && res.size !== "N/A" && <Pill color="#888">Size {res.size}</Pill>}
                </div>
              </div>

              <div style={{ padding:16, display:"flex", flexDirection:"column", gap:14 }}>

                {/* PRICE GRID */}
                <div>
                  <div style={{ fontSize:9, color:"#333", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>eBay Sold Comps — <span style={{ color:CC[res.ebayComps?.confidence]||"#888" }}>{res.ebayComps?.confidence}</span> {res.ebayComps?.recentSalesCount > 0 && <span style={{ color:"#333" }}>({res.ebayComps.recentSalesCount} sales)</span>}</div>
                  <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                    <PriceCard label="LOW" value={`$${res.ebayComps?.low||0}`} color="#888" />
                    <PriceCard label="AVG SOLD" value={`$${res.ebayComps?.avg||0}`} color="#fff" sub="Your pricing anchor" />
                    <PriceCard label="HIGH" value={`$${res.ebayComps?.high||0}`} color="#888" />
                  </div>
                  {res.ebayComps?.confidenceReason && (
                    <div style={{ color:"#333", fontSize:10, fontStyle:"italic", marginBottom:8 }}>{res.ebayComps.confidenceReason}</div>
                  )}
                </div>

                {/* YOUR PRICES */}
                <div>
                  <div style={{ fontSize:9, color:"#333", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>Your Selling Prices</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <PriceCard label="eBay Fast Sell" value={`$${res.priceBreakdown?.ebayFastSell||0}`} color="#00e676" sub="Sells in ~7 days" />
                    <PriceCard label="eBay Max List" value={`$${res.priceBreakdown?.ebayMaxList||0}`} color="#7dd3fc" sub="Optimistic price" />
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:8 }}>
                    <PriceCard label="🟣 Start Bid" value={`$${res.priceBreakdown?.whatnotStartingBid||0}`} color="#a78bfa" sub="Creates bidding war" />
                    <PriceCard label="🟣 Est. Sell" value={`$${res.priceBreakdown?.whatnotEstimatedSell||0}`} color="#c4b5fd" sub="Expected Whatnot sale" />
                  </div>
                </div>

                {/* WHATNOT HOOK */}
                <div style={{ background:"#0d0a1a", border:"1px solid #a78bfa25", borderRadius:10, padding:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                    <span style={{ fontSize:9, color:"#a78bfa", letterSpacing:2, textTransform:"uppercase" }}>🎤 Live Hook</span>
                    <CopyBtn text={res.whatnotHook} />
                  </div>
                  <div style={{ color:"#c4b5fd", fontSize:13, lineHeight:1.6, fontStyle:"italic" }}>"{res.whatnotHook}"</div>
                </div>

                {/* SEO TITLE */}
                <div style={{ background:"#0d0d0d", border:"1px solid #1e1e1e", borderRadius:10, padding:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                    <span style={{ fontSize:9, color:"#444", letterSpacing:2, textTransform:"uppercase" }}>SEO Title</span>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      <span style={{ color:"#2a2a2a", fontSize:10 }}>{res.seoTitle?.length}/80</span>
                      <CopyBtn text={res.seoTitle} />
                    </div>
                  </div>
                  <div style={{ color:"#e0e0e0", fontSize:13 }}>{res.seoTitle}</div>
                </div>

                {/* KEYWORDS */}
                <div>
                  <div style={{ fontSize:9, color:"#333", letterSpacing:2, marginBottom:8, textTransform:"uppercase" }}>Keywords</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                    {(res.keywords||[]).map((k,i) => <Pill key={i} color="#555">{k}</Pill>)}
                  </div>
                </div>

                {/* SELLER TIP */}
                {res.sellerTip && (
                  <div style={{ background:"#0a100d", border:"1px solid #00e67620", borderRadius:10, padding:14 }}>
                    <div style={{ fontSize:9, color:"#00e676", letterSpacing:2, marginBottom:6, textTransform:"uppercase" }}>💡 Seller Tip</div>
                    <div style={{ color:"#7dd3fc", fontSize:12, lineHeight:1.6 }}>{res.sellerTip}</div>
                  </div>
                )}

                {/* RISK FLAGS */}
                {res.riskFlags?.filter(Boolean).length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                    {res.riskFlags.map((f,i) => <Pill key={i} color="#ff9800" border="#ff980030" bg="#0f0800">⚠ {f}</Pill>)}
                  </div>
                )}

                {/* CONDITION NOTES */}
                {res.conditionNotes && (
                  <div style={{ color:"#444", fontSize:11, fontStyle:"italic", lineHeight:1.5 }}>Noted: {res.conditionNotes}</div>
                )}

                {/* ACTIONS */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, paddingTop:4 }}>
                  <button onClick={skipItem} style={{ padding:"15px", background:"transparent", border:"1px solid #1e1e1e", borderRadius:10, color:"#444", fontSize:13, cursor:"pointer", fontFamily:"inherit", letterSpacing:1 }}>
                    SKIP
                  </button>
                  <button onClick={addToList} style={{ padding:"15px", background:"#00e676", border:"none", borderRadius:10, color:"#000", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"'Bebas Neue',sans-serif", letterSpacing:2, boxShadow:"0 4px 20px #00e67640" }}>
                    ✓ ADD TO LIST
                  </button>
                </div>

              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════ LIST TAB ═══════════════════════════════ */}
      {tab === "list" && (
        <div style={{ padding:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:22, letterSpacing:2 }}>YOUR HAUL</div>
              <div style={{ color:"#333", fontSize:10 }}>{savedItems.length} item{savedItems.length!==1?"s":""} saved</div>
            </div>
            {savedItems.length > 0 && (
              <button onClick={downloadCSV} style={{ background:"#00e676", border:"none", borderRadius:10, color:"#000", padding:"10px 18px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Bebas Neue',sans-serif", letterSpacing:2 }}>
                ⬇ CSV
              </button>
            )}
          </div>

          {savedItems.length === 0 ? (
            <div style={{ textAlign:"center", padding:"60px 0", color:"#222" }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📭</div>
              <div style={{ fontSize:13, marginBottom:4 }}>Nothing saved yet</div>
              <div style={{ fontSize:11 }}>Scan items → Add to List</div>
              <button onClick={() => setTab("scan")} style={{ marginTop:16, background:"transparent", border:"1px solid #1e1e1e", color:"#444", borderRadius:8, padding:"10px 20px", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Go scan items</button>
            </div>
          ) : (
            <>
              {/* Summary bar */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:16 }}>
                {[
                  { label:"ITEMS", val:savedItems.length, color:"#fff" },
                  { label:"BUY", val:savedItems.filter(i=>i.decision==="BUY").length, color:"#00e676" },
                  { label:"AVG PRICE", val:`$${Math.round(savedItems.reduce((s,i)=>s+(i.ebayComps?.avg||0),0)/(savedItems.length||1))}`, color:"#a78bfa" },
                ].map(({label,val,color}) => (
                  <div key={label} style={{ background:"#0d0d0d", border:"1px solid #1a1a1a", borderRadius:10, padding:"12px", textAlign:"center" }}>
                    <div style={{ color:"#2a2a2a", fontSize:9, letterSpacing:1, marginBottom:4 }}>{label}</div>
                    <div style={{ color, fontFamily:"'Bebas Neue',sans-serif", fontSize:24, letterSpacing:1 }}>{val}</div>
                  </div>
                ))}
              </div>

              {/* Items */}
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {savedItems.map((item) => {
                  const d = DC[item.decision] || DC.MAYBE;
                  return (
                    <div key={item._id} className="fade" style={{ background:"#0a0a0a", border:`1px solid ${d.color}20`, borderRadius:12, padding:12, display:"flex", gap:12, alignItems:"center" }}>
                      {/* thumb */}
                      {item._imgs?.[0] && <img src={item._imgs[0]} style={{ width:52, height:52, objectFit:"cover", borderRadius:8, border:"1px solid #1e1e1e", flexShrink:0 }} alt="" />}
                      {/* info */}
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ color:"#e0e0e0", fontSize:12, fontWeight:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{item.itemName}</div>
                        <div style={{ color:"#444", fontSize:10, marginTop:2 }}>{item.condition} · {item.category}</div>
                        <div style={{ display:"flex", gap:8, marginTop:4, alignItems:"center" }}>
                          <span style={{ color:"#fff", fontSize:13, fontWeight:700 }}>${item.ebayComps?.avg||0}</span>
                          <span style={{ color:"#444", fontSize:10 }}>avg</span>
                          <span style={{ color:"#a78bfa", fontSize:12 }}>bid ${item.priceBreakdown?.whatnotStartingBid||0}</span>
                        </div>
                      </div>
                      {/* decision + remove */}
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:8, flexShrink:0 }}>
                        <span style={{ color:d.color, fontFamily:"'Bebas Neue',sans-serif", fontSize:16, letterSpacing:1 }}>{item.decision}</span>
                        <button onClick={() => removeItem(item._id)} style={{ background:"transparent", border:"1px solid #1a1a1a", color:"#2a2a2a", borderRadius:5, padding:"2px 8px", fontSize:10, cursor:"pointer", fontFamily:"inherit" }}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Download bottom */}
              <button onClick={downloadCSV} style={{ width:"100%", marginTop:16, padding:"16px", background:"#00e676", border:"none", borderRadius:12, color:"#000", fontSize:16, fontWeight:700, cursor:"pointer", fontFamily:"'Bebas Neue',sans-serif", letterSpacing:3, boxShadow:"0 4px 24px #00e67630" }}>
                ⬇ DOWNLOAD CSV ({savedItems.length} ITEMS)
              </button>
              <button onClick={() => saveItems([])} style={{ width:"100%", marginTop:8, padding:"12px", background:"transparent", border:"1px solid #1a1a1a", borderRadius:10, color:"#2a2a2a", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>Clear all items</button>
            </>
          )}
        </div>
      )}

      {/* bottom padding for mobile */}
      <div style={{ height:40 }} />
    </div>
  );
}
