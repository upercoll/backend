import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Package, LogOut, ShoppingBag, DollarSign, TrendingUp, Loader2, Video } from "lucide-react";

const BASE = import.meta.env.VITE_API_URL || "";

async function apiGet(path: string, token: string) {
  const res = await fetch(`${BASE}/api/collab${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

function fmt(date: string | null) {
  if (!date) return "-";
  return new Date(date).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CollabDashboard() {
  const [, navigate] = useLocation();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("collab_token");
    if (!token) { navigate("/collab/login"); return; }
    apiGet("/me", token)
      .then(res => setData(res.data))
      .catch(err => {
        if (err.message.includes("401") || err.message.toLowerCase().includes("invalid")) {
          localStorage.removeItem("collab_token");
          navigate("/collab/login");
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("collab_token");
    navigate("/collab/login");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, #060a1a 0%, #0c1445 45%, #060a1a 100%)" }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "#a78bfa" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, #060a1a 0%, #0c1445 45%, #060a1a 100%)" }}>
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  const collab = data?.collaborator;
  const products: any[] = data?.products || [];
  const sales: any[] = data?.sales || [];
  const unpaidEarnings: number = data?.unpaidEarnings || 0;
  const totalEarnings: number = data?.totalEarnings || 0;

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(135deg, #060a1a 0%, #0c1445 45%, #060a1a 100%)" }}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[20%] w-[600px] h-[600px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(99,102,241,0.07) 0%, transparent 70%)" }} />
        <div className="absolute bottom-[-10%] right-[10%] w-[500px] h-[500px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(139,92,246,0.06) 0%, transparent 70%)" }} />
      </div>

      <div className="relative z-10">
        <header className="flex items-center justify-between px-6 h-16 flex-shrink-0"
          style={{ background: "rgba(6, 9, 28, 0.82)", backdropFilter: "blur(24px)", borderBottom: "1px solid rgba(139,92,246,0.12)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "linear-gradient(135deg,#7c3aed,#6d28d9)", boxShadow: "0 0 16px rgba(124,58,237,0.35)" }}>
              <span className="text-white font-bold text-sm">R</span>
            </div>
            <div>
              <span className="text-white font-bold text-sm tracking-tight">RBstars</span>
              <p className="text-[10px] tracking-widest uppercase" style={{ color: "rgba(167,139,250,0.7)" }}>Collaborator Portal</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Nav tabs */}
            <div className="flex items-center gap-1">
              {[
                { label: "Products", href: "/collab/dashboard" },
                { label: "Socials", href: "/collab/socials" },
              ].map(({ label, href }) => {
                const active = href === "/collab/dashboard";
                return (
                  <a key={label} href={href}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={active
                      ? { background: "rgba(99,102,241,0.25)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)" }
                      : { color: "rgba(255,255,255,0.4)", border: "1px solid transparent" }}>
                    {label}
                  </a>
                );
              })}
            </div>
            <div className="text-right">
              <p className="text-white text-xs font-semibold">{collab?.name}</p>
              <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>{collab?.email}</p>
            </div>
            <button onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
              style={{ color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)" }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "#f87171"; (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.08)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.4)"; (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
              <LogOut className="w-3.5 h-3.5" /> Log out
            </button>
          </div>
        </header>

        <main className="p-6 max-w-[1100px] mx-auto space-y-6">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <h1 className="text-xl font-bold text-white mb-1">Welcome back, {collab?.name?.split(" ")[0]}!</h1>
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>Here's an overview of your assigned products and sales.</p>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: 0.05 }}
            className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: "Assigned Products", value: products.length, icon: Package, color: "#a78bfa" },
              { label: "Paid Orders", value: sales.length, icon: ShoppingBag, color: "#60a5fa", sub: "from paid customers only" },
              { label: "Pending Commission", value: `$${unpaidEarnings.toFixed(2)}`, icon: DollarSign, color: "#4ade80", sub: "owed to you, not yet paid out" },
            ].map((stat, i) => (
              <div key={i} className="rounded-2xl p-5"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                    style={{ background: `${stat.color}20`, border: `1px solid ${stat.color}30` }}>
                    <stat.icon className="w-4 h-4" style={{ color: stat.color }} />
                  </div>
                  <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.4)" }}>{stat.label}</p>
                </div>
                <p className="text-2xl font-bold text-white">{stat.value}</p>
                {stat.sub && <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.3)" }}>{stat.sub}</p>}
              </div>
            ))}
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: 0.1 }}
            className="rounded-2xl overflow-hidden"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-bold text-white text-sm">Assigned Products ({products.length})</h2>
            </div>
            {products.length === 0 ? (
              <div className="p-12 text-center">
                <Package className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: "#a78bfa" }} />
                <p className="text-sm" style={{ color: "rgba(255,255,255,0.3)" }}>No products assigned yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Product</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Game</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((cp: any) => (
                      <tr key={cp._id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg flex-shrink-0 overflow-hidden"
                              style={{ background: cp.product?.gradient ? `linear-gradient(135deg, ${cp.product.gradient.from}, ${cp.product.gradient.to})` : "#6366f1" }}>
                              {cp.product?.imageUrl
                                ? <img src={cp.product.imageUrl} className="w-full h-full object-cover" alt="" />
                                : <div className="w-full h-full flex items-center justify-center"><Package className="w-3.5 h-3.5 text-white/60" /></div>}
                            </div>
                            <span className="text-sm font-semibold text-white">{cp.productName || cp.product?.name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <span className="text-xs px-2 py-1 rounded-md font-medium" style={{ background: "rgba(99,102,241,0.15)", color: "#a5b4fc" }}>{cp.product?.game || "-"}</span>
                        </td>
                        <td className="px-5 py-3.5 text-sm text-white/70">${cp.product?.price?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: 0.15 }}
            className="rounded-2xl overflow-hidden"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-bold text-white text-sm">Sales Log ({sales.length})</h2>
              <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.3)" }}>
                All entries below are from paid customer orders. "Commission" shows whether your cut has been paid to you yet.
              </p>
            </div>
            {sales.length === 0 ? (
              <div className="p-12 text-center">
                <ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: "#60a5fa" }} />
                <p className="text-sm" style={{ color: "rgba(255,255,255,0.3)" }}>No sales yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Date</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Order</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Product</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Qty</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Sale Price</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(255,255,255,0.3)" }}>Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((s: any, i: number) => (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>
                        <td className="px-5 py-3.5 text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>{fmt(s.orderDate)}</td>
                        <td className="px-5 py-3.5 text-sm font-medium" style={{ color: "#a5b4fc" }}>#{s.orderNumber?.replace("RB-", "")}</td>
                        <td className="px-5 py-3.5 text-sm text-white/80">{s.productName}</td>
                        <td className="px-5 py-3.5 text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>{s.quantity}</td>
                        <td className="px-5 py-3.5 text-sm font-semibold text-white">${(s.salePrice ?? s.unitPrice * s.quantity).toFixed(2)}</td>
                        <td className="px-5 py-3.5">
                          <span className="text-xs px-2 py-1 rounded-full font-semibold"
                            style={s.isPaid
                              ? { background: "rgba(74,222,128,0.15)", color: "#4ade80" }
                              : { background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>
                            {s.isPaid ? "Paid to You" : "Owed to You"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
